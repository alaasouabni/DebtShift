import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { ConfigService } from '@nestjs/config';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { debtShiftSchema, type DebtShiftDatabase } from '@debtshift/database';

import {
  AuthenticationService,
  readSessionCookie,
  SESSION_COOKIE_NAME,
} from './authentication.service.js';
import type { DatabaseService } from './database.service.js';

const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/database/migrations/', import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

describe('wallet authentication service', () => {
  const postgres = new PGlite();
  const database = createPgliteDrizzle(postgres, {
    schema: debtShiftSchema,
  }) as unknown as DebtShiftDatabase;
  const service = new AuthenticationService(
    { db: database } as DatabaseService,
    new ConfigService({
      SOURCE_CHAIN_ID: 31_337,
      SOURCE_RPC_URL: 'http://127.0.0.1:1',
      WEB_PUBLIC_URL: 'https://debtshift.test',
      API_PUBLIC_URL: 'https://api.debtshift.test',
    }),
  );

  beforeAll(async () => {
    for (const migrationFile of migrationFiles) {
      await postgres.exec(readFileSync(`${migrationsDirectory}/${migrationFile}`, 'utf8'));
    }
  });

  afterAll(async () => {
    await postgres.close();
  });

  it('creates one-time SIWE challenges and opaque hashed sessions', async () => {
    const challenge = await service.createChallenge({ wallet: account.address });
    expect(challenge).toMatchObject({ wallet: account.address, chainId: 31_337 });
    expect(challenge.message).toContain('does not authorize a refinance or transaction');
    const signature = await account.signMessage({ message: challenge.message });
    const verified = await service.verifyChallenge({
      challengeId: challenge.challengeId,
      signature,
    });
    expect(verified.cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(verified.cookie).toContain('HttpOnly');
    expect(verified.cookie).toContain('SameSite=Strict');
    expect(verified.cookie).toContain('Secure');

    const cookie = verified.cookie.split(';', 1)[0];
    const rawToken = readSessionCookie(cookie);
    expect(rawToken).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    const stored = await postgres.query<{ session_hash: string }>(
      'SELECT session_hash FROM wallet_sessions',
    );
    expect(stored.rows[0]?.session_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stored.rows[0]?.session_hash).not.toContain(rawToken);

    await expect(service.authenticate(cookie)).resolves.toMatchObject({
      walletAddress: account.address,
      chainId: 31_337,
    });
    await expect(
      service.verifyChallenge({ challengeId: challenge.challengeId, signature }),
    ).rejects.toThrow('invalid or expired');

    await service.revoke(verified.session.sessionHash);
    await expect(service.authenticate(cookie)).rejects.toThrow('invalid or expired');
  });

  it('ignores malformed and ambiguously named cookie values', () => {
    expect(readSessionCookie(undefined)).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=short`)).toBeUndefined();
    expect(readSessionCookie(`other=${'a'.repeat(43)}`)).toBeUndefined();
  });

  it('rejects malformed challenge requests without exposing persistence details', async () => {
    await expect(service.createChallenge({ wallet: '0xBAD' })).rejects.toThrow(
      'Wallet must be a valid checksummed or lowercase EVM address.',
    );
    await expect(service.createChallenge({ wallet: account.address, extra: true })).rejects.toThrow(
      'Wallet must be a valid checksummed or lowercase EVM address.',
    );
  });

  it('rejects a signed challenge whose stored SIWE bindings were altered', async () => {
    const challenge = await service.createChallenge({ wallet: account.address });
    const alteredMessage = challenge.message.replace('Chain ID: 31337', 'Chain ID: 1');
    expect(alteredMessage).not.toBe(challenge.message);
    await postgres.query('UPDATE wallet_auth_challenges SET message = $1 WHERE challenge_id = $2', [
      alteredMessage,
      challenge.challengeId,
    ]);
    const signature = await account.signMessage({ message: alteredMessage });

    await expect(
      service.verifyChallenge({ challengeId: challenge.challengeId, signature }),
    ).rejects.toThrow('Wallet authentication signature is invalid.');
  });
});

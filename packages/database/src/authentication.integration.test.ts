import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  consumeWalletAuthChallenge,
  getWalletAuthChallenge,
  revokeWalletSession,
  storeWalletAuthChallenge,
  touchActiveWalletSession,
} from './authentication.js';
import type { DebtShiftDatabase } from './client.js';
import * as schema from './schema.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const CHALLENGE_ID = '55f0a68f-6280-4f4e-aa1f-79ee1ed9ff3d';
const WALLET = '0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa';
const SESSION_HASH = `0x${'ab'.repeat(32)}`;

describe('wallet authentication persistence', () => {
  const postgres = new PGlite();
  const database = createPgliteDrizzle(postgres, { schema }) as unknown as DebtShiftDatabase;

  beforeAll(async () => {
    for (const migrationFile of migrationFiles) {
      await postgres.exec(readFileSync(`${migrationsDirectory}/${migrationFile}`, 'utf8'));
    }
  }, 15_000);

  afterAll(async () => {
    await postgres.close();
  });

  it('consumes a challenge once and stores only the session hash', async () => {
    const now = new Date('2026-11-13T06:00:00.000Z');
    await storeWalletAuthChallenge(database, {
      challengeId: CHALLENGE_ID,
      walletAddress: WALLET,
      chainId: '31337',
      nonce: 'a1b2c3d4e5f60708',
      message: 'DebtShift authentication test message',
      expiresAt: new Date(now.getTime() + 300_000),
    });
    expect((await getWalletAuthChallenge(database, CHALLENGE_ID))?.consumedAt).toBeNull();

    const session = await consumeWalletAuthChallenge(database, {
      challengeId: CHALLENGE_ID,
      sessionHash: SESSION_HASH,
      walletAddress: WALLET,
      chainId: '31337',
      expiresAt: new Date(now.getTime() + 28_800_000),
      now,
    });
    expect(session).toMatchObject({
      sessionHash: SESSION_HASH,
      walletAddress: WALLET,
      chainId: '31337',
      revokedAt: null,
    });
    await expect(
      consumeWalletAuthChallenge(database, {
        challengeId: CHALLENGE_ID,
        sessionHash: `0x${'cd'.repeat(32)}`,
        walletAddress: WALLET,
        chainId: '31337',
        expiresAt: new Date(now.getTime() + 28_800_000),
        now,
      }),
    ).rejects.toThrow('already used');

    const active = await touchActiveWalletSession(
      database,
      SESSION_HASH,
      new Date(now.getTime() + 1_000),
    );
    expect(active?.walletAddress).toBe(WALLET);
    await expect(
      revokeWalletSession(database, SESSION_HASH, new Date(now.getTime() + 2_000)),
    ).resolves.toBe(true);
    await expect(
      touchActiveWalletSession(database, SESSION_HASH, new Date(now.getTime() + 3_000)),
    ).resolves.toBeUndefined();
  });
});

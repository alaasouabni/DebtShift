import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { evidenceSchema } from '@debtshift/domain';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DebtShiftDatabase } from './client.js';
import { beginCommand, completeCommand, recoverStaleCommands } from './command-lifecycle.js';
import * as schema from './schema.js';
import {
  advanceMigrationWithEvidence,
  enqueueCommand,
  planNextCommand,
  publishPendingOutbox,
} from './workflow.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const hash = (digit: string) => `0x${digit.repeat(64)}`;

describe('durable workflow and transactional outbox', () => {
  const postgres = new PGlite();
  const database = createPgliteDrizzle(postgres, { schema }) as unknown as DebtShiftDatabase;

  beforeAll(async () => {
    if (migrationFiles.length === 0) throw new Error('Migration SQL is missing.');
    for (const migrationFile of migrationFiles) {
      await postgres.exec(readFileSync(`${migrationsDirectory}/${migrationFile}`, 'utf8'));
    }
    await postgres.exec(`
      INSERT INTO wallets (wallet_id, chain_id, address, account_type)
      VALUES ('00000000-0000-0000-0000-000000000001', 31337,
        '0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa', 'EOA');
      INSERT INTO intents (intent_hash, wallet_id, nonce, expiration, payload, signature)
      VALUES ('${hash('1')}', '00000000-0000-0000-0000-000000000001', 1,
        2000000000, '{}', '0x00');
      INSERT INTO execution_plans (
        plan_hash, migration_id, intent_hash, nonce, deadline, route_hash, payload, signature
      ) VALUES ('${hash('2')}', '${hash('5')}', '${hash('1')}', 2, 1999999999,
        '${hash('6')}', '{}', '0x00');
      INSERT INTO provider_quotes (
        quote_hash, quote_id, provider, mode, amount_in_units,
        expected_amount_out_units, minimum_amount_out_units, payload,
        raw_response_hash, expires_at
      ) VALUES ('${hash('3')}', 'workflow-quote', 'DEBTSHIFT_SIMULATOR', 'SIMULATED',
        100, 99, 98, '{}', '${hash('4')}', now() + interval '1 hour');
      INSERT INTO migrations (
        migration_id, intent_hash, plan_hash, quote_hash, phase, expires_at
      ) VALUES ('${hash('5')}', '${hash('1')}', '${hash('2')}', '${hash('3')}',
        'AUTHORIZED', now() + interval '1 hour');
      INSERT INTO liquidity_reservations (
        reservation_id, migration_id, reservation_hash, provider, chain_id, asset,
        principal_units, fee_cap_units, status, expires_at
      ) VALUES ('${hash('4')}', '${hash('5')}', '${hash('6')}',
        '0x8000000000000000000000000000000000000008', 31337,
        '0x3000000000000000000000000000000000000003', 100, 5, 'PENDING',
        now() + interval '1 hour');
      INSERT INTO evidence (
        evidence_id, migration_id, type, schema_version, provider, network,
        raw_observation_hash, normalized_payload, observed_at, verification_state,
        verification_method, verifier_version
      ) VALUES
        ('${hash('7')}', '${hash('5')}', 'SOURCE_POSITION_SNAPSHOT', 1, 'LOCAL_TEST',
          'anvil:31337', '${hash('8')}', '{}', now(), 'FINALIZED', 'TEST', '1'),
        ('${hash('9')}', '${hash('5')}', 'ROUTE_QUOTE', 1, 'DEBTSHIFT_SIMULATOR',
          'simulator', '${hash('a')}', '{}', now(), 'FINALIZED', 'TEST', '1'),
        ('${hash('b')}', '${hash('5')}', 'INTENT_AUTHORIZATION', 1, 'WALLET',
          'eip712:31337', '${hash('c')}', '{}', now(), 'FINALIZED', 'TEST', '1'),
        ('${hash('d')}', '${hash('5')}', 'EXECUTION_PLAN_AUTHORIZATION', 1, 'WALLET',
          'eip712:31337', '${hash('e')}', '{}', now(), 'FINALIZED', 'TEST', '1'),
        ('${hash('f')}', '${hash('5')}', 'FINANCING_FEASIBILITY', 1,
          'DETERMINISTIC_ENGINE_V1', 'eip155:31337', '${hash('0')}', '{}', now(),
          'FINALIZED', 'TEST', '1');
    `);
  });

  afterAll(async () => {
    await postgres.close();
  });

  it('enqueues one logical command and publishes it with retry state', async () => {
    const migrationId = hash('5');
    const planned = planNextCommand(migrationId, 'AUTHORIZED');
    if (planned === undefined) throw new Error('Expected reserve command.');
    await enqueueCommand(database, migrationId, planned);
    await enqueueCommand(database, migrationId, planned);

    expect(
      Number(
        (await postgres.query<{ count: string | number }>('SELECT count(*) FROM commands')).rows[0]
          ?.count,
      ),
    ).toBe(1);
    expect(
      Number(
        (await postgres.query<{ count: string | number }>('SELECT count(*) FROM outbox_messages'))
          .rows[0]?.count,
      ),
    ).toBe(1);

    const availability = await postgres.query<{ available_at: Date | string }>(
      'SELECT available_at FROM outbox_messages',
    );
    const availableAt = availability.rows[0]?.available_at;
    if (availableAt === undefined) throw new Error('Outbox availability is missing.');
    const firstAttempt = new Date(new Date(availableAt).getTime() + 1_000);
    await publishPendingOutbox(
      database,
      async () => {
        throw new Error('queue unavailable');
      },
      1,
      firstAttempt,
    );
    const failed = await postgres.query<{ status: string; publish_attempts: number }>(
      'SELECT status, publish_attempts FROM outbox_messages',
    );
    expect(failed.rows[0]).toEqual({ status: 'FAILED_RETRYABLE', publish_attempts: 1 });

    const publishedIds: string[] = [];
    await publishPendingOutbox(
      database,
      async (message) => {
        publishedIds.push(message.commandId);
      },
      1,
      new Date(firstAttempt.getTime() + 60_000),
    );
    expect(publishedIds).toHaveLength(1);
    const published = await postgres.query<{ status: string }>(
      'SELECT status FROM outbox_messages',
    );
    expect(published.rows[0]?.status).toBe('PUBLISHED');
  });

  it('advances from finalized evidence and enqueues the next command exactly once', async () => {
    const record = evidenceSchema.parse({
      evidenceId: hash('0'),
      migrationId: hash('5'),
      type: 'LIQUIDITY_RESERVATION',
      schemaVersion: 1,
      provider: 'LOCAL_TEST_VAULT',
      network: 'anvil:31337',
      rawObservationHash: hash('0'),
      normalizedPayload: { principalUnits: '100' },
      observedAt: '2026-11-09T01:01:00.000Z',
      verificationState: 'FINALIZED',
      verificationMethod: 'CONTRACT_STATE',
      verifierVersion: '1',
    });
    await expect(advanceMigrationWithEvidence(database, record, 'worker')).resolves.toBe(
      'RESERVED',
    );
    await expect(advanceMigrationWithEvidence(database, record, 'worker')).resolves.toBe(
      'RESERVED',
    );

    const migration = await postgres.query<{ phase: string; version: number }>(
      `SELECT phase, version FROM migrations WHERE migration_id = '${hash('5')}'`,
    );
    expect(migration.rows[0]).toEqual({ phase: 'RESERVED', version: 1 });
    const reservation = await postgres.query<{ status: string }>(
      `SELECT status FROM liquidity_reservations WHERE migration_id = '${hash('5')}'`,
    );
    expect(reservation.rows[0]?.status).toBe('ACTIVE');
    const commandCount = await postgres.query<{ count: string | number }>(
      'SELECT count(*) FROM commands',
    );
    expect(Number(commandCount.rows[0]?.count)).toBe(2);
    const eventCount = await postgres.query<{ count: string | number }>(
      'SELECT count(*) FROM audit_events',
    );
    expect(Number(eventCount.rows[0]?.count)).toBe(1);
  });

  it('recovers a stale running command and keeps completion idempotent', async () => {
    const result = await postgres.query<{ command_id: string }>(
      `SELECT command_id FROM commands WHERE type = 'RESERVE_LIQUIDITY'`,
    );
    const commandId = result.rows[0]?.command_id;
    if (commandId === undefined) throw new Error('Reserve command is missing.');
    const oldStart = new Date('2026-11-09T00:00:00.000Z');

    const running = await beginCommand(database, commandId, oldStart);
    expect(running?.logicalAttempt).toBe(1);
    await expect(beginCommand(database, commandId, oldStart)).resolves.toBeUndefined();
    await expect(
      recoverStaleCommands(
        database,
        new Date('2026-11-09T00:10:00.000Z'),
        new Date('2026-11-09T00:11:00.000Z'),
      ),
    ).resolves.toBe(1);

    const retried = await beginCommand(database, commandId);
    expect(retried?.logicalAttempt).toBe(2);
    await completeCommand(database, commandId);
    await expect(beginCommand(database, commandId)).resolves.toBeUndefined();
  });
});

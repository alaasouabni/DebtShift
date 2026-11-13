import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DebtShiftDatabase } from './client.js';
import { scanOperationalAlerts } from './operational-alerts.js';
import * as schema from './schema.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const pairHash = (pair: string) => `0x${pair.repeat(32)}`;
const NOW = new Date('2026-11-13T03:00:00.000Z');

describe('durable operational alert scan', () => {
  const postgres = new PGlite();
  const database = createPgliteDrizzle(postgres, { schema }) as unknown as DebtShiftDatabase;

  beforeAll(async () => {
    for (const migrationFile of migrationFiles) {
      await postgres.exec(readFileSync(`${migrationsDirectory}/${migrationFile}`, 'utf8'));
    }
    await postgres.exec(seedSql());
  }, 30_000);

  afterAll(async () => {
    await postgres.close();
  }, 30_000);

  it('opens, deduplicates, updates, and resolves exact migration alerts', async () => {
    const policy = {
      deadlineLeadMs: 60_000,
      staleMigrationMs: 300_000,
      staleRecoveryMs: 900_000,
    } as const;

    const first = await scanOperationalAlerts(database, policy, NOW);
    expect(first.openedCount).toBe(14);
    expect(first.resolvedCount).toBe(0);
    expect(first.active.map(({ type }) => type)).toEqual([
      'ACCOUNTING_IMBALANCE',
      'CAPACITY_DETERIORATION',
      'CHAIN_RECEIPT_MISMATCH',
      'COMMAND_FAILED_TERMINAL',
      'EXECUTION_DEADLINE_APPROACHING',
      'FEASIBILITY_EXPIRED',
      'POST_DELIVERY_PAYOUT_FAILURE',
      'RESERVATION_SHORTFALL',
      'SETTLED_LEDGER_MISSING',
      'SOLVER_EXPOSURE_OUTSTANDING',
      'STALE_MIGRATION',
      'STALE_RECOVERY',
      'SUPPLEMENTARY_FUNDING_MISSING',
      'UNKNOWN_TRANSPORT_CUSTODY',
    ]);
    expect(
      first.active.find(({ type }) => type === 'EXECUTION_DEADLINE_APPROACHING'),
    ).toMatchObject({ severity: 'WARNING', details: { remainingMs: 30_000 } });

    const repeated = await scanOperationalAlerts(database, policy, NOW);
    expect(repeated).toMatchObject({ openedCount: 0, resolvedCount: 0 });
    const openRows = await postgres.query<{ count: number | string }>(
      `SELECT count(*) FROM operational_alerts WHERE status = 'OPEN'`,
    );
    expect(Number(openRows.rows[0]?.count)).toBe(14);

    const expired = await scanOperationalAlerts(
      database,
      policy,
      new Date('2026-11-13T03:01:00.000Z'),
    );
    expect(expired.openedCount).toBe(0);
    expect(
      expired.active.find(({ type }) => type === 'EXECUTION_DEADLINE_APPROACHING'),
    ).toMatchObject({ severity: 'CRITICAL', details: { remainingMs: -30_000 } });

    await postgres.exec(`
      UPDATE migrations
      SET phase = CASE migration_id
        WHEN '${hash('5')}' THEN 'FAILED_SAFE'::migration_phase
        ELSE 'COMPLETED'::migration_phase
      END,
      updated_at = '${NOW.toISOString()}'
      WHERE migration_id IN ('${hash('5')}', '${hash('6')}');
    `);
    const resolved = await scanOperationalAlerts(database, policy, NOW);
    expect(resolved).toMatchObject({ openedCount: 0, resolvedCount: 14, active: [] });
    const resolvedRows = await postgres.query<{ count: number | string }>(
      `SELECT count(*) FROM operational_alerts WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL`,
    );
    expect(Number(resolvedRows.rows[0]?.count)).toBe(14);
  });
});

function seedSql(): string {
  return `
    INSERT INTO wallets (wallet_id, chain_id, address, account_type)
    VALUES ('00000000-0000-0000-0000-000000000001', 31337,
      '0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa', 'EOA');
    INSERT INTO intents (intent_hash, wallet_id, nonce, expiration, payload, signature)
    VALUES
      ('${hash('1')}', '00000000-0000-0000-0000-000000000001', 1, 2000000000, '{}', '0x00'),
      ('${hash('2')}', '00000000-0000-0000-0000-000000000001', 2, 2000000001, '{}', '0x00');
    INSERT INTO execution_plans
      (plan_hash, migration_id, intent_hash, nonce, deadline, route_hash, payload, signature)
    VALUES
      ('${hash('3')}', '${hash('5')}', '${hash('1')}', 11, 2000000000, '${hash('7')}', '{}', '0x00'),
      ('${hash('4')}', '${hash('6')}', '${hash('2')}', 12, 2000000001, '${hash('8')}', '{}', '0x00');
    INSERT INTO provider_quotes
      (quote_hash, quote_id, provider, mode, amount_in_units, expected_amount_out_units,
       minimum_amount_out_units, payload, raw_response_hash, expires_at)
    VALUES
      ('${hash('9')}', 'alert-quote-1', 'DEBTSHIFT_SIMULATOR', 'SIMULATED', 100, 99, 98,
       '{}', '${hash('a')}', '${NOW.toISOString()}'),
      ('${hash('b')}', 'alert-quote-2', 'DEBTSHIFT_SIMULATOR', 'SIMULATED', 100, 99, 98,
       '{}', '${hash('c')}', '${NOW.toISOString()}');
    INSERT INTO migrations
      (migration_id, intent_hash, plan_hash, quote_hash, phase, expires_at, created_at, updated_at)
    VALUES
      ('${hash('5')}', '${hash('1')}', '${hash('3')}', '${hash('9')}', 'ROUTING',
       '2026-11-13T03:00:30.000Z', '2026-11-13T02:00:00.000Z', '2026-11-13T02:50:00.000Z'),
      ('${hash('6')}', '${hash('2')}', '${hash('4')}', '${hash('b')}', 'SETTLED',
       '2026-11-13T04:00:00.000Z', '2026-11-13T02:00:00.000Z', '${NOW.toISOString()}');
    INSERT INTO liquidity_reservations
      (reservation_id, migration_id, reservation_hash, provider, chain_id, asset,
       principal_units, fee_cap_units, status, expires_at)
    VALUES ('${pairHash('ab')}', '${hash('5')}', '${pairHash('ac')}',
      '0x1000000000000000000000000000000000000001', 31337,
      '0x2000000000000000000000000000000000000002', 100, 10, 'ACTIVE',
      '2026-11-13T04:00:00.000Z');
    INSERT INTO transport_legs
      (migration_id, leg_index, provider, quote_hash, input_asset, output_asset, input_units,
       minimum_output_units, provider_state, observation_count, created_at, updated_at)
    VALUES ('${hash('5')}', 0, 'NEAR_INTENTS_1CLICK', '${hash('9')}', '{}', '{}', 100, 98,
      'UNKNOWN', 3, '2026-11-13T02:00:00.000Z', '2026-11-13T02:59:00.000Z');
    INSERT INTO commands
      (command_id, migration_id, type, idempotency_key, status, logical_attempt, payload,
       payload_hash, last_error, created_at, updated_at)
    VALUES ('${hash('d')}', '${hash('5')}', 'OPEN_TARGET', 'target-open:${hash('5')}',
      'FAILED_TERMINAL', 4, '{}', '${hash('e')}', 'provider response invalid',
      '2026-11-13T02:00:00.000Z', '2026-11-13T02:59:00.000Z');
    INSERT INTO recovery_cases
      (recovery_id, migration_id, policy, status, reason, residual_assets, opened_at,
       created_at, updated_at)
    VALUES ('${hash('f')}', '${hash('5')}', 'MANUAL_CUSTODY_RECONCILIATION', 'OPEN',
      'UNKNOWN_PROVIDER_STATE', '[]', '2026-11-13T02:00:00.000Z',
      '2026-11-13T02:00:00.000Z', '2026-11-13T02:40:00.000Z');
    INSERT INTO evidence
      (evidence_id, migration_id, type, schema_version, provider, network, chain_id,
       block_number, block_hash, transaction_hash, provider_reference, raw_observation_hash,
       normalized_payload, observed_at, verification_state, verification_method,
       verifier_version, supersedes_evidence_id)
    VALUES
      ('${pairHash('ad')}', '${hash('5')}', 'FINANCING_FEASIBILITY', 1, 'TEST',
       'eip155:31337', NULL, NULL, NULL, NULL, '${pairHash('ad')}', '${pairHash('da')}',
       '{"validUntil":"1","solverPrincipalUnits":"100","solverFeeUnits":"10","confirmedExternalFundingUnits":"20","externalFunding":[{"fundingId":"missing-funding","evidenceId":"${pairHash('ae')}","amountUnits":"20","expiresAt":"9999999999"}]}',
       '2026-11-13T02:00:00.000Z', 'FINALIZED', 'SCHEMA_AND_STATE', 'test-v1', NULL),
      ('${pairHash('af')}', '${hash('5')}', 'LIQUIDITY_RESERVATION', 1, 'TEST',
       'eip155:31337', 31337, 10, '${pairHash('db')}', '${pairHash('dc')}',
       '${pairHash('af')}', '${pairHash('dd')}', '{"recoveryReserveUnits":"50"}',
       '2026-11-13T02:01:00.000Z', 'FINALIZED', 'RECEIPT_AND_STATE', 'test-v1', NULL),
      ('${pairHash('bc')}', '${hash('5')}', 'SOURCE_CLOSE', 1, 'TEST',
       'eip155:31337', 31337, 11, '${pairHash('de')}', '${pairHash('df')}',
       '${pairHash('bc')}', '${pairHash('ea')}', '{}',
       '2026-11-13T02:02:00.000Z', 'FINALIZED', 'RECEIPT_AND_STATE', 'test-v1', NULL),
      ('${pairHash('bd')}', '${hash('5')}', 'TRANSPORT_DESTINATION', 1, 'TEST',
       'eip155:31338', 31338, 12, '${pairHash('eb')}', '${pairHash('ec')}',
       '${pairHash('bd')}', '${pairHash('ed')}', '{"amountOutUnits":"90"}',
       '2026-11-13T02:03:00.000Z', 'FINALIZED', 'RECEIPT_AND_STATE', 'test-v1', NULL),
      ('${pairHash('be')}', '${hash('5')}', 'FINANCING_REVALIDATION', 1, 'TEST',
       'eip155:31338', 31338, 13, '${pairHash('ee')}', '${pairHash('ef')}',
       '${pairHash('be')}', '${pairHash('fa')}',
       '{"financingRevalidation":{"checkpoint":"BEFORE_TARGET_BORROW","solverPrincipalUnits":"100","solverFeeUnits":"10","maximumSafeBorrowingCapacityUnits":"90","requiredDestinationBorrowUnits":"110","fundingShortfallUnits":"20","policyFailureCodes":["INSUFFICIENT_LIQUIDITY"]}}',
       '2026-11-13T02:04:00.000Z', 'FINALIZED', 'RECEIPT_AND_STATE', 'test-v1', NULL),
      ('${pairHash('bf')}', '${hash('5')}', 'LEDGER_RECONCILIATION', 1, 'TEST',
       'eip155:31337', 31337, 14, '${pairHash('fb')}', '${pairHash('fc')}',
       '${pairHash('bf')}', '${pairHash('fd')}',
       '{"ledger":{"unexplainedImbalanceUnits":"7","entries":[]}}',
       '2026-11-13T02:05:00.000Z', 'FINALIZED', 'RECEIPT_STATE_AND_BALANCED_LEDGER',
       'test-v1', NULL),
      ('${pairHash('ce')}', '${hash('5')}', 'TRANSPORT_ORIGIN', 1, 'TEST',
       'eip155:31337', 31337, 15, '${pairHash('fe')}', '${pairHash('ff')}',
       '${pairHash('ce')}', '${pairHash('01')}', '{}',
       '2026-11-13T02:06:00.000Z', 'FINALIZED', 'RECEIPT_AND_STATE', 'test-v1', NULL),
      ('${pairHash('cf')}', '${hash('5')}', 'TRANSPORT_ORIGIN', 1,
       'DEBTSHIFT_CANONICALITY_WATCHER', 'eip155:31337', 31337, NULL, NULL, NULL,
       '${pairHash('cf')}', '${pairHash('02')}',
       '{"reason":"FINALIZED_CHAIN_EVIDENCE_REORGED"}',
       '2026-11-13T02:07:00.000Z', 'RETRACTED',
       'CANONICAL_BLOCK_AND_RECEIPT_REVALIDATION', 'test-v1', '${pairHash('ce')}');
  `;
}

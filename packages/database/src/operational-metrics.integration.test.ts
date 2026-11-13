import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DebtShiftDatabase } from './client.js';
import { collectOperationalMetrics } from './operational-metrics.js';
import * as schema from './schema.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const NOW = new Date('2026-11-13T06:00:00.000Z');

describe('authoritative operational metrics', () => {
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

  it('aggregates phases, durable work, custody, recovery, alerts, and ledger without identifiers', async () => {
    const snapshot = await collectOperationalMetrics(database, NOW);

    expect(snapshot.migrationPhases.find(({ phase }) => phase === 'RESERVED')).toEqual({
      phase: 'RESERVED',
      count: 1,
      ageSecondsSum: 30,
      ageSecondsBuckets: [0, 1, 1, 1, 1, 1, 1, 1],
    });
    expect(snapshot.migrationPhases.find(({ phase }) => phase === 'COMPLETED')?.count).toBe(0);
    expect(snapshot.commands).toContainEqual({
      labels: { type: 'CLOSE_SOURCE', status: 'RUNNING' },
      count: 1,
    });
    expect(snapshot.commands).toContainEqual({
      labels: { type: 'CLOSE_SOURCE', status: 'FAILED_TERMINAL' },
      count: 0,
    });
    expect(snapshot.commandAttempts).toContainEqual({
      labels: { type: 'CLOSE_SOURCE' },
      count: 2,
    });
    expect(snapshot.reservations).toContainEqual({
      labels: { status: 'ACTIVE' },
      count: 1,
      amountUnits: '100',
      feeCapUnits: '5',
    });
    expect(snapshot.maximumOpenRecoveryAgeSeconds).toBe(60);
    expect(snapshot.alerts).toContainEqual({
      labels: { type: 'STALE_RECOVERY', severity: 'WARNING', status: 'OPEN' },
      count: 1,
    });
    expect(snapshot.ledger).toContainEqual({
      labels: { category: 'SOLVER_PRINCIPAL' },
      count: 1,
      amountUnits: '100',
    });
    expect(snapshot.phaseTransitions).toContainEqual({
      labels: { phase: 'RESERVED' },
      count: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain(hash('5'));
  });
});

function seedSql(): string {
  return `
    INSERT INTO wallets (wallet_id, chain_id, address, account_type)
    VALUES ('00000000-0000-0000-0000-000000000001', 31337,
            '0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa', 'EOA');
    INSERT INTO intents (intent_hash, wallet_id, nonce, expiration, payload, signature)
    VALUES ('${hash('1')}', '00000000-0000-0000-0000-000000000001', 1,
            2000000000, '{}', '0x00');
    INSERT INTO execution_plans
      (plan_hash, migration_id, intent_hash, nonce, deadline, route_hash, payload, signature)
    VALUES ('${hash('2')}', '${hash('5')}', '${hash('1')}', 2, 1999999999,
            '${hash('6')}', '{}', '0x00');
    INSERT INTO provider_quotes
      (quote_hash, quote_id, provider, mode, amount_in_units, expected_amount_out_units,
       minimum_amount_out_units, payload, raw_response_hash, expires_at)
    VALUES ('${hash('3')}', 'metrics-quote', 'DEBTSHIFT_SIMULATOR', 'SIMULATED', 100,
            99, 98, '{}', '${hash('4')}', '${NOW.toISOString()}');
    INSERT INTO migrations
      (migration_id, intent_hash, plan_hash, quote_hash, phase, expires_at, updated_at)
    VALUES ('${hash('5')}', '${hash('1')}', '${hash('2')}', '${hash('3')}', 'RESERVED',
            '${NOW.toISOString()}', '${new Date(NOW.getTime() - 30_000).toISOString()}');
    INSERT INTO commands
      (command_id, migration_id, type, idempotency_key, status, logical_attempt,
       payload, payload_hash)
    VALUES ('${hash('7')}', '${hash('5')}', 'CLOSE_SOURCE', 'close:metrics', 'RUNNING', 2,
            '{}', '${hash('8')}');
    INSERT INTO outbox_messages
      (outbox_id, command_id, topic, partition_key, payload, status, publish_attempts)
    VALUES ('00000000-0000-0000-0000-000000000002', '${hash('7')}',
            'debtshift.commands.v1', '${hash('5')}', '{}', 'PUBLISHED', 1);
    INSERT INTO chain_actions
      (action_id, command_id, migration_id, chain_id, action_type, action_key,
       transaction_hash, finality, block_number, block_hash, payload)
    VALUES ('${hash('9')}', '${hash('7')}', '${hash('5')}', 31337, 'SOURCE_CLOSE',
            'metrics-action', '${hash('a')}', 'FINALIZED', 10, '${hash('b')}', '{}');
    INSERT INTO liquidity_reservations
      (reservation_id, migration_id, reservation_hash, provider, chain_id, asset,
       principal_units, fee_cap_units, status, expires_at)
    VALUES ('${hash('c')}', '${hash('5')}', '${hash('d')}',
            '0x1000000000000000000000000000000000000001', 31337,
            '0x2000000000000000000000000000000000000002', 100, 5, 'ACTIVE',
            '${NOW.toISOString()}');
    INSERT INTO transport_legs
      (migration_id, leg_index, provider, quote_hash, input_asset, output_asset,
       input_units, minimum_output_units, provider_state)
    VALUES ('${hash('5')}', 0, 'DEBTSHIFT_SIMULATOR', '${hash('3')}', '{}', '{}',
            100, 98, 'PROCESSING');
    INSERT INTO evidence
      (evidence_id, migration_id, type, schema_version, provider, network,
       raw_observation_hash, normalized_payload, observed_at, verification_state,
       verification_method, verifier_version)
    VALUES ('${hash('e')}', '${hash('5')}', 'LIQUIDITY_RESERVATION', 1, 'TEST',
            'anvil:31337', '${hash('f')}', '{}', '${NOW.toISOString()}', 'FINALIZED',
            'TEST', '1');
    INSERT INTO ledger_entries
      (entry_id, migration_id, sequence, component_code, component_id, evidence_id,
       basis, chain_id, token, amount_units, debit_party, credit_party, category)
    VALUES ('${hash('0')}', '${hash('5')}', 1, 'SOLVER_PRINCIPAL', 'principal:metrics',
            '${hash('e')}', 'BASE_UNITS', 31337,
            '0x2000000000000000000000000000000000000002', 100, 'vault', 'source',
            'SOLVER_PRINCIPAL');
    INSERT INTO audit_events
      (event_id, migration_id, sequence, type, phase, actor, payload, payload_hash, observed_at)
    VALUES ('${hash('a')}', '${hash('5')}', 1, 'MIGRATION_PHASE_ADVANCED', 'RESERVED',
            'worker', '{}', '${hash('b')}', '${NOW.toISOString()}');
    INSERT INTO recovery_cases
      (recovery_id, migration_id, policy, status, reason, next_permitted_action,
       action_deadline, escalation_owner, escalation_state, residual_assets, opened_at)
    VALUES ('${hash('b')}', '${hash('5')}', 'MANUAL_CUSTODY_RECONCILIATION', 'OPEN',
            'metrics fixture', 'RECONCILE_TRANSPORT_CUSTODY', '${NOW.toISOString()}',
            'DEBTSHIFT_OPERATIONS', 'MANUAL_REVIEW_REQUIRED', '[]',
            '${new Date(NOW.getTime() - 60_000).toISOString()}');
    INSERT INTO operational_alerts
      (alert_id, migration_id, type, severity, deduplication_key, status, message,
       details, first_observed_at, last_observed_at)
    VALUES ('${hash('d')}', '${hash('5')}', 'STALE_RECOVERY', 'WARNING', 'metrics-alert',
            'OPEN', 'metrics fixture', '{}', '${NOW.toISOString()}', '${NOW.toISOString()}');
  `;
}

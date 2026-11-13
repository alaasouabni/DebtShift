import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const hash = (digit: string) => `0x${digit.repeat(64)}`;

describe('initial PostgreSQL migration', () => {
  const database = new PGlite();

  beforeAll(async () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const migrationFile of migrationFiles) {
      await database.exec(readFileSync(`${migrationsDirectory}/${migrationFile}`, 'utf8'));
    }
    await database.exec(`
      INSERT INTO wallets (wallet_id, chain_id, address, account_type)
      VALUES (
        '00000000-0000-0000-0000-000000000001',
        31337,
        '0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa',
        'EOA'
      );
      INSERT INTO intents (intent_hash, wallet_id, nonce, expiration, payload, signature)
      VALUES (
        '${hash('1')}',
        '00000000-0000-0000-0000-000000000001',
        1,
        2000000000,
        '{}',
        '0x00'
      );
      INSERT INTO execution_plans (
        plan_hash, migration_id, intent_hash, nonce, deadline, route_hash, payload, signature
      ) VALUES (
        '${hash('2')}', '${hash('5')}', '${hash('1')}', 2, 1999999999, '${hash('6')}', '{}', '0x00'
      );
      INSERT INTO provider_quotes (
        quote_hash, quote_id, provider, mode, amount_in_units,
        expected_amount_out_units, minimum_amount_out_units, payload,
        raw_response_hash, expires_at
      ) VALUES (
        '${hash('3')}', 'seed-quote', 'DEBTSHIFT_SIMULATOR', 'SIMULATED',
        100, 99, 98, '{}', '${hash('4')}', now() + interval '1 hour'
      );
      INSERT INTO migrations (
        migration_id, intent_hash, plan_hash, quote_hash, phase, expires_at
      ) VALUES (
        '${hash('5')}', '${hash('1')}', '${hash('2')}', '${hash('3')}', 'AUTHORIZED',
        now() + interval '1 hour'
      );
      INSERT INTO commands (
        command_id, migration_id, type, idempotency_key, payload, payload_hash
      ) VALUES (
        '${hash('7')}', '${hash('5')}', 'RESERVE_LIQUIDITY', 'seed:reserve', '{}', '${hash('8')}'
      );
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it('creates every durable workflow table', async () => {
    const result = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'asset_catalog_versions',
      'audit_events',
      'chain_actions',
      'commands',
      'evidence',
      'execution_plans',
      'intents',
      'ledger_entries',
      'liquidity_reservations',
      'market_snapshots',
      'markets',
      'migrations',
      'outbox_messages',
      'position_snapshots',
      'positions',
      'provider_observations',
      'provider_quotes',
      'recovery_cases',
      'transport_legs',
      'wallets',
    ]);
  });

  it('installs the critical idempotency and financial constraints', async () => {
    const expectedConstraints = [
      'audit_events_migration_sequence_unique',
      'chain_actions_key_unique',
      'commands_idempotency_unique',
      'evidence_block_pair',
      'evidence_log_requires_transaction',
      'execution_plans_intent_nonce_unique',
      'intents_wallet_nonce_unique',
      'ledger_entries_distinct_parties',
      'ledger_entries_evidence_id_evidence_evidence_id_fk',
      'ledger_entries_migration_component_unique',
      'ledger_entries_migration_sequence_unique',
      'migrations_version_nonnegative',
      'outbox_command_unique',
      'provider_observations_response_unique',
      'provider_quotes_min_lte_expected',
      'transport_legs_migration_id_leg_index_pk',
      'wallets_chain_address_unique',
    ];
    const result = await database.query<{ conname: string }>(
      `
      SELECT conname
      FROM pg_constraint
      WHERE conname = ANY($1)
      ORDER BY conname
    `,
      [expectedConstraints],
    );

    expect(result.rows.map((row) => row.conname)).toEqual([...expectedConstraints].sort());
  });

  it('rejects malformed addresses and duplicate wallet identities', async () => {
    await expect(
      database.exec(`
        INSERT INTO wallets (chain_id, address, account_type)
        VALUES (11155111, '0xBAD', 'EOA')
      `),
    ).rejects.toThrow();

    await database.exec(`
      INSERT INTO wallets (chain_id, address, account_type)
      VALUES (11155111, '0x1111111111111111111111111111111111111111', 'EOA')
    `);

    await expect(
      database.exec(`
        INSERT INTO wallets (chain_id, address, account_type)
        VALUES (11155111, '0x1111111111111111111111111111111111111111', 'EOA')
      `),
    ).rejects.toThrow();
  });

  it('rejects negative base units and an unsafe minimum-output quote', async () => {
    await expect(
      database.query(
        `INSERT INTO provider_quotes (
          quote_hash, quote_id, provider, mode, amount_in_units,
          expected_amount_out_units, minimum_amount_out_units, payload,
          raw_response_hash, expires_at
        ) VALUES ($1, 'negative', 'DEBTSHIFT_SIMULATOR', 'SIMULATED', -1, 10, 9, '{}', $2, now())`,
        [hash('1'), hash('2')],
      ),
    ).rejects.toThrow();

    await expect(
      database.query(
        `INSERT INTO provider_quotes (
          quote_hash, quote_id, provider, mode, amount_in_units,
          expected_amount_out_units, minimum_amount_out_units, payload,
          raw_response_hash, expires_at
        ) VALUES ($1, 'unsafe-minimum', 'DEBTSHIFT_SIMULATOR', 'SIMULATED', 10, 9, 10, '{}', $2, now())`,
        [hash('3'), hash('4')],
      ),
    ).rejects.toThrow();
  });

  it('rejects nonce replay, duplicate actions, and duplicate event sequences', async () => {
    await expect(
      database.exec(`
        INSERT INTO intents (intent_hash, wallet_id, nonce, expiration, payload, signature)
        VALUES (
          '${hash('9')}', '00000000-0000-0000-0000-000000000001', 1, 2000000000, '{}', '0x00'
        )
      `),
    ).rejects.toThrow();

    await database.exec(`
      INSERT INTO chain_actions (
        action_id, command_id, migration_id, chain_id, action_type, action_key, payload
      ) VALUES (
        '${hash('9')}', '${hash('7')}', '${hash('5')}', 31337, 'RESERVE', '31337:reserve:1', '{}'
      );
      INSERT INTO audit_events (
        event_id, migration_id, sequence, type, phase, actor, payload, payload_hash, observed_at
      ) VALUES (
        '${hash('a')}', '${hash('5')}', 1, 'MIGRATION_AUTHORIZED', 'AUTHORIZED',
        'api', '{}', '${hash('b')}', now()
      );
    `);

    await expect(
      database.exec(`
        INSERT INTO chain_actions (
          action_id, command_id, migration_id, chain_id, action_type, action_key, payload
        ) VALUES (
          '${hash('c')}', '${hash('7')}', '${hash('5')}', 31337, 'RESERVE', '31337:reserve:1', '{}'
        )
      `),
    ).rejects.toThrow();

    await expect(
      database.exec(`
        INSERT INTO audit_events (
          event_id, migration_id, sequence, type, phase, actor, payload, payload_hash, observed_at
        ) VALUES (
          '${hash('d')}', '${hash('5')}', 1, 'DUPLICATE', 'AUTHORIZED',
          'worker', '{}', '${hash('e')}', now()
        )
      `),
    ).rejects.toThrow();
  });
});

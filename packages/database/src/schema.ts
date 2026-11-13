import type {
  PersistedTargetLendingAuthorization,
  RecoveryCaseStatus,
  RecoveryEscalationState,
  RecoveryNextPermittedAction,
  RecoveryPolicy,
} from '@debtshift/domain';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const uint = (name: string) => numeric(name, { precision: 78, scale: 0 });
const bytes32 = (name: string) => varchar(name, { length: 66 });
const evmAddress = (name: string) => varchar(name, { length: 42 });
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const accountTypeEnum = pgEnum('account_type', ['EOA', 'EIP1271']);
export const migrationPhaseEnum = pgEnum('migration_phase', [
  'DRAFT',
  'QUOTED',
  'AUTHORIZED',
  'RESERVED',
  'SOURCE_CLOSED',
  'ROUTING',
  'DEST_FUNDED',
  'TARGET_OPEN',
  'SETTLED',
  'COMPLETED',
  'RECOVERY',
  'FAILED_SAFE',
  'REQUOTE_REQUIRED',
  'EXPIRED',
  'CANCELLED',
]);
export const evidenceStateEnum = pgEnum('evidence_verification_state', [
  'PROVISIONAL',
  'CONFIRMED',
  'FINALIZED',
  'RETRACTED',
  'REJECTED',
]);
export const commandStatusEnum = pgEnum('command_status', [
  'PENDING',
  'DISPATCHED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL',
  'CANCELLED',
]);
export const outboxStatusEnum = pgEnum('outbox_status', [
  'PENDING',
  'PUBLISHED',
  'FAILED_RETRYABLE',
  'DEAD_LETTER',
]);
export const actionFinalityEnum = pgEnum('action_finality', [
  'CREATED',
  'SUBMITTED',
  'MINED',
  'CONFIRMED',
  'FINALIZED',
  'REVERTED',
  'REORGED',
]);
export const reservationStatusEnum = pgEnum('reservation_status', [
  'PENDING',
  'ACTIVE',
  'CONSUMED',
  'DRAWN',
  'SETTLED',
  'RELEASED',
  'EXPIRED',
]);
export const operationalAlertSeverityEnum = pgEnum('operational_alert_severity', [
  'WARNING',
  'CRITICAL',
]);
export const operationalAlertStatusEnum = pgEnum('operational_alert_status', ['OPEN', 'RESOLVED']);

export const wallets = pgTable(
  'wallets',
  {
    walletId: uuid('wallet_id').primaryKey().defaultRandom(),
    chainId: uint('chain_id').notNull(),
    address: evmAddress('address').notNull(),
    accountType: accountTypeEnum('account_type').notNull(),
    label: text('label'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('wallets_chain_address_unique').on(table.chainId, table.address),
    check('wallets_chain_id_uint', sql`${table.chainId} > 0`),
    check('wallets_address_format', sql`${table.address} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

export const walletAuthChallenges = pgTable(
  'wallet_auth_challenges',
  {
    challengeId: uuid('challenge_id').primaryKey(),
    walletAddress: evmAddress('wallet_address').notNull(),
    chainId: uint('chain_id').notNull(),
    nonce: varchar('nonce', { length: 64 }).notNull(),
    message: text('message').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('wallet_auth_challenges_nonce_unique').on(table.nonce),
    check('wallet_auth_challenges_chain_uint', sql`${table.chainId} > 0`),
    check(
      'wallet_auth_challenges_address_format',
      sql`${table.walletAddress} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check('wallet_auth_challenges_nonce_format', sql`${table.nonce} ~ '^[a-zA-Z0-9]{8,64}$'`),
    check('wallet_auth_challenges_message_nonempty', sql`length(${table.message}) > 0`),
    index('wallet_auth_challenges_wallet_expiry_idx').on(table.walletAddress, table.expiresAt),
  ],
);

export const walletSessions = pgTable(
  'wallet_sessions',
  {
    sessionHash: bytes32('session_hash').primaryKey(),
    walletAddress: evmAddress('wallet_address').notNull(),
    chainId: uint('chain_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check('wallet_sessions_hash_format', sql`${table.sessionHash} ~ '^0x[0-9a-f]{64}$'`),
    check('wallet_sessions_chain_uint', sql`${table.chainId} > 0`),
    check('wallet_sessions_address_format', sql`${table.walletAddress} ~ '^0x[0-9a-f]{40}$'`),
    index('wallet_sessions_wallet_expiry_idx').on(table.walletAddress, table.expiresAt),
  ],
);

export const markets = pgTable(
  'markets',
  {
    marketPk: uuid('market_pk').primaryKey().defaultRandom(),
    chainId: uint('chain_id').notNull(),
    protocol: varchar('protocol', { length: 64 }).notNull(),
    deployment: evmAddress('deployment').notNull(),
    marketId: varchar('market_id', { length: 256 }).notNull(),
    debtAsset: jsonb('debt_asset').$type<Record<string, unknown>>().notNull(),
    collateralAsset: jsonb('collateral_asset').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('markets_identity_unique').on(
      table.chainId,
      table.protocol,
      table.deployment,
      table.marketId,
    ),
    check('markets_chain_id_uint', sql`${table.chainId} > 0`),
    check('markets_deployment_format', sql`${table.deployment} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

export const positions = pgTable(
  'positions',
  {
    positionId: bytes32('position_id').primaryKey(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.walletId),
    marketPk: uuid('market_pk')
      .notNull()
      .references(() => markets.marketPk),
    protocolPositionId: varchar('protocol_position_id', { length: 256 }).notNull(),
    latestSnapshotId: bytes32('latest_snapshot_id'),
    active: boolean('active').notNull().default(true),
    discoveredAt: timestamp('discovered_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('positions_market_protocol_id_unique').on(table.marketPk, table.protocolPositionId),
    check('positions_id_format', sql`${table.positionId} ~ '^0x[0-9a-f]{64}$'`),
    check(
      'positions_latest_snapshot_format',
      sql`${table.latestSnapshotId} IS NULL OR ${table.latestSnapshotId} ~ '^0x[0-9a-f]{64}$'`,
    ),
  ],
);

export const positionSnapshots = pgTable(
  'position_snapshots',
  {
    snapshotId: bytes32('snapshot_id').primaryKey(),
    positionId: bytes32('position_id')
      .notNull()
      .references(() => positions.positionId),
    chainId: uint('chain_id').notNull(),
    blockNumber: uint('block_number').notNull(),
    blockHash: bytes32('block_hash').notNull(),
    debtUnits: uint('debt_units').notNull(),
    collateralUnits: uint('collateral_units').notNull(),
    healthFactorWad: uint('health_factor_wad'),
    ltvBps: integer('ltv_bps'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    rawResponseHash: bytes32('raw_response_hash').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('position_snapshots_position_block_unique').on(
      table.positionId,
      table.blockNumber,
      table.blockHash,
    ),
    check('position_snapshots_chain_uint', sql`${table.chainId} > 0`),
    check('position_snapshots_block_uint', sql`${table.blockNumber} >= 0`),
    check('position_snapshots_debt_uint', sql`${table.debtUnits} >= 0`),
    check('position_snapshots_collateral_uint', sql`${table.collateralUnits} >= 0`),
    check(
      'position_snapshots_ltv_bps',
      sql`${table.ltvBps} IS NULL OR (${table.ltvBps} >= 0 AND ${table.ltvBps} <= 10000)`,
    ),
    index('position_snapshots_position_observed_idx').on(table.positionId, table.observedAt),
  ],
);

export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    snapshotId: bytes32('snapshot_id').primaryKey(),
    marketPk: uuid('market_pk')
      .notNull()
      .references(() => markets.marketPk),
    blockNumber: uint('block_number').notNull(),
    blockHash: bytes32('block_hash').notNull(),
    borrowAprRay: uint('borrow_apr_ray').notNull(),
    availableLiquidityUnits: uint('available_liquidity_units').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    rawResponseHash: bytes32('raw_response_hash').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('market_snapshots_market_block_unique').on(
      table.marketPk,
      table.blockNumber,
      table.blockHash,
    ),
    check('market_snapshots_block_uint', sql`${table.blockNumber} >= 0`),
    check('market_snapshots_apr_uint', sql`${table.borrowAprRay} >= 0`),
    check('market_snapshots_liquidity_uint', sql`${table.availableLiquidityUnits} >= 0`),
    index('market_snapshots_market_observed_idx').on(table.marketPk, table.observedAt),
  ],
);

export const intents = pgTable(
  'intents',
  {
    intentHash: bytes32('intent_hash').primaryKey(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.walletId),
    nonce: uint('nonce').notNull(),
    expiration: uint('expiration').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signature: text('signature').notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('intents_wallet_nonce_unique').on(table.walletId, table.nonce),
    check('intents_hash_format', sql`${table.intentHash} ~ '^0x[0-9a-f]{64}$'`),
    check('intents_nonce_uint', sql`${table.nonce} >= 0`),
    check('intents_expiration_uint', sql`${table.expiration} > 0`),
  ],
);

export const executionPlans = pgTable(
  'execution_plans',
  {
    planHash: bytes32('plan_hash').primaryKey(),
    migrationId: bytes32('migration_id').notNull(),
    intentHash: bytes32('intent_hash')
      .notNull()
      .references(() => intents.intentHash),
    nonce: uint('nonce').notNull(),
    deadline: uint('deadline').notNull(),
    routeHash: bytes32('route_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signature: text('signature').notNull(),
    targetLendingAuthorization: jsonb('target_lending_authorization')
      .$type<PersistedTargetLendingAuthorization>()
      .notNull()
      .default({ authorization: { kind: 'NONE' }, encodedAuthorization: '0x' }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('execution_plans_migration_unique').on(table.migrationId),
    unique('execution_plans_intent_nonce_unique').on(table.intentHash, table.nonce),
    check('execution_plans_hash_format', sql`${table.planHash} ~ '^0x[0-9a-f]{64}$'`),
    check('execution_plans_migration_format', sql`${table.migrationId} ~ '^0x[0-9a-f]{64}$'`),
    check('execution_plans_route_format', sql`${table.routeHash} ~ '^0x[0-9a-f]{64}$'`),
    check('execution_plans_nonce_uint', sql`${table.nonce} >= 0`),
    check('execution_plans_deadline_uint', sql`${table.deadline} > 0`),
  ],
);

export const providerQuotes = pgTable(
  'provider_quotes',
  {
    quoteHash: bytes32('quote_hash').primaryKey(),
    quoteId: varchar('quote_id', { length: 256 }).notNull(),
    provider: varchar('provider', { length: 64 }).notNull(),
    mode: varchar('mode', { length: 32 }).notNull(),
    amountInUnits: uint('amount_in_units').notNull(),
    expectedAmountOutUnits: uint('expected_amount_out_units').notNull(),
    minimumAmountOutUnits: uint('minimum_amount_out_units').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    rawResponseHash: bytes32('raw_response_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('provider_quotes_provider_id_unique').on(table.provider, table.quoteId),
    check('provider_quotes_input_positive', sql`${table.amountInUnits} > 0`),
    check('provider_quotes_output_positive', sql`${table.expectedAmountOutUnits} > 0`),
    check('provider_quotes_min_positive', sql`${table.minimumAmountOutUnits} > 0`),
    check(
      'provider_quotes_min_lte_expected',
      sql`${table.minimumAmountOutUnits} <= ${table.expectedAmountOutUnits}`,
    ),
  ],
);

export const providerObservations = pgTable(
  'provider_observations',
  {
    observationId: bytes32('observation_id').primaryKey(),
    provider: varchar('provider', { length: 64 }).notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    requestHash: bytes32('request_hash').notNull(),
    responseHash: bytes32('response_hash').notNull(),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>().notNull(),
    responsePayload: jsonb('response_payload').$type<Record<string, unknown>>().notNull(),
    correlationId: varchar('correlation_id', { length: 256 }),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('provider_observations_response_unique').on(
      table.provider,
      table.operation,
      table.responseHash,
    ),
    check('provider_observations_id_format', sql`${table.observationId} ~ '^0x[0-9a-f]{64}$'`),
    check(
      'provider_observations_request_hash_format',
      sql`${table.requestHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      'provider_observations_response_hash_format',
      sql`${table.responseHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    index('provider_observations_provider_time_idx').on(table.provider, table.observedAt),
  ],
);

export const migrations = pgTable(
  'migrations',
  {
    migrationId: bytes32('migration_id').primaryKey(),
    intentHash: bytes32('intent_hash')
      .notNull()
      .references(() => intents.intentHash),
    planHash: bytes32('plan_hash')
      .notNull()
      .references(() => executionPlans.planHash),
    quoteHash: bytes32('quote_hash')
      .notNull()
      .references(() => providerQuotes.quoteHash),
    phase: migrationPhaseEnum('phase').notNull().default('DRAFT'),
    version: integer('version').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('migrations_intent_unique').on(table.intentHash),
    unique('migrations_plan_unique').on(table.planHash),
    check('migrations_id_format', sql`${table.migrationId} ~ '^0x[0-9a-f]{64}$'`),
    check('migrations_version_nonnegative', sql`${table.version} >= 0`),
    index('migrations_phase_updated_idx').on(table.phase, table.updatedAt),
  ],
);

export const liquidityReservations = pgTable(
  'liquidity_reservations',
  {
    reservationId: bytes32('reservation_id').primaryKey(),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    reservationHash: bytes32('reservation_hash').notNull(),
    provider: evmAddress('provider').notNull(),
    chainId: uint('chain_id').notNull(),
    asset: evmAddress('asset').notNull(),
    principalUnits: uint('principal_units').notNull(),
    feeCapUnits: uint('fee_cap_units').notNull(),
    status: reservationStatusEnum('status').notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('liquidity_reservations_migration_unique').on(table.migrationId),
    unique('liquidity_reservations_hash_unique').on(table.reservationHash),
    check('liquidity_reservations_principal_positive', sql`${table.principalUnits} > 0`),
    check('liquidity_reservations_fee_uint', sql`${table.feeCapUnits} >= 0`),
  ],
);

export const commands = pgTable(
  'commands',
  {
    commandId: bytes32('command_id').primaryKey(),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    type: varchar('type', { length: 64 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
    status: commandStatusEnum('status').notNull().default('PENDING'),
    logicalAttempt: integer('logical_attempt').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: bytes32('payload_hash').notNull(),
    lastError: text('last_error'),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('commands_idempotency_unique').on(table.idempotencyKey),
    check('commands_attempt_nonnegative', sql`${table.logicalAttempt} >= 0`),
    index('commands_ready_idx').on(table.status, table.availableAt),
    index('commands_migration_idx').on(table.migrationId, table.createdAt),
  ],
);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    outboxId: uuid('outbox_id').primaryKey().defaultRandom(),
    commandId: bytes32('command_id')
      .notNull()
      .references(() => commands.commandId),
    topic: varchar('topic', { length: 128 }).notNull(),
    partitionKey: varchar('partition_key', { length: 256 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum('status').notNull().default('PENDING'),
    publishAttempts: integer('publish_attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('outbox_command_unique').on(table.commandId),
    check('outbox_attempt_nonnegative', sql`${table.publishAttempts} >= 0`),
    index('outbox_pending_idx').on(table.status, table.availableAt),
  ],
);

export const chainActions = pgTable(
  'chain_actions',
  {
    actionId: bytes32('action_id').primaryKey(),
    commandId: bytes32('command_id')
      .notNull()
      .references(() => commands.commandId),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    chainId: uint('chain_id').notNull(),
    actionType: varchar('action_type', { length: 64 }).notNull(),
    actionKey: varchar('action_key', { length: 256 }).notNull(),
    transactionHash: bytes32('transaction_hash'),
    nonce: uint('nonce'),
    finality: actionFinalityEnum('finality').notNull().default('CREATED'),
    blockNumber: uint('block_number'),
    blockHash: bytes32('block_hash'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('chain_actions_key_unique').on(table.chainId, table.actionKey),
    uniqueIndex('chain_actions_transaction_unique')
      .on(table.chainId, table.transactionHash)
      .where(sql`${table.transactionHash} IS NOT NULL`),
    check(
      'chain_actions_block_pair',
      sql`(${table.blockNumber} IS NULL) = (${table.blockHash} IS NULL)`,
    ),
    index('chain_actions_migration_idx').on(table.migrationId, table.createdAt),
  ],
);

export const transportLegs = pgTable(
  'transport_legs',
  {
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    legIndex: integer('leg_index').notNull(),
    provider: varchar('provider', { length: 64 }).notNull(),
    quoteHash: bytes32('quote_hash').notNull(),
    inputAsset: jsonb('input_asset').$type<Record<string, unknown>>().notNull(),
    outputAsset: jsonb('output_asset').$type<Record<string, unknown>>().notNull(),
    inputUnits: uint('input_units').notNull(),
    minimumOutputUnits: uint('minimum_output_units').notNull(),
    observedOutputUnits: uint('observed_output_units'),
    providerState: varchar('provider_state', { length: 64 }).notNull(),
    providerReference: varchar('provider_reference', { length: 256 }),
    depositAddress: text('deposit_address'),
    originTransactionHash: bytes32('origin_transaction_hash'),
    destinationTransactionHash: bytes32('destination_transaction_hash'),
    refundTransactionHash: bytes32('refund_transaction_hash'),
    observationCount: integer('observation_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.migrationId, table.legIndex] }),
    check('transport_legs_index_nonnegative', sql`${table.legIndex} >= 0`),
    check('transport_legs_input_positive', sql`${table.inputUnits} > 0`),
    check('transport_legs_output_positive', sql`${table.minimumOutputUnits} > 0`),
    check(
      'transport_legs_observed_output_nonnegative',
      sql`${table.observedOutputUnits} IS NULL OR ${table.observedOutputUnits} >= 0`,
    ),
    check('transport_legs_observation_nonnegative', sql`${table.observationCount} >= 0`),
  ],
);

export const evidence = pgTable(
  'evidence',
  {
    evidenceId: bytes32('evidence_id').primaryKey(),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    type: varchar('type', { length: 64 }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    provider: varchar('provider', { length: 128 }).notNull(),
    network: varchar('network', { length: 128 }).notNull(),
    chainId: uint('chain_id'),
    blockNumber: uint('block_number'),
    blockHash: bytes32('block_hash'),
    transactionHash: bytes32('transaction_hash'),
    logIndex: integer('log_index'),
    providerReference: varchar('provider_reference', { length: 256 }),
    rawObservationHash: bytes32('raw_observation_hash').notNull(),
    normalizedPayload: jsonb('normalized_payload').$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    verificationState: evidenceStateEnum('verification_state').notNull(),
    verificationMethod: varchar('verification_method', { length: 128 }).notNull(),
    verifierVersion: varchar('verifier_version', { length: 64 }).notNull(),
    supersedesEvidenceId: bytes32('supersedes_evidence_id'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('evidence_provider_reference_unique').on(
      table.provider,
      table.network,
      table.providerReference,
    ),
    uniqueIndex('evidence_chain_log_unique')
      .on(table.chainId, table.transactionHash, table.logIndex, table.type)
      .where(
        sql`${table.chainId} IS NOT NULL AND ${table.transactionHash} IS NOT NULL AND ${table.logIndex} IS NOT NULL`,
      ),
    check('evidence_schema_version_positive', sql`${table.schemaVersion} > 0`),
    check(
      'evidence_log_index_nonnegative',
      sql`${table.logIndex} IS NULL OR ${table.logIndex} >= 0`,
    ),
    check(
      'evidence_block_pair',
      sql`(${table.blockNumber} IS NULL) = (${table.blockHash} IS NULL)`,
    ),
    check(
      'evidence_log_requires_transaction',
      sql`${table.logIndex} IS NULL OR ${table.transactionHash} IS NOT NULL`,
    ),
    index('evidence_migration_type_state_idx').on(
      table.migrationId,
      table.type,
      table.verificationState,
    ),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    entryId: bytes32('entry_id').primaryKey(),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    sequence: integer('sequence').notNull(),
    componentCode: varchar('component_code', { length: 64 }).notNull(),
    componentId: varchar('component_id', { length: 256 }).notNull(),
    evidenceId: bytes32('evidence_id')
      .notNull()
      .references(() => evidence.evidenceId),
    basis: varchar('basis', { length: 32 }).notNull(),
    chainId: uint('chain_id').notNull(),
    token: evmAddress('token').notNull(),
    amountUnits: uint('amount_units').notNull(),
    debitParty: varchar('debit_party', { length: 128 }).notNull(),
    creditParty: varchar('credit_party', { length: 128 }).notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    transactionReference: varchar('transaction_reference', { length: 256 }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('ledger_entries_migration_sequence_unique').on(table.migrationId, table.sequence),
    unique('ledger_entries_migration_component_unique').on(table.migrationId, table.componentId),
    check('ledger_entries_sequence_positive', sql`${table.sequence} > 0`),
    check('ledger_entries_amount_positive', sql`${table.amountUnits} > 0`),
    check('ledger_entries_distinct_parties', sql`${table.debitParty} <> ${table.creditParty}`),
    index('ledger_entries_balance_idx').on(table.migrationId, table.chainId, table.token),
    index('ledger_entries_evidence_idx').on(table.evidenceId),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    eventId: bytes32('event_id').primaryKey(),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    sequence: integer('sequence').notNull(),
    type: varchar('type', { length: 128 }).notNull(),
    phase: migrationPhaseEnum('phase').notNull(),
    actor: varchar('actor', { length: 128 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: bytes32('payload_hash').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('audit_events_migration_sequence_unique').on(table.migrationId, table.sequence),
    check('audit_events_sequence_positive', sql`${table.sequence} > 0`),
    index('audit_events_migration_observed_idx').on(table.migrationId, table.observedAt),
  ],
);

export const recoveryCases = pgTable(
  'recovery_cases',
  {
    recoveryId: bytes32('recovery_id').primaryKey(),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    policy: varchar('policy', { length: 128 }).$type<RecoveryPolicy>().notNull(),
    status: varchar('status', { length: 64 }).$type<RecoveryCaseStatus>().notNull(),
    reason: text('reason').notNull(),
    nextPermittedAction: varchar('next_permitted_action', { length: 96 })
      .$type<RecoveryNextPermittedAction>()
      .notNull(),
    actionDeadline: timestamp('action_deadline', { withTimezone: true, mode: 'date' }).notNull(),
    escalationOwner: varchar('escalation_owner', { length: 128 }).notNull(),
    escalationState: varchar('escalation_state', { length: 64 })
      .$type<RecoveryEscalationState>()
      .notNull(),
    residualAssets: jsonb('residual_assets')
      .$type<ReadonlyArray<Record<string, unknown>>>()
      .notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('recovery_cases_migration_unique').on(table.migrationId),
    index('recovery_cases_escalation_idx').on(table.escalationState, table.actionDeadline),
    check(
      'recovery_cases_action_state_consistent',
      sql`(${table.escalationState} = 'AUTOMATED_RECOVERY_PENDING' AND ${table.nextPermittedAction} = 'EXECUTE_SIGNED_RECOVERY') OR (${table.escalationState} = 'MANUAL_REVIEW_REQUIRED' AND ${table.nextPermittedAction} <> 'EXECUTE_SIGNED_RECOVERY') OR ${table.escalationState} = 'RESOLVED_FAILED_SAFE'`,
    ),
    check(
      'recovery_cases_status_state_consistent',
      sql`(${table.status} = 'OPEN' AND ${table.escalationState} <> 'RESOLVED_FAILED_SAFE') OR (${table.status} = 'RESOLVED_FAILED_SAFE' AND ${table.escalationState} = 'RESOLVED_FAILED_SAFE')`,
    ),
  ],
);

export const operationalAlerts = pgTable(
  'operational_alerts',
  {
    alertId: bytes32('alert_id').primaryKey(),
    migrationId: bytes32('migration_id')
      .notNull()
      .references(() => migrations.migrationId),
    type: varchar('type', { length: 96 }).notNull(),
    severity: operationalAlertSeverityEnum('severity').notNull(),
    deduplicationKey: varchar('deduplication_key', { length: 256 }).notNull(),
    status: operationalAlertStatusEnum('status').notNull().default('OPEN'),
    message: text('message').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('operational_alerts_deduplication_unique').on(table.deduplicationKey),
    index('operational_alerts_open_idx').on(table.status, table.severity, table.lastObservedAt),
    index('operational_alerts_migration_idx').on(table.migrationId, table.createdAt),
    check('operational_alerts_id_format', sql`${table.alertId} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

export const assetCatalogVersions = pgTable(
  'asset_catalog_versions',
  {
    catalogHash: bytes32('catalog_hash').primaryKey(),
    provider: varchar('provider', { length: 64 }).notNull(),
    environment: varchar('environment', { length: 64 }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payload: jsonb('payload').$type<ReadonlyArray<Record<string, unknown>>>().notNull(),
    rawResponseHash: bytes32('raw_response_hash').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('asset_catalog_provider_hash_unique').on(table.provider, table.catalogHash),
    check('asset_catalog_schema_positive', sql`${table.schemaVersion} > 0`),
  ],
);

export type WalletRow = typeof wallets.$inferSelect;
export type MarketRow = typeof markets.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;
export type MigrationRow = typeof migrations.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
export type CommandRow = typeof commands.$inferSelect;

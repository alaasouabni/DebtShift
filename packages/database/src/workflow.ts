import {
  assertAllowedPhaseTransition,
  deriveMigrationPhase,
  evidenceSchema,
  hashCanonicalText,
  ledgerReconciliationSchema,
  phaseEvidenceFromRecords,
  recoveryOpeningPayloadSchema,
  traceContextCarrierSchema,
  type Evidence,
  type MigrationPhase,
  type TraceContextCarrier,
} from '@debtshift/domain';
import { and, asc, eq, inArray, lte, max, or } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import {
  auditEvents,
  commands,
  evidence as evidenceTable,
  ledgerEntries,
  liquidityReservations,
  migrations,
  outboxMessages,
  recoveryCases,
} from './schema.js';
import { lockMigration } from './transaction.js';

export interface PlannedCommand {
  readonly type:
    | 'RESERVE_LIQUIDITY'
    | 'CLOSE_SOURCE'
    | 'DISPATCH_TRANSPORT'
    | 'VERIFY_DESTINATION'
    | 'OPEN_TARGET'
    | 'SETTLE_LIQUIDITY'
    | 'FINALIZE_NEAR_RECEIPT'
    | 'EXECUTE_RECOVERY'
    | 'CANCEL_MIGRATION';
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}

export interface OutboxEnvelope {
  readonly outboxId: string;
  readonly commandId: string;
  readonly topic: string;
  readonly partitionKey: string;
  readonly payload: Record<string, unknown>;
  readonly traceContext?: TraceContextCarrier;
}

export type OutboxPublisher = (message: OutboxEnvelope) => Promise<void>;

export function planNextCommand(
  migrationId: string,
  phase: MigrationPhase,
): PlannedCommand | undefined {
  const definitions: Partial<Record<MigrationPhase, readonly [PlannedCommand['type'], string]>> = {
    AUTHORIZED: ['RESERVE_LIQUIDITY', 'reserve'],
    RESERVED: ['CLOSE_SOURCE', 'source-close'],
    SOURCE_CLOSED: ['DISPATCH_TRANSPORT', 'route-deposit'],
    ROUTING: ['VERIFY_DESTINATION', 'verify-destination'],
    DEST_FUNDED: ['OPEN_TARGET', 'target-open'],
    TARGET_OPEN: ['SETTLE_LIQUIDITY', 'solver-settle'],
    SETTLED: ['FINALIZE_NEAR_RECEIPT', 'near-finalize'],
    RECOVERY: ['EXECUTE_RECOVERY', 'recovery'],
  };
  const definition = definitions[phase];
  if (definition === undefined) return undefined;
  const [type, prefix] = definition;
  return {
    type,
    idempotencyKey: `${prefix}:${migrationId}`,
    payload: { migrationId },
  };
}

export async function enqueueCommand(
  database: DebtShiftDatabase,
  migrationId: string,
  command: PlannedCommand,
  traceContext?: TraceContextCarrier,
): Promise<string> {
  const commandId = hashCanonicalText(`debtshift.command.v1:${command.idempotencyKey}`);
  const payloadHash = hashCanonicalText(canonicalJson(command.payload));

  await database.transaction(async (transaction) => {
    await lockMigration(transaction, migrationId);
    await insertCommandInTransaction(
      transaction,
      migrationId,
      command,
      commandId,
      payloadHash,
      traceContext,
    );
  });
  return commandId;
}

export async function advanceMigrationWithEvidence(
  database: DebtShiftDatabase,
  record: Evidence,
  actor: string,
  traceContext?: TraceContextCarrier,
): Promise<MigrationPhase> {
  const parsedEvidence = evidenceSchema.parse(record);
  return database.transaction(
    async (transaction) => {
      await lockMigration(transaction, parsedEvidence.migrationId);
      const [migration] = await transaction
        .select()
        .from(migrations)
        .where(eq(migrations.migrationId, parsedEvidence.migrationId))
        .limit(1);
      if (migration === undefined) throw new Error('Migration disappeared while locked.');

      let cancellationCommandIds: string[] = [];
      if (
        parsedEvidence.verificationState === 'FINALIZED' &&
        parsedEvidence.type === 'MIGRATION_CANCELLATION_REQUESTED'
      ) {
        if (!['AUTHORIZED', 'RESERVED', 'CANCELLED'].includes(migration.phase)) {
          throw new Error(`Migration cancellation is not permitted from phase ${migration.phase}.`);
        }
        const cancellableCommands = await transaction
          .select({ commandId: commands.commandId, status: commands.status })
          .from(commands)
          .where(
            and(
              eq(commands.migrationId, parsedEvidence.migrationId),
              inArray(commands.status, ['PENDING', 'DISPATCHED', 'RUNNING', 'FAILED_RETRYABLE']),
            ),
          )
          .for('update');
        if (cancellableCommands.some(({ status }) => status === 'RUNNING')) {
          throw new Error('Migration cancellation cannot race a running financial command.');
        }
        cancellationCommandIds = cancellableCommands.map(({ commandId }) => commandId);
      }

      const insertedEvidence = await transaction
        .insert(evidenceTable)
        .values({
          evidenceId: parsedEvidence.evidenceId,
          migrationId: parsedEvidence.migrationId,
          type: parsedEvidence.type,
          schemaVersion: parsedEvidence.schemaVersion,
          provider: parsedEvidence.provider,
          network: parsedEvidence.network,
          chainId: parsedEvidence.chainId === undefined ? null : parsedEvidence.chainId.toString(),
          blockNumber: parsedEvidence.blockNumber ?? null,
          blockHash: parsedEvidence.blockHash ?? null,
          transactionHash: parsedEvidence.transactionHash ?? null,
          logIndex: parsedEvidence.logIndex ?? null,
          providerReference: parsedEvidence.providerReference ?? null,
          rawObservationHash: parsedEvidence.rawObservationHash,
          normalizedPayload: parsedEvidence.normalizedPayload,
          observedAt: new Date(parsedEvidence.observedAt),
          verificationState: parsedEvidence.verificationState,
          verificationMethod: parsedEvidence.verificationMethod,
          verifierVersion: parsedEvidence.verifierVersion,
          supersedesEvidenceId: parsedEvidence.supersedesEvidenceId ?? null,
        })
        .onConflictDoNothing({ target: evidenceTable.evidenceId })
        .returning({ evidenceId: evidenceTable.evidenceId });

      if (
        insertedEvidence.length !== 0 &&
        parsedEvidence.type === 'MIGRATION_CANCELLATION_REQUESTED'
      ) {
        if (cancellationCommandIds.length !== 0) {
          await transaction
            .update(commands)
            .set({
              status: 'CANCELLED',
              lastError: 'Superseded by the borrower cancellation request.',
              updatedAt: new Date(parsedEvidence.observedAt),
            })
            .where(inArray(commands.commandId, cancellationCommandIds));
        }
        if (migration.phase === 'AUTHORIZED') {
          await transaction
            .update(liquidityReservations)
            .set({ status: 'RELEASED', updatedAt: new Date(parsedEvidence.observedAt) })
            .where(
              and(
                eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
                eq(liquidityReservations.status, 'PENDING'),
              ),
            );
        }
      }

      if (parsedEvidence.verificationState === 'FINALIZED') {
        if (parsedEvidence.type === 'LEDGER_RECONCILIATION') {
          await persistLedgerReconciliation(transaction, parsedEvidence);
        }
        if (parsedEvidence.type === 'LIQUIDITY_RESERVATION') {
          await transaction
            .update(liquidityReservations)
            .set({ status: 'ACTIVE', updatedAt: new Date(parsedEvidence.observedAt) })
            .where(
              and(
                eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
                eq(liquidityReservations.status, 'PENDING'),
              ),
            );
        }
        if (parsedEvidence.type === 'SOURCE_CLOSE') {
          await transaction
            .update(liquidityReservations)
            .set({ status: 'DRAWN', updatedAt: new Date(parsedEvidence.observedAt) })
            .where(
              and(
                eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
                eq(liquidityReservations.status, 'ACTIVE'),
              ),
            );
        }
        if (parsedEvidence.type === 'LIQUIDITY_SETTLEMENT') {
          await transaction
            .update(liquidityReservations)
            .set({ status: 'SETTLED', updatedAt: new Date(parsedEvidence.observedAt) })
            .where(
              and(
                eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
                eq(liquidityReservations.status, 'DRAWN'),
              ),
            );
        }
        if (parsedEvidence.type === 'MIGRATION_EXPIRED') {
          await transaction
            .update(liquidityReservations)
            .set({ status: 'EXPIRED', updatedAt: new Date(parsedEvidence.observedAt) })
            .where(
              and(
                eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
                or(
                  eq(liquidityReservations.status, 'PENDING'),
                  eq(liquidityReservations.status, 'ACTIVE'),
                ),
              ),
            );
        }
        if (parsedEvidence.type === 'MIGRATION_CANCELLED') {
          await transaction
            .update(liquidityReservations)
            .set({ status: 'RELEASED', updatedAt: new Date(parsedEvidence.observedAt) })
            .where(
              and(
                eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
                inArray(liquidityReservations.status, ['PENDING', 'ACTIVE']),
              ),
            );
        }
        if (parsedEvidence.type === 'REQUOTE_REQUIRED') {
          await transaction
            .update(liquidityReservations)
            .set({ status: 'RELEASED', updatedAt: new Date(parsedEvidence.observedAt) })
            .where(
              and(
                eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
                eq(liquidityReservations.status, 'ACTIVE'),
              ),
            );
        }
        if (parsedEvidence.type === 'RECOVERY_OPENED') {
          await openRecoveryCase(transaction, parsedEvidence, insertedEvidence.length !== 0);
        }
        if (parsedEvidence.type === 'RECOVERY_COMPLETED') {
          const resolved = await transaction
            .update(recoveryCases)
            .set({
              status: 'RESOLVED_FAILED_SAFE',
              escalationState: 'RESOLVED_FAILED_SAFE',
              resolvedAt: new Date(parsedEvidence.observedAt),
              updatedAt: new Date(parsedEvidence.observedAt),
            })
            .where(eq(recoveryCases.migrationId, parsedEvidence.migrationId))
            .returning({ recoveryId: recoveryCases.recoveryId });
          if (resolved.length === 0) {
            throw new Error('Recovery cannot complete without a durable recovery case.');
          }
        }
      }
      if (
        parsedEvidence.verificationState === 'RETRACTED' &&
        parsedEvidence.type === 'LIQUIDITY_RESERVATION'
      ) {
        await transaction
          .update(liquidityReservations)
          .set({ status: 'RELEASED', updatedAt: new Date(parsedEvidence.observedAt) })
          .where(
            and(
              eq(liquidityReservations.migrationId, parsedEvidence.migrationId),
              eq(liquidityReservations.status, 'ACTIVE'),
            ),
          );
      }

      const storedEvidence = await transaction
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.migrationId, parsedEvidence.migrationId));
      const normalized = storedEvidence.map(databaseEvidenceToDomain);
      const derivedPhase = deriveMigrationPhase(phaseEvidenceFromRecords(normalized));
      if (derivedPhase === migration.phase) {
        if (
          insertedEvidence.length !== 0 &&
          parsedEvidence.type === 'MIGRATION_CANCELLATION_REQUESTED' &&
          migration.phase === 'RESERVED'
        ) {
          const sequenceResult = await transaction
            .select({ maximumSequence: max(auditEvents.sequence) })
            .from(auditEvents)
            .where(eq(auditEvents.migrationId, migration.migrationId));
          const sequence = (sequenceResult[0]?.maximumSequence ?? 0) + 1;
          const payload = { evidenceId: parsedEvidence.evidenceId, phase: migration.phase };
          await transaction.insert(auditEvents).values({
            eventId: hashCanonicalText(
              `debtshift.audit.v1:${migration.migrationId}:${sequence.toString()}`,
            ),
            migrationId: migration.migrationId,
            sequence,
            type: 'MIGRATION_CANCELLATION_REQUESTED',
            phase: migration.phase,
            actor,
            payload,
            payloadHash: hashCanonicalText(canonicalJson(payload)),
            observedAt: new Date(parsedEvidence.observedAt),
          });
          const command: PlannedCommand = {
            type: 'CANCEL_MIGRATION',
            idempotencyKey: `cancel:${migration.migrationId}`,
            payload: { migrationId: migration.migrationId },
          };
          await insertCommandInTransaction(
            transaction,
            migration.migrationId,
            command,
            hashCanonicalText(`debtshift.command.v1:${command.idempotencyKey}`),
            hashCanonicalText(canonicalJson(command.payload)),
            traceContext,
          );
        }
        return derivedPhase;
      }
      assertAllowedPhaseTransition(migration.phase, derivedPhase);

      const [updated] = await transaction
        .update(migrations)
        .set({
          phase: derivedPhase,
          version: migration.version + 1,
          updatedAt: new Date(),
          ...(derivedPhase === 'COMPLETED' ? { completedAt: new Date() } : {}),
        })
        .where(
          and(
            eq(migrations.migrationId, migration.migrationId),
            eq(migrations.version, migration.version),
          ),
        )
        .returning({ migrationId: migrations.migrationId });
      if (updated === undefined) throw new Error('Optimistic migration version conflict.');

      const sequenceResult = await transaction
        .select({ maximumSequence: max(auditEvents.sequence) })
        .from(auditEvents)
        .where(eq(auditEvents.migrationId, migration.migrationId));
      const maximumSequence = sequenceResult[0]?.maximumSequence ?? 0;
      const sequence = maximumSequence + 1;
      const eventPayload = {
        from: migration.phase,
        to: derivedPhase,
        evidenceId: parsedEvidence.evidenceId,
      };
      await transaction.insert(auditEvents).values({
        eventId: hashCanonicalText(
          `debtshift.audit.v1:${migration.migrationId}:${sequence.toString()}`,
        ),
        migrationId: migration.migrationId,
        sequence,
        type: 'MIGRATION_PHASE_ADVANCED',
        phase: derivedPhase,
        actor,
        payload: eventPayload,
        payloadHash: hashCanonicalText(canonicalJson(eventPayload)),
        observedAt: new Date(parsedEvidence.observedAt),
      });

      const requiresManualReview =
        derivedPhase === 'RECOVERY' &&
        parsedEvidence.type === 'RECOVERY_OPENED' &&
        parsedEvidence.normalizedPayload.requiresManualReview === true;
      const nextCommand = requiresManualReview
        ? undefined
        : planNextCommand(migration.migrationId, derivedPhase);
      if (nextCommand !== undefined) {
        const commandId = hashCanonicalText(`debtshift.command.v1:${nextCommand.idempotencyKey}`);
        await insertCommandInTransaction(
          transaction,
          migration.migrationId,
          nextCommand,
          commandId,
          hashCanonicalText(canonicalJson(nextCommand.payload)),
          traceContext,
        );
      }
      return derivedPhase;
    },
    { isolationLevel: 'serializable', accessMode: 'read write', deferrable: false },
  );
}

async function persistLedgerReconciliation(
  transaction: Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0],
  record: Evidence,
): Promise<void> {
  const reconciliation = ledgerReconciliationSchema.parse(record.normalizedPayload.ledger);
  if (reconciliation.migrationId !== record.migrationId) {
    throw new Error('Ledger reconciliation belongs to another migration.');
  }
  const supportingEvidenceIds = [
    ...new Set(reconciliation.entries.map((entry) => entry.evidenceId)),
  ];
  const supportingEvidence = await transaction
    .select({ evidenceId: evidenceTable.evidenceId })
    .from(evidenceTable)
    .where(
      and(
        eq(evidenceTable.migrationId, record.migrationId),
        eq(evidenceTable.verificationState, 'FINALIZED'),
        inArray(evidenceTable.evidenceId, supportingEvidenceIds),
      ),
    );
  if (supportingEvidence.length !== supportingEvidenceIds.length) {
    throw new Error('Ledger entries must reference finalized evidence from the same migration.');
  }
  for (const entry of reconciliation.entries) {
    await transaction
      .insert(ledgerEntries)
      .values({
        entryId: entry.entryId,
        migrationId: entry.migrationId,
        sequence: entry.sequence,
        componentCode: entry.componentCode,
        componentId: entry.componentId,
        evidenceId: entry.evidenceId,
        basis: entry.basis,
        chainId: entry.chainId.toString(),
        token: entry.token.toLowerCase(),
        amountUnits: entry.amountUnits,
        debitParty: entry.debitParty,
        creditParty: entry.creditParty,
        category: entry.category,
        transactionReference: entry.transactionReference ?? null,
        createdAt: new Date(entry.createdAt),
      })
      .onConflictDoNothing({ target: ledgerEntries.entryId });
  }
  const persisted = await transaction
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.migrationId, record.migrationId),
        inArray(
          ledgerEntries.entryId,
          reconciliation.entries.map((entry) => entry.entryId),
        ),
      ),
    );
  if (persisted.length !== reconciliation.entries.length) {
    throw new Error('Ledger reconciliation was not persisted completely.');
  }
  const persistedById = new Map(persisted.map((entry) => [entry.entryId, entry]));
  for (const expected of reconciliation.entries) {
    const actual = persistedById.get(expected.entryId);
    if (
      actual === undefined ||
      actual.migrationId !== expected.migrationId ||
      actual.sequence !== expected.sequence ||
      actual.componentCode !== expected.componentCode ||
      actual.componentId !== expected.componentId ||
      actual.evidenceId !== expected.evidenceId ||
      actual.basis !== expected.basis ||
      actual.chainId !== expected.chainId.toString() ||
      actual.token !== expected.token.toLowerCase() ||
      actual.amountUnits !== expected.amountUnits ||
      actual.debitParty !== expected.debitParty ||
      actual.creditParty !== expected.creditParty ||
      actual.category !== expected.category ||
      actual.transactionReference !== (expected.transactionReference ?? null) ||
      actual.createdAt.toISOString() !== new Date(expected.createdAt).toISOString()
    ) {
      throw new Error('Stored ledger entry conflicts with the finalized reconciliation.');
    }
  }
}

async function openRecoveryCase(
  transaction: Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0],
  record: Evidence,
  isNewEvidence: boolean,
): Promise<void> {
  const metadata = recoveryMetadata(record);
  const observedAt = new Date(record.observedAt);
  const recoveryId = hashCanonicalText(`debtshift.recovery.v1:${record.migrationId}`);
  await transaction
    .insert(recoveryCases)
    .values({
      recoveryId,
      migrationId: record.migrationId,
      policy: metadata.policy,
      status: 'OPEN',
      reason: metadata.reason,
      nextPermittedAction: metadata.nextPermittedAction,
      actionDeadline: new Date(metadata.actionDeadline),
      escalationOwner: metadata.escalationOwner,
      escalationState: metadata.escalationState,
      residualAssets: metadata.residualAssets,
      openedAt: observedAt,
    })
    .onConflictDoNothing({ target: recoveryCases.migrationId });

  if (!isNewEvidence) return;
  await transaction
    .update(recoveryCases)
    .set({
      policy: metadata.policy,
      reason: metadata.reason,
      nextPermittedAction: metadata.nextPermittedAction,
      actionDeadline: new Date(metadata.actionDeadline),
      escalationOwner: metadata.escalationOwner,
      escalationState: metadata.escalationState,
      residualAssets: metadata.residualAssets,
      updatedAt: observedAt,
    })
    .where(
      and(eq(recoveryCases.migrationId, record.migrationId), eq(recoveryCases.status, 'OPEN')),
    );
}

function recoveryMetadata(record: Evidence) {
  return recoveryOpeningPayloadSchema.parse(record.normalizedPayload);
}

export async function publishPendingOutbox(
  database: DebtShiftDatabase,
  publisher: OutboxPublisher,
  batchSize = 50,
  now = new Date(),
): Promise<number> {
  let published = 0;
  for (let index = 0; index < batchSize; index += 1) {
    const handled = await database.transaction(async (transaction) => {
      const [message] = await transaction
        .select()
        .from(outboxMessages)
        .where(
          and(
            inArray(outboxMessages.status, ['PENDING', 'FAILED_RETRYABLE']),
            lte(outboxMessages.availableAt, now),
          ),
        )
        .orderBy(asc(outboxMessages.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (message === undefined) return false;

      const [command] = await transaction
        .select({ status: commands.status })
        .from(commands)
        .where(eq(commands.commandId, message.commandId))
        .limit(1)
        .for('update');
      if (command === undefined) throw new Error('Outbox command disappeared while locked.');
      if (['CANCELLED', 'SUCCEEDED', 'FAILED_TERMINAL'].includes(command.status)) {
        await transaction
          .update(outboxMessages)
          .set({
            status: 'DEAD_LETTER',
            lastError: `Command is already terminal with status ${command.status}.`,
          })
          .where(eq(outboxMessages.outboxId, message.outboxId));
        return true;
      }

      const traceContext = traceContextCarrierSchema.optional().parse(message.payload.traceContext);
      const payload = { ...message.payload };
      delete payload.traceContext;
      const envelope: OutboxEnvelope = {
        outboxId: message.outboxId,
        commandId: message.commandId,
        topic: message.topic,
        partitionKey: message.partitionKey,
        payload,
        ...(traceContext === undefined ? {} : { traceContext }),
      };
      try {
        await publisher(envelope);
        await transaction
          .update(outboxMessages)
          .set({ status: 'PUBLISHED', publishedAt: now, lastError: null })
          .where(eq(outboxMessages.outboxId, message.outboxId));
        await transaction
          .update(commands)
          .set({ status: 'DISPATCHED', updatedAt: now })
          .where(
            and(
              eq(commands.commandId, message.commandId),
              inArray(commands.status, ['PENDING', 'FAILED_RETRYABLE']),
            ),
          );
      } catch (error) {
        const failure = error instanceof Error ? error.message : 'Unknown publication failure';
        await transaction
          .update(outboxMessages)
          .set({
            status: 'FAILED_RETRYABLE',
            publishAttempts: message.publishAttempts + 1,
            availableAt: new Date(now.getTime() + retryDelayMs(message.publishAttempts + 1)),
            lastError: failure.slice(0, 2_000),
          })
          .where(eq(outboxMessages.outboxId, message.outboxId));
      }
      return true;
    });
    if (!handled) break;
    published += 1;
  }
  return published;
}

function databaseEvidenceToDomain(row: typeof evidenceTable.$inferSelect): Evidence {
  return evidenceSchema.parse({
    evidenceId: row.evidenceId,
    migrationId: row.migrationId,
    type: row.type,
    schemaVersion: row.schemaVersion,
    provider: row.provider,
    network: row.network,
    ...(row.chainId === null ? {} : { chainId: Number(row.chainId) }),
    ...(row.blockNumber === null ? {} : { blockNumber: row.blockNumber }),
    ...(row.blockHash === null ? {} : { blockHash: row.blockHash }),
    ...(row.transactionHash === null ? {} : { transactionHash: row.transactionHash }),
    ...(row.logIndex === null ? {} : { logIndex: row.logIndex }),
    ...(row.providerReference === null ? {} : { providerReference: row.providerReference }),
    rawObservationHash: row.rawObservationHash,
    normalizedPayload: row.normalizedPayload,
    observedAt: row.observedAt.toISOString(),
    verificationState: row.verificationState,
    verificationMethod: row.verificationMethod,
    verifierVersion: row.verifierVersion,
    ...(row.supersedesEvidenceId === null
      ? {}
      : { supersedesEvidenceId: row.supersedesEvidenceId }),
  });
}

export async function listActiveFinalizedChainEvidence(
  database: DebtShiftDatabase,
  migrationId: string,
): Promise<readonly Evidence[]> {
  const records = await listActiveFinalizedEvidence(database, migrationId);
  return records.filter(
    (record) =>
      record.chainId !== undefined &&
      record.blockNumber !== undefined &&
      record.blockHash !== undefined,
  );
}

/**
 * Returns the non-superseded finalized evidence set used to build the terminal
 * receipt bundle. This deliberately includes provider/workflow evidence that
 * has no EVM block coordinates; the chain-only view above remains the input to
 * canonicality revalidation.
 */
export async function listActiveFinalizedEvidence(
  database: DebtShiftDatabase,
  migrationId: string,
): Promise<readonly Evidence[]> {
  const rows = await database
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.migrationId, migrationId));
  const records = rows.map(databaseEvidenceToDomain);
  const supersededEvidenceIds = new Set(
    records.flatMap((record) =>
      record.supersedesEvidenceId === undefined ? [] : [record.supersedesEvidenceId],
    ),
  );
  return records.filter(
    (record) =>
      record.verificationState === 'FINALIZED' && !supersededEvidenceIds.has(record.evidenceId),
  );
}

export async function enqueueCommandInTransaction(
  transaction: Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0],
  migrationId: string,
  command: PlannedCommand,
  traceContext?: TraceContextCarrier,
): Promise<string> {
  const commandId = hashCanonicalText(`debtshift.command.v1:${command.idempotencyKey}`);
  await insertCommandInTransaction(
    transaction,
    migrationId,
    command,
    commandId,
    hashCanonicalText(canonicalJson(command.payload)),
    traceContext,
  );
  return commandId;
}

async function insertCommandInTransaction(
  transaction: Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0],
  migrationId: string,
  command: PlannedCommand,
  commandId: string,
  payloadHash: string,
  traceContext?: TraceContextCarrier,
): Promise<void> {
  const inserted = await transaction
    .insert(commands)
    .values({
      commandId,
      migrationId,
      type: command.type,
      idempotencyKey: command.idempotencyKey,
      payload: command.payload,
      payloadHash,
    })
    .onConflictDoNothing({ target: commands.idempotencyKey })
    .returning({ commandId: commands.commandId });
  if (inserted.length === 0) return;

  const parsedTraceContext = traceContextCarrierSchema.optional().parse(traceContext);

  await transaction.insert(outboxMessages).values({
    commandId,
    topic: 'debtshift.commands.v1',
    partitionKey: migrationId,
    payload: {
      commandId,
      migrationId,
      type: command.type,
      ...(parsedTraceContext === undefined ? {} : { traceContext: parsedTraceContext }),
    },
  });
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 250 * 2 ** Math.min(attempt, 8));
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

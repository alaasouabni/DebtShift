import {
  assertAllowedPhaseTransition,
  deriveMigrationPhase,
  evidenceSchema,
  hashCanonicalText,
  phaseEvidenceFromRecords,
  type Evidence,
  type MigrationPhase,
} from '@debtshift/domain';
import { and, asc, eq, inArray, lte, max } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import {
  auditEvents,
  commands,
  evidence as evidenceTable,
  migrations,
  outboxMessages,
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
    | 'EXECUTE_RECOVERY';
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}

export interface OutboxEnvelope {
  readonly outboxId: string;
  readonly commandId: string;
  readonly topic: string;
  readonly partitionKey: string;
  readonly payload: Record<string, unknown>;
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
): Promise<string> {
  const commandId = hashCanonicalText(`debtshift.command.v1:${command.idempotencyKey}`);
  const payloadHash = hashCanonicalText(canonicalJson(command.payload));

  await database.transaction(async (transaction) => {
    await lockMigration(transaction, migrationId);
    await insertCommandInTransaction(transaction, migrationId, command, commandId, payloadHash);
  });
  return commandId;
}

export async function advanceMigrationWithEvidence(
  database: DebtShiftDatabase,
  record: Evidence,
  actor: string,
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

      await transaction
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
        })
        .onConflictDoNothing({ target: evidenceTable.evidenceId });

      const storedEvidence = await transaction
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.migrationId, parsedEvidence.migrationId));
      const normalized = storedEvidence.map(databaseEvidenceToDomain);
      const derivedPhase = deriveMigrationPhase(phaseEvidenceFromRecords(normalized));
      if (derivedPhase === migration.phase) return derivedPhase;
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

      const nextCommand = planNextCommand(migration.migrationId, derivedPhase);
      if (nextCommand !== undefined) {
        const commandId = hashCanonicalText(`debtshift.command.v1:${nextCommand.idempotencyKey}`);
        await insertCommandInTransaction(
          transaction,
          migration.migrationId,
          nextCommand,
          commandId,
          hashCanonicalText(canonicalJson(nextCommand.payload)),
        );
      }
      return derivedPhase;
    },
    { isolationLevel: 'serializable', accessMode: 'read write', deferrable: false },
  );
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

      const envelope: OutboxEnvelope = {
        outboxId: message.outboxId,
        commandId: message.commandId,
        topic: message.topic,
        partitionKey: message.partitionKey,
        payload: message.payload,
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
          .where(eq(commands.commandId, message.commandId));
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
  });
}

export async function enqueueCommandInTransaction(
  transaction: Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0],
  migrationId: string,
  command: PlannedCommand,
): Promise<string> {
  const commandId = hashCanonicalText(`debtshift.command.v1:${command.idempotencyKey}`);
  await insertCommandInTransaction(
    transaction,
    migrationId,
    command,
    commandId,
    hashCanonicalText(canonicalJson(command.payload)),
  );
  return commandId;
}

async function insertCommandInTransaction(
  transaction: Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0],
  migrationId: string,
  command: PlannedCommand,
  commandId: string,
  payloadHash: string,
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

  await transaction.insert(outboxMessages).values({
    commandId,
    topic: 'debtshift.commands.v1',
    partitionKey: migrationId,
    payload: { commandId, migrationId, type: command.type },
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

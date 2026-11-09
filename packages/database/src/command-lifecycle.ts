import { and, eq, lt } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import { commands, evidence } from './schema.js';

export type DurableCommand = typeof commands.$inferSelect;

export async function beginCommand(
  database: DebtShiftDatabase,
  commandId: string,
  now = new Date(),
): Promise<DurableCommand | undefined> {
  return database.transaction(async (transaction) => {
    const [command] = await transaction
      .select()
      .from(commands)
      .where(eq(commands.commandId, commandId))
      .limit(1)
      .for('update');
    if (command === undefined) throw new Error(`Unknown command ${commandId}.`);
    if (['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(command.status)) {
      return undefined;
    }
    if (command.status === 'RUNNING') return undefined;

    const [running] = await transaction
      .update(commands)
      .set({
        status: 'RUNNING',
        logicalAttempt: command.logicalAttempt + 1,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(commands.commandId, commandId))
      .returning();
    return running;
  });
}

export async function completeCommand(
  database: DebtShiftDatabase,
  commandId: string,
  now = new Date(),
): Promise<void> {
  await database
    .update(commands)
    .set({ status: 'SUCCEEDED', lastError: null, updatedAt: now })
    .where(eq(commands.commandId, commandId));
}

export async function failCommand(
  database: DebtShiftDatabase,
  commandId: string,
  error: unknown,
  retryable: boolean,
  now = new Date(),
): Promise<void> {
  const message = error instanceof Error ? error.message : 'Unknown command failure';
  await database
    .update(commands)
    .set({
      status: retryable ? 'FAILED_RETRYABLE' : 'FAILED_TERMINAL',
      lastError: message.slice(0, 2_000),
      updatedAt: now,
    })
    .where(eq(commands.commandId, commandId));
}

export async function hasFinalizedEvidence(
  database: DebtShiftDatabase,
  migrationId: string,
  evidenceType: string,
): Promise<boolean> {
  const [record] = await database
    .select({ evidenceId: evidence.evidenceId })
    .from(evidence)
    .where(
      and(
        eq(evidence.migrationId, migrationId),
        eq(evidence.type, evidenceType),
        eq(evidence.verificationState, 'FINALIZED'),
      ),
    )
    .limit(1);
  return record !== undefined;
}

export async function recoverStaleCommands(
  database: DebtShiftDatabase,
  staleBefore: Date,
  now = new Date(),
): Promise<number> {
  const recovered = await database
    .update(commands)
    .set({
      status: 'FAILED_RETRYABLE',
      lastError: 'Worker lease expired; evidence must be checked before retry.',
      updatedAt: now,
    })
    .where(and(eq(commands.status, 'RUNNING'), lt(commands.updatedAt, staleBefore)))
    .returning({ commandId: commands.commandId });
  return recovered.length;
}

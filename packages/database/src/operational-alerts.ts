import { hashCanonicalText } from '@debtshift/domain';
import { eq, inArray, notInArray } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import {
  commands,
  ledgerEntries,
  migrations,
  operationalAlerts,
  recoveryCases,
  transportLegs,
} from './schema.js';

export interface OperationalAlertPolicy {
  readonly deadlineLeadMs: number;
  readonly staleMigrationMs: number;
  readonly staleRecoveryMs: number;
}

export interface OperationalAlertCondition {
  readonly alertId: string;
  readonly migrationId: string;
  readonly type: OperationalAlertType;
  readonly severity: 'WARNING' | 'CRITICAL';
  readonly deduplicationKey: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export interface OperationalAlertScanReport {
  readonly active: readonly OperationalAlertCondition[];
  readonly openedCount: number;
  readonly resolvedCount: number;
}

const managedAlertTypes = [
  'EXECUTION_DEADLINE_APPROACHING',
  'STALE_MIGRATION',
  'STALE_RECOVERY',
  'UNKNOWN_TRANSPORT_CUSTODY',
  'COMMAND_FAILED_TERMINAL',
  'SETTLED_LEDGER_MISSING',
] as const;

export type OperationalAlertType = (typeof managedAlertTypes)[number];

const terminalPhases = ['COMPLETED', 'FAILED_SAFE', 'REQUOTE_REQUIRED', 'EXPIRED'] satisfies Array<
  (typeof migrations.phase.enumValues)[number]
>;

export async function scanOperationalAlerts(
  database: DebtShiftDatabase,
  policy: OperationalAlertPolicy,
  now = new Date(),
): Promise<OperationalAlertScanReport> {
  assertPolicy(policy);
  const activeMigrations = await database
    .select({
      migrationId: migrations.migrationId,
      phase: migrations.phase,
      expiresAt: migrations.expiresAt,
      updatedAt: migrations.updatedAt,
    })
    .from(migrations)
    .where(notInArray(migrations.phase, terminalPhases));
  const activeIds = new Set(activeMigrations.map(({ migrationId }) => migrationId));
  const conditions: OperationalAlertCondition[] = [];
  const deadlineThreshold = now.getTime() + policy.deadlineLeadMs;
  const staleMigrationThreshold = now.getTime() - policy.staleMigrationMs;

  for (const migration of activeMigrations) {
    if (
      migration.expiresAt.getTime() <= deadlineThreshold &&
      migration.phase !== 'SETTLED' &&
      migration.phase !== 'RECOVERY'
    ) {
      const expired = migration.expiresAt.getTime() <= now.getTime();
      conditions.push(
        condition(
          migration.migrationId,
          'EXECUTION_DEADLINE_APPROACHING',
          expired ? 'CRITICAL' : 'WARNING',
          expired
            ? `Migration ${migration.migrationId} crossed its signed execution deadline.`
            : `Migration ${migration.migrationId} is approaching its signed execution deadline.`,
          {
            phase: migration.phase,
            expiresAt: migration.expiresAt.toISOString(),
            remainingMs: migration.expiresAt.getTime() - now.getTime(),
          },
        ),
      );
    }
    if (migration.updatedAt.getTime() <= staleMigrationThreshold) {
      conditions.push(
        condition(
          migration.migrationId,
          'STALE_MIGRATION',
          'WARNING',
          `Migration ${migration.migrationId} has not advanced within the configured window.`,
          {
            phase: migration.phase,
            updatedAt: migration.updatedAt.toISOString(),
            staleForMs: now.getTime() - migration.updatedAt.getTime(),
          },
        ),
      );
    }
  }

  if (activeIds.size > 0) {
    const [recoveries, legs, failedCommands, ledgerRows] = await Promise.all([
      database.select().from(recoveryCases).where(eq(recoveryCases.status, 'OPEN')),
      database.select().from(transportLegs).where(eq(transportLegs.providerState, 'UNKNOWN')),
      database.select().from(commands).where(eq(commands.status, 'FAILED_TERMINAL')),
      database.select({ migrationId: ledgerEntries.migrationId }).from(ledgerEntries),
    ]);
    const ledgerMigrationIds = new Set(ledgerRows.map(({ migrationId }) => migrationId));
    for (const recovery of recoveries) {
      if (
        activeIds.has(recovery.migrationId) &&
        recovery.updatedAt.getTime() <= now.getTime() - policy.staleRecoveryMs
      ) {
        conditions.push(
          condition(
            recovery.migrationId,
            'STALE_RECOVERY',
            'CRITICAL',
            `Recovery for ${recovery.migrationId} exceeded the configured operator window.`,
            {
              recoveryId: recovery.recoveryId,
              reason: recovery.reason,
              policy: recovery.policy,
              updatedAt: recovery.updatedAt.toISOString(),
              staleForMs: now.getTime() - recovery.updatedAt.getTime(),
            },
            recovery.recoveryId,
          ),
        );
      }
    }
    for (const leg of legs) {
      if (!activeIds.has(leg.migrationId)) continue;
      conditions.push(
        condition(
          leg.migrationId,
          'UNKNOWN_TRANSPORT_CUSTODY',
          'CRITICAL',
          `Transport custody for ${leg.migrationId} is in an unknown provider state.`,
          {
            provider: leg.provider,
            legIndex: leg.legIndex,
            providerReference: leg.providerReference,
            observationCount: leg.observationCount,
            updatedAt: leg.updatedAt.toISOString(),
          },
          String(leg.legIndex),
        ),
      );
    }
    for (const command of failedCommands) {
      if (!activeIds.has(command.migrationId)) continue;
      conditions.push(
        condition(
          command.migrationId,
          'COMMAND_FAILED_TERMINAL',
          'CRITICAL',
          `Command ${command.type} failed terminally for ${command.migrationId}.`,
          {
            commandId: command.commandId,
            commandType: command.type,
            logicalAttempt: command.logicalAttempt,
            lastError: command.lastError,
            updatedAt: command.updatedAt.toISOString(),
          },
          command.commandId,
        ),
      );
    }
    for (const migration of activeMigrations) {
      if (migration.phase === 'SETTLED' && !ledgerMigrationIds.has(migration.migrationId)) {
        conditions.push(
          condition(
            migration.migrationId,
            'SETTLED_LEDGER_MISSING',
            'CRITICAL',
            `Settled migration ${migration.migrationId} has no durable ledger entries.`,
            { phase: migration.phase, updatedAt: migration.updatedAt.toISOString() },
          ),
        );
      }
    }
  }

  const uniqueConditions = [
    ...new Map(conditions.map((item) => [item.deduplicationKey, item])).values(),
  ].sort((left, right) => left.deduplicationKey.localeCompare(right.deduplicationKey));
  return persistAlertConditions(database, uniqueConditions, now);
}

async function persistAlertConditions(
  database: DebtShiftDatabase,
  conditions: readonly OperationalAlertCondition[],
  now: Date,
): Promise<OperationalAlertScanReport> {
  return database.transaction(async (transaction) => {
    const existing = await transaction
      .select({
        alertId: operationalAlerts.alertId,
        deduplicationKey: operationalAlerts.deduplicationKey,
        status: operationalAlerts.status,
      })
      .from(operationalAlerts)
      .where(inArray(operationalAlerts.type, managedAlertTypes));
    const existingByKey = new Map(existing.map((alert) => [alert.deduplicationKey, alert]));
    const desiredKeys = new Set(conditions.map(({ deduplicationKey }) => deduplicationKey));
    const toResolve = existing.filter(
      (alert) => alert.status === 'OPEN' && !desiredKeys.has(alert.deduplicationKey),
    );

    for (const alert of conditions) {
      await transaction
        .insert(operationalAlerts)
        .values({
          ...alert,
          status: 'OPEN',
          firstObservedAt: now,
          lastObservedAt: now,
        })
        .onConflictDoUpdate({
          target: operationalAlerts.deduplicationKey,
          set: {
            severity: alert.severity,
            status: 'OPEN',
            message: alert.message,
            details: alert.details,
            lastObservedAt: now,
            resolvedAt: null,
            updatedAt: now,
          },
        });
    }
    if (toResolve.length > 0) {
      await transaction
        .update(operationalAlerts)
        .set({ status: 'RESOLVED', resolvedAt: now, updatedAt: now })
        .where(
          inArray(
            operationalAlerts.alertId,
            toResolve.map(({ alertId }) => alertId),
          ),
        );
    }

    return {
      active: conditions,
      openedCount: conditions.filter(
        (alert) => existingByKey.get(alert.deduplicationKey)?.status !== 'OPEN',
      ).length,
      resolvedCount: toResolve.length,
    };
  });
}

function condition(
  migrationId: string,
  type: OperationalAlertType,
  severity: OperationalAlertCondition['severity'],
  message: string,
  details: Record<string, unknown>,
  instanceKey?: string,
): OperationalAlertCondition {
  const deduplicationKey = [type, migrationId, instanceKey].filter(Boolean).join(':');
  return {
    alertId: hashCanonicalText(`debtshift.operational-alert.v1:${deduplicationKey}`),
    migrationId,
    type,
    severity,
    deduplicationKey,
    message,
    details,
  };
}

function assertPolicy(policy: OperationalAlertPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Operational alert policy ${name} must be a positive integer.`);
    }
  }
}

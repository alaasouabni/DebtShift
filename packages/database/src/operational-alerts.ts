import {
  hashCanonicalText,
  ledgerReconciliationSchema,
  type LedgerReconciliation,
} from '@debtshift/domain';
import { and, eq, inArray, notInArray } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import {
  commands,
  evidence as evidenceTable,
  ledgerEntries,
  liquidityReservations,
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
  'RESERVATION_SHORTFALL',
  'CHAIN_RECEIPT_MISMATCH',
  'ACCOUNTING_IMBALANCE',
  'FEASIBILITY_EXPIRED',
  'SUPPLEMENTARY_FUNDING_MISSING',
  'CAPACITY_DETERIORATION',
  'SOLVER_EXPOSURE_OUTSTANDING',
  'POST_DELIVERY_PAYOUT_FAILURE',
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
    const activeMigrationIds = [...activeIds];
    const [recoveries, legs, failedCommands, ledgerRows, evidenceRows, reservations] =
      await Promise.all([
        database
          .select()
          .from(recoveryCases)
          .where(
            and(
              eq(recoveryCases.status, 'OPEN'),
              inArray(recoveryCases.migrationId, activeMigrationIds),
            ),
          ),
        database
          .select()
          .from(transportLegs)
          .where(
            and(
              eq(transportLegs.providerState, 'UNKNOWN'),
              inArray(transportLegs.migrationId, activeMigrationIds),
            ),
          ),
        database
          .select()
          .from(commands)
          .where(
            and(
              inArray(commands.status, ['FAILED_RETRYABLE', 'FAILED_TERMINAL']),
              inArray(commands.migrationId, activeMigrationIds),
            ),
          ),
        database
          .select()
          .from(ledgerEntries)
          .where(inArray(ledgerEntries.migrationId, activeMigrationIds)),
        database
          .select()
          .from(evidenceTable)
          .where(inArray(evidenceTable.migrationId, activeMigrationIds)),
        database
          .select()
          .from(liquidityReservations)
          .where(inArray(liquidityReservations.migrationId, activeMigrationIds)),
      ]);
    const ledgerMigrationIds = new Set(ledgerRows.map(({ migrationId }) => migrationId));
    const evidenceByMigration = groupByMigration(evidenceRows);
    const ledgerByMigration = groupByMigration(ledgerRows);
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
      if (command.status === 'FAILED_TERMINAL') {
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

    for (const migration of activeMigrations) {
      const migrationEvidence = evidenceByMigration.get(migration.migrationId) ?? [];
      const supersededIds = new Set(
        migrationEvidence
          .filter(
            (record) =>
              record.verificationState === 'RETRACTED' || record.verificationState === 'REJECTED',
          )
          .map(({ supersedesEvidenceId }) => supersedesEvidenceId)
          .filter((evidenceId): evidenceId is string => evidenceId !== null),
      );
      const activeFinalizedEvidence = migrationEvidence.filter(
        (record) =>
          record.verificationState === 'FINALIZED' && !supersededIds.has(record.evidenceId),
      );

      addReceiptMismatchAlerts(conditions, migration.migrationId, migrationEvidence);
      addReservationShortfallAlert(
        conditions,
        migration.migrationId,
        reservations,
        activeFinalizedEvidence,
      );
      addAccountingImbalanceAlerts(
        conditions,
        migration.migrationId,
        activeFinalizedEvidence,
        ledgerByMigration.get(migration.migrationId) ?? [],
      );
      addFeasibilityAlerts(conditions, migration, activeFinalizedEvidence, deadlineThreshold, now);
      addCapacityDeteriorationAlert(conditions, migration.migrationId, activeFinalizedEvidence);
      addSolverExposureAlert(conditions, migration, activeFinalizedEvidence, now, policy);
      addPostDeliveryPayoutAlerts(
        conditions,
        migration.migrationId,
        activeFinalizedEvidence,
        failedCommands,
      );
    }
  }

  const uniqueConditions = [
    ...new Map(conditions.map((item) => [item.deduplicationKey, item])).values(),
  ].sort((left, right) => left.deduplicationKey.localeCompare(right.deduplicationKey));
  return persistAlertConditions(database, uniqueConditions, now);
}

type EvidenceRow = typeof evidenceTable.$inferSelect;
type LedgerRow = typeof ledgerEntries.$inferSelect;
type ReservationRow = typeof liquidityReservations.$inferSelect;
type MigrationRow = typeof migrations.$inferSelect;
type ActiveMigrationRow = Pick<MigrationRow, 'migrationId' | 'phase' | 'expiresAt' | 'updatedAt'>;
type CommandRow = typeof commands.$inferSelect;

function addReceiptMismatchAlerts(
  conditions: OperationalAlertCondition[],
  migrationId: string,
  records: readonly EvidenceRow[],
): void {
  for (const record of records) {
    if (
      (record.verificationState !== 'RETRACTED' && record.verificationState !== 'REJECTED') ||
      (record.chainId === null && record.transactionHash === null)
    ) {
      continue;
    }
    conditions.push(
      condition(
        migrationId,
        'CHAIN_RECEIPT_MISMATCH',
        'CRITICAL',
        `Chain evidence ${record.evidenceId} was ${record.verificationState.toLowerCase()} for ${migrationId}.`,
        {
          evidenceId: record.evidenceId,
          evidenceType: record.type,
          verificationState: record.verificationState,
          supersedesEvidenceId: record.supersedesEvidenceId,
          chainId: record.chainId,
          transactionHash: record.transactionHash,
          blockNumber: record.blockNumber,
          blockHash: record.blockHash,
          observedAt: record.observedAt.toISOString(),
        },
        record.evidenceId,
      ),
    );
  }
}

function addReservationShortfallAlert(
  conditions: OperationalAlertCondition[],
  migrationId: string,
  reservations: readonly ReservationRow[],
  records: readonly EvidenceRow[],
): void {
  const reservation = reservations.find(
    (candidate) =>
      candidate.migrationId === migrationId &&
      (candidate.status === 'ACTIVE' || candidate.status === 'DRAWN'),
  );
  if (reservation === undefined) return;
  const proof = latestEvidence(records, 'LIQUIDITY_RESERVATION');
  const requiredUnits = BigInt(reservation.principalUnits) + BigInt(reservation.feeCapUnits);
  const observedUnits = unsignedBigInt(proof?.normalizedPayload, 'recoveryReserveUnits');
  if (observedUnits !== undefined && observedUnits >= requiredUnits) return;
  conditions.push(
    condition(
      migrationId,
      'RESERVATION_SHORTFALL',
      'CRITICAL',
      `Migration ${migrationId} does not have evidence for its full recovery reserve.`,
      {
        reservationId: reservation.reservationId,
        reservationStatus: reservation.status,
        principalUnits: reservation.principalUnits,
        feeCapUnits: reservation.feeCapUnits,
        requiredRecoveryReserveUnits: requiredUnits.toString(),
        observedRecoveryReserveUnits: observedUnits?.toString() ?? null,
        reservationEvidenceId: proof?.evidenceId ?? null,
      },
    ),
  );
}

function addAccountingImbalanceAlerts(
  conditions: OperationalAlertCondition[],
  migrationId: string,
  records: readonly EvidenceRow[],
  persistedRows: readonly LedgerRow[],
): void {
  for (const record of records.filter(({ type }) => type === 'LEDGER_RECONCILIATION')) {
    const payload = asRecord(record.normalizedPayload);
    const parsed = ledgerReconciliationSchema.safeParse(payload?.['ledger']);
    const mismatchReasons: string[] = [];
    if (!parsed.success) {
      mismatchReasons.push('LEDGER_RECONCILIATION_PAYLOAD_INVALID');
    } else if (!persistedLedgerMatches(parsed.data, persistedRows)) {
      mismatchReasons.push('PERSISTED_LEDGER_ROWS_DIFFER_FROM_RECONCILIATION');
    }
    if (mismatchReasons.length === 0) continue;
    conditions.push(
      condition(
        migrationId,
        'ACCOUNTING_IMBALANCE',
        'CRITICAL',
        `Ledger reconciliation ${record.evidenceId} is inconsistent for ${migrationId}.`,
        {
          evidenceId: record.evidenceId,
          mismatchReasons,
          persistedEntryCount: persistedRows.length,
          expectedEntryCount: parsed.success ? parsed.data.entries.length : null,
        },
        record.evidenceId,
      ),
    );
  }
}

function addFeasibilityAlerts(
  conditions: OperationalAlertCondition[],
  migration: ActiveMigrationRow,
  records: readonly EvidenceRow[],
  deadlineThreshold: number,
  now: Date,
): void {
  const feasibility = latestEvidence(records, 'FINANCING_FEASIBILITY');
  if (feasibility === undefined) return;
  const validUntil = unsignedBigInt(feasibility.normalizedPayload, 'validUntil');
  if (
    validUntil !== undefined &&
    Number(validUntil * 1_000n) <= deadlineThreshold &&
    migration.phase !== 'SETTLED' &&
    migration.phase !== 'RECOVERY'
  ) {
    const remainingMs = Number(validUntil * 1_000n) - now.getTime();
    conditions.push(
      condition(
        migration.migrationId,
        'FEASIBILITY_EXPIRED',
        remainingMs <= 0 ? 'CRITICAL' : 'WARNING',
        remainingMs <= 0
          ? `Financing feasibility expired for ${migration.migrationId}.`
          : `Financing feasibility is approaching expiry for ${migration.migrationId}.`,
        {
          evidenceId: feasibility.evidenceId,
          validUntil: validUntil.toString(),
          remainingMs,
          phase: migration.phase,
        },
      ),
    );
  }

  const payload = asRecord(feasibility.normalizedPayload);
  const expectedFunding = Array.isArray(payload?.['externalFunding'])
    ? payload['externalFunding']
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
  if (expectedFunding.length === 0) return;
  const finalizedFunding = new Map(
    records
      .filter(({ type }) => type === 'SUPPLEMENTARY_FUNDING')
      .map((record) => [record.evidenceId, record] as const),
  );
  const missingEvidenceIds: string[] = [];
  let observedUnits = 0n;
  for (const expected of expectedFunding) {
    const evidenceId = textValue(expected['evidenceId']);
    const expectedExpiry = unsignedBigInt(expected, 'expiresAt');
    const record = evidenceId === undefined ? undefined : finalizedFunding.get(evidenceId);
    const recordExpiry = unsignedBigInt(record?.normalizedPayload, 'expiresAt');
    if (
      evidenceId === undefined ||
      record === undefined ||
      (expectedExpiry !== undefined && expectedExpiry * 1_000n <= BigInt(now.getTime())) ||
      (recordExpiry !== undefined && recordExpiry * 1_000n <= BigInt(now.getTime()))
    ) {
      missingEvidenceIds.push(evidenceId ?? 'MALFORMED_FUNDING_REFERENCE');
      continue;
    }
    observedUnits += unsignedBigInt(record.normalizedPayload, 'amountUnits') ?? 0n;
  }
  const expectedUnits = unsignedBigInt(payload, 'confirmedExternalFundingUnits');
  if (missingEvidenceIds.length === 0 && expectedUnits === observedUnits) return;
  conditions.push(
    condition(
      migration.migrationId,
      'SUPPLEMENTARY_FUNDING_MISSING',
      'CRITICAL',
      `Finalized supplementary funding is incomplete for ${migration.migrationId}.`,
      {
        feasibilityEvidenceId: feasibility.evidenceId,
        missingEvidenceIds,
        expectedFundingUnits: expectedUnits?.toString() ?? null,
        observedFundingUnits: observedUnits.toString(),
      },
    ),
  );
}

function addCapacityDeteriorationAlert(
  conditions: OperationalAlertCondition[],
  migrationId: string,
  records: readonly EvidenceRow[],
): void {
  const record = latestEvidence(records, 'FINANCING_REVALIDATION');
  if (record === undefined) return;
  const payload = asRecord(record.normalizedPayload);
  const revalidation = asRecord(payload?.['financingRevalidation']) ?? payload;
  const shortfall = unsignedBigInt(revalidation, 'fundingShortfallUnits') ?? 0n;
  const policyFailureCodes = Array.isArray(revalidation?.['policyFailureCodes'])
    ? revalidation['policyFailureCodes'].filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  if (shortfall === 0n && policyFailureCodes.length === 0) return;
  conditions.push(
    condition(
      migrationId,
      'CAPACITY_DETERIORATION',
      'CRITICAL',
      `Fresh destination capacity or policy checks failed for ${migrationId}.`,
      {
        evidenceId: record.evidenceId,
        checkpoint: textValue(revalidation?.['checkpoint']) ?? null,
        fundingShortfallUnits: shortfall.toString(),
        policyFailureCodes,
        maximumSafeBorrowingCapacityUnits:
          textValue(revalidation?.['maximumSafeBorrowingCapacityUnits']) ?? null,
        requiredDestinationBorrowUnits:
          textValue(revalidation?.['requiredDestinationBorrowUnits']) ?? null,
      },
    ),
  );
}

function addSolverExposureAlert(
  conditions: OperationalAlertCondition[],
  migration: ActiveMigrationRow,
  records: readonly EvidenceRow[],
  now: Date,
  policy: OperationalAlertPolicy,
): void {
  const exposurePhases = new Set([
    'SOURCE_CLOSED',
    'ROUTING',
    'DEST_FUNDED',
    'TARGET_OPEN',
    'RECOVERY',
  ]);
  if (
    !exposurePhases.has(migration.phase) ||
    latestEvidence(records, 'SOURCE_CLOSE') === undefined ||
    latestEvidence(records, 'LIQUIDITY_SETTLEMENT') !== undefined
  ) {
    return;
  }
  const revalidationEvidence = latestEvidence(records, 'FINANCING_REVALIDATION');
  const revalidationPayload = asRecord(revalidationEvidence?.normalizedPayload);
  const revalidation =
    asRecord(revalidationPayload?.['financingRevalidation']) ?? revalidationPayload;
  const feasibility = asRecord(latestEvidence(records, 'FINANCING_FEASIBILITY')?.normalizedPayload);
  const principal =
    textValue(revalidation?.['solverPrincipalUnits']) ??
    textValue(feasibility?.['solverPrincipalUnits']);
  const fee =
    textValue(revalidation?.['solverFeeUnits']) ?? textValue(feasibility?.['solverFeeUnits']);
  const staleForMs = now.getTime() - migration.updatedAt.getTime();
  conditions.push(
    condition(
      migration.migrationId,
      'SOLVER_EXPOSURE_OUTSTANDING',
      migration.phase === 'RECOVERY' || staleForMs >= policy.staleMigrationMs
        ? 'CRITICAL'
        : 'WARNING',
      `Solver principal and fee remain unsettled for ${migration.migrationId}.`,
      {
        phase: migration.phase,
        solverPrincipalUnits: principal ?? null,
        solverFeeUnits: fee ?? null,
        sourceCloseEvidenceId: latestEvidence(records, 'SOURCE_CLOSE')?.evidenceId,
        staleForMs,
      },
    ),
  );
}

function addPostDeliveryPayoutAlerts(
  conditions: OperationalAlertCondition[],
  migrationId: string,
  records: readonly EvidenceRow[],
  failedCommands: readonly CommandRow[],
): void {
  const delivery = latestEvidence(records, 'TRANSPORT_DESTINATION');
  if (delivery === undefined) return;
  for (const command of failedCommands) {
    if (command.migrationId !== migrationId || command.type !== 'OPEN_TARGET') continue;
    conditions.push(
      condition(
        migrationId,
        'POST_DELIVERY_PAYOUT_FAILURE',
        command.status === 'FAILED_TERMINAL' ? 'CRITICAL' : 'WARNING',
        `Atomic target opening and solver payout failed after collateral delivery for ${migrationId}.`,
        {
          deliveryEvidenceId: delivery.evidenceId,
          deliveryTransactionHash: delivery.transactionHash,
          commandId: command.commandId,
          commandStatus: command.status,
          logicalAttempt: command.logicalAttempt,
          lastError: command.lastError,
          updatedAt: command.updatedAt.toISOString(),
        },
        command.commandId,
      ),
    );
  }
}

function latestEvidence(records: readonly EvidenceRow[], type: string): EvidenceRow | undefined {
  return records
    .filter((record) => record.type === type)
    .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime())[0];
}

function persistedLedgerMatches(
  reconciliation: LedgerReconciliation,
  persistedRows: readonly LedgerRow[],
): boolean {
  if (reconciliation.entries.length !== persistedRows.length) return false;
  const rowsByComponent = new Map(persistedRows.map((row) => [row.componentId, row]));
  return reconciliation.entries.every((entry) => {
    const row = rowsByComponent.get(entry.componentId);
    return (
      row !== undefined &&
      row.entryId === entry.entryId &&
      row.evidenceId === entry.evidenceId &&
      row.sequence === entry.sequence &&
      row.componentCode === entry.componentCode &&
      row.basis === entry.basis &&
      String(row.chainId) === String(entry.chainId) &&
      row.token.toLowerCase() === entry.token.toLowerCase() &&
      row.amountUnits === entry.amountUnits &&
      row.debitParty === entry.debitParty &&
      row.creditParty === entry.creditParty &&
      row.category === entry.category &&
      row.transactionReference === (entry.transactionReference ?? null)
    );
  });
}

function groupByMigration<T extends { readonly migrationId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const current = grouped.get(row.migrationId) ?? [];
    current.push(row);
    grouped.set(row.migrationId, current);
  }
  return grouped;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function unsignedBigInt(value: unknown, key: string): bigint | undefined {
  const record = asRecord(value);
  const raw = record?.[key];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  return BigInt(raw);
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

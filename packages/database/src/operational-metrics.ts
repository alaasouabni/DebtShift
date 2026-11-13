import { count, eq, sum } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import {
  actionFinalityEnum,
  auditEvents,
  chainActions,
  commands,
  commandStatusEnum,
  evidence,
  evidenceStateEnum,
  ledgerEntries,
  liquidityReservations,
  migrationPhaseEnum,
  migrations,
  operationalAlerts,
  operationalAlertSeverityEnum,
  operationalAlertStatusEnum,
  outboxMessages,
  outboxStatusEnum,
  recoveryCases,
  reservationStatusEnum,
  transportLegs,
} from './schema.js';

export const phaseAgeBucketsSeconds = [5, 30, 60, 300, 900, 3_600, 21_600, 86_400] as const;

export interface OperationalMetricCount {
  readonly labels: Readonly<Record<string, string>>;
  readonly count: number;
}

export interface MigrationPhaseMetric {
  readonly phase: (typeof migrationPhaseEnum.enumValues)[number];
  readonly count: number;
  readonly ageSecondsSum: number;
  readonly ageSecondsBuckets: readonly number[];
}

export interface OperationalAmountMetric extends OperationalMetricCount {
  readonly amountUnits: string;
}

export interface OperationalReservationMetric extends OperationalAmountMetric {
  readonly feeCapUnits: string;
}

export interface OperationalMetricsSnapshot {
  readonly collectedAt: Date;
  readonly migrationPhases: readonly MigrationPhaseMetric[];
  readonly commands: readonly OperationalMetricCount[];
  readonly commandAttempts: readonly OperationalMetricCount[];
  readonly evidence: readonly OperationalMetricCount[];
  readonly chainActions: readonly OperationalMetricCount[];
  readonly transportLegs: readonly OperationalMetricCount[];
  readonly reservations: readonly OperationalReservationMetric[];
  readonly recoveries: readonly OperationalMetricCount[];
  readonly maximumOpenRecoveryAgeSeconds: number;
  readonly alerts: readonly OperationalMetricCount[];
  readonly outbox: readonly OperationalMetricCount[];
  readonly ledger: readonly OperationalAmountMetric[];
  readonly phaseTransitions: readonly OperationalMetricCount[];
}

export async function collectOperationalMetrics(
  database: DebtShiftDatabase,
  now = new Date(),
): Promise<OperationalMetricsSnapshot> {
  const [
    migrationRows,
    commandRows,
    evidenceRows,
    chainActionRows,
    transportRows,
    reservationRows,
    recoveryRows,
    alertRows,
    outboxRows,
    ledgerRows,
    transitionRows,
  ] = await Promise.all([
    database.select({ phase: migrations.phase, updatedAt: migrations.updatedAt }).from(migrations),
    database
      .select({
        type: commands.type,
        status: commands.status,
        count: count(),
        attempts: sum(commands.logicalAttempt),
      })
      .from(commands)
      .groupBy(commands.type, commands.status),
    database
      .select({ type: evidence.type, state: evidence.verificationState, count: count() })
      .from(evidence)
      .groupBy(evidence.type, evidence.verificationState),
    database
      .select({
        actionType: chainActions.actionType,
        finality: chainActions.finality,
        count: count(),
      })
      .from(chainActions)
      .groupBy(chainActions.actionType, chainActions.finality),
    database
      .select({
        provider: transportLegs.provider,
        state: transportLegs.providerState,
        count: count(),
      })
      .from(transportLegs)
      .groupBy(transportLegs.provider, transportLegs.providerState),
    database
      .select({
        status: liquidityReservations.status,
        count: count(),
        principalUnits: sum(liquidityReservations.principalUnits),
        feeCapUnits: sum(liquidityReservations.feeCapUnits),
      })
      .from(liquidityReservations)
      .groupBy(liquidityReservations.status),
    database
      .select({ status: recoveryCases.status, openedAt: recoveryCases.openedAt, count: count() })
      .from(recoveryCases)
      .groupBy(recoveryCases.status, recoveryCases.openedAt),
    database
      .select({
        type: operationalAlerts.type,
        severity: operationalAlerts.severity,
        status: operationalAlerts.status,
        count: count(),
      })
      .from(operationalAlerts)
      .groupBy(operationalAlerts.type, operationalAlerts.severity, operationalAlerts.status),
    database
      .select({ status: outboxMessages.status, count: count() })
      .from(outboxMessages)
      .groupBy(outboxMessages.status),
    database
      .select({
        category: ledgerEntries.category,
        count: count(),
        amountUnits: sum(ledgerEntries.amountUnits),
      })
      .from(ledgerEntries)
      .groupBy(ledgerEntries.category),
    database
      .select({ phase: auditEvents.phase, count: count() })
      .from(auditEvents)
      .where(eq(auditEvents.type, 'MIGRATION_PHASE_ADVANCED'))
      .groupBy(auditEvents.phase),
  ]);

  const phaseAges = new Map<string, number[]>();
  for (const phase of migrationPhaseEnum.enumValues) phaseAges.set(phase, []);
  for (const row of migrationRows) {
    phaseAges.get(row.phase)?.push(Math.max(0, (now.getTime() - row.updatedAt.getTime()) / 1_000));
  }

  const migrationPhases = migrationPhaseEnum.enumValues.map((phase) => {
    const ages = phaseAges.get(phase) ?? [];
    return {
      phase,
      count: ages.length,
      ageSecondsSum: ages.reduce((total, age) => total + age, 0),
      ageSecondsBuckets: phaseAgeBucketsSeconds.map(
        (upperBound) => ages.filter((age) => age <= upperBound).length,
      ),
    };
  });

  const recoveriesByStatus = new Map<string, number>();
  let maximumOpenRecoveryAgeSeconds = 0;
  for (const row of recoveryRows) {
    recoveriesByStatus.set(row.status, (recoveriesByStatus.get(row.status) ?? 0) + row.count);
    if (row.status === 'OPEN') {
      maximumOpenRecoveryAgeSeconds = Math.max(
        maximumOpenRecoveryAgeSeconds,
        Math.max(0, (now.getTime() - row.openedAt.getTime()) / 1_000),
      );
    }
  }

  return {
    collectedAt: now,
    migrationPhases,
    commands: fillCountMatrix(
      commandRows.map((row) => ({
        labels: { type: row.type, status: row.status },
        count: row.count,
      })),
      'status',
      commandStatusEnum.enumValues,
    ),
    commandAttempts: aggregateCounts(
      commandRows.map((row) => ({
        labels: { type: row.type },
        count: numericCount(row.attempts),
      })),
    ),
    evidence: fillCountMatrix(
      evidenceRows.map((row) => ({
        labels: { type: row.type, state: row.state },
        count: row.count,
      })),
      'state',
      evidenceStateEnum.enumValues,
    ),
    chainActions: fillCountMatrix(
      chainActionRows.map((row) => ({
        labels: { action_type: row.actionType, finality: row.finality },
        count: row.count,
      })),
      'finality',
      actionFinalityEnum.enumValues,
    ),
    transportLegs: transportRows.map((row) => ({
      labels: { provider: row.provider, state: row.state },
      count: row.count,
    })),
    reservations: reservationStatusEnum.enumValues.map((status) => {
      const row = reservationRows.find((candidate) => candidate.status === status);
      return {
        labels: { status },
        count: row?.count ?? 0,
        amountUnits: numericAmount(row?.principalUnits),
        feeCapUnits: numericAmount(row?.feeCapUnits),
      };
    }),
    recoveries: [...recoveriesByStatus.entries()].map(([status, value]) => ({
      labels: { status },
      count: value,
    })),
    maximumOpenRecoveryAgeSeconds,
    alerts: fillCountMatrix(
      alertRows.map((row) => ({
        labels: { type: row.type, severity: row.severity, status: row.status },
        count: row.count,
      })),
      'severity',
      operationalAlertSeverityEnum.enumValues,
      'status',
      operationalAlertStatusEnum.enumValues,
    ),
    outbox: outboxStatusEnum.enumValues.map((status) => ({
      labels: { status },
      count: outboxRows.find((row) => row.status === status)?.count ?? 0,
    })),
    ledger: ledgerRows.map((row) => ({
      labels: { category: row.category },
      count: row.count,
      amountUnits: numericAmount(row.amountUnits),
    })),
    phaseTransitions: migrationPhaseEnum.enumValues.map((phase) => ({
      labels: { phase },
      count: transitionRows.find((row) => row.phase === phase)?.count ?? 0,
    })),
  };
}

function numericAmount(value: string | null | undefined): string {
  const normalized = value ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`Operational metric amount is not an unsigned integer: ${normalized}`);
  }
  return normalized;
}

function numericCount(value: string | null): number {
  const parsed = Number(value ?? '0');
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Operational metric count exceeds the safe integer range.');
  }
  return parsed;
}

function aggregateCounts(rows: readonly OperationalMetricCount[]): OperationalMetricCount[] {
  const aggregate = new Map<string, OperationalMetricCount>();
  for (const row of rows) {
    const key = JSON.stringify(row.labels);
    const existing = aggregate.get(key);
    aggregate.set(key, { labels: row.labels, count: (existing?.count ?? 0) + row.count });
  }
  return [...aggregate.values()];
}

function fillCountMatrix(
  rows: readonly OperationalMetricCount[],
  firstLabel: string,
  firstValues: readonly string[],
  secondLabel?: string,
  secondValues: readonly string[] = [],
): OperationalMetricCount[] {
  const groups = new Map<string, Readonly<Record<string, string>>>();
  for (const row of rows) {
    const groupLabels = Object.fromEntries(
      Object.entries(row.labels).filter(([label]) => label !== firstLabel && label !== secondLabel),
    );
    groups.set(JSON.stringify(groupLabels), groupLabels);
  }
  const filled = [...rows];
  for (const groupLabels of groups.values()) {
    for (const firstValue of firstValues) {
      for (const secondValue of secondLabel === undefined ? [''] : secondValues) {
        const labels = {
          ...groupLabels,
          [firstLabel]: firstValue,
          ...(secondLabel === undefined ? {} : { [secondLabel]: secondValue }),
        };
        if (!filled.some((row) => sameLabels(row.labels, labels))) {
          filled.push({ labels, count: 0 });
        }
      }
    }
  }
  return filled;
}

function sameLabels(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([label, value]) => right[label] === value)
  );
}

import {
  collectOperationalMetrics,
  phaseAgeBucketsSeconds,
  type OperationalMetricCount,
  type OperationalMetricsSnapshot,
} from '@debtshift/database';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DatabaseService } from './database.service.js';

@Injectable()
export class MetricsService {
  readonly #mode: string;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#mode = config.getOrThrow<string>('DEBTSHIFT_MODE');
  }

  async render(): Promise<string> {
    return renderOperationalMetrics(
      await collectOperationalMetrics(this.database.db, new Date()),
      this.#mode,
    );
  }
}

export function renderOperationalMetrics(
  snapshot: OperationalMetricsSnapshot,
  mode: string,
): string {
  const lines: string[] = [];
  appendMetric(lines, 'debtshift_build_info', 'DebtShift runtime identity.', 'gauge', [
    { labels: { mode }, value: '1' },
  ]);
  appendMetric(
    lines,
    'debtshift_metrics_collected_timestamp_seconds',
    'Unix timestamp of the authoritative PostgreSQL metrics snapshot.',
    'gauge',
    [{ labels: {}, value: formatNumber(snapshot.collectedAt.getTime() / 1_000) }],
  );
  appendMetric(
    lines,
    'debtshift_migrations',
    'Current migrations by evidence-derived phase.',
    'gauge',
    snapshot.migrationPhases.map(({ phase, count }) => ({
      labels: { phase },
      value: count.toString(),
    })),
  );
  appendPhaseAgeHistogram(lines, snapshot);
  appendCountMetric(
    lines,
    'debtshift_phase_transitions_total',
    'Persisted migration phase transitions.',
    'counter',
    snapshot.phaseTransitions,
  );
  appendCountMetric(
    lines,
    'debtshift_commands',
    'Durable workflow commands by type and status.',
    'gauge',
    snapshot.commands,
  );
  appendCountMetric(
    lines,
    'debtshift_command_attempts_total',
    'Persisted logical command attempts by command type.',
    'counter',
    snapshot.commandAttempts,
  );
  appendCountMetric(
    lines,
    'debtshift_evidence_records',
    'Durable evidence records by type and verification state.',
    'gauge',
    snapshot.evidence,
  );
  appendCountMetric(
    lines,
    'debtshift_chain_actions',
    'Durable chain actions by action type and finality.',
    'gauge',
    snapshot.chainActions,
  );
  appendCountMetric(
    lines,
    'debtshift_transport_legs',
    'Transport legs by provider and observed provider state.',
    'gauge',
    snapshot.transportLegs,
  );
  appendCountMetric(
    lines,
    'debtshift_liquidity_reservations',
    'Liquidity reservations by status.',
    'gauge',
    snapshot.reservations,
  );
  appendMetric(
    lines,
    'debtshift_liquidity_reservation_principal_units',
    'Reserved principal base units by reservation status.',
    'gauge',
    snapshot.reservations.map(({ labels, amountUnits }) => ({ labels, value: amountUnits })),
  );
  appendMetric(
    lines,
    'debtshift_liquidity_reservation_fee_cap_units',
    'Reserved fee-cap base units by reservation status.',
    'gauge',
    snapshot.reservations.map(({ labels, feeCapUnits }) => ({ labels, value: feeCapUnits })),
  );
  appendCountMetric(
    lines,
    'debtshift_recovery_cases',
    'Durable recovery cases by status.',
    'gauge',
    snapshot.recoveries,
  );
  appendMetric(
    lines,
    'debtshift_open_recovery_age_seconds_max',
    'Age in seconds of the oldest open recovery case.',
    'gauge',
    [{ labels: {}, value: formatNumber(snapshot.maximumOpenRecoveryAgeSeconds) }],
  );
  appendCountMetric(
    lines,
    'debtshift_operational_alerts',
    'Operational alerts by type, severity, and status.',
    'gauge',
    snapshot.alerts,
  );
  appendCountMetric(
    lines,
    'debtshift_outbox_messages',
    'Transactional outbox messages by status.',
    'gauge',
    snapshot.outbox,
  );
  appendCountMetric(
    lines,
    'debtshift_ledger_entries',
    'Persisted ledger entries by financial category.',
    'gauge',
    snapshot.ledger,
  );
  appendMetric(
    lines,
    'debtshift_ledger_amount_units',
    'Ledger base-unit volume by financial category.',
    'gauge',
    snapshot.ledger.map(({ labels, amountUnits }) => ({ labels, value: amountUnits })),
  );
  appendMetric(
    lines,
    'debtshift_ledger_unexplained_imbalance_units',
    'Absolute unexplained base-unit imbalance reported by finalized ledger reconciliations.',
    'gauge',
    [{ labels: {}, value: snapshot.unexplainedLedgerImbalanceUnits }],
  );
  return `${lines.join('\n')}\n`;
}

function appendPhaseAgeHistogram(lines: string[], snapshot: OperationalMetricsSnapshot): void {
  const name = 'debtshift_migration_phase_age_seconds';
  lines.push(`# HELP ${name} Current age of migrations in each phase.`);
  lines.push(`# TYPE ${name} histogram`);
  for (const phase of snapshot.migrationPhases) {
    phaseAgeBucketsSeconds.forEach((upperBound, index) => {
      lines.push(
        `${name}_bucket${formatLabels({ phase: phase.phase, le: upperBound.toString() })} ${phase.ageSecondsBuckets[index] ?? 0}`,
      );
    });
    lines.push(`${name}_bucket${formatLabels({ phase: phase.phase, le: '+Inf' })} ${phase.count}`);
    lines.push(
      `${name}_sum${formatLabels({ phase: phase.phase })} ${formatNumber(phase.ageSecondsSum)}`,
    );
    lines.push(`${name}_count${formatLabels({ phase: phase.phase })} ${phase.count}`);
  }
}

function appendCountMetric(
  lines: string[],
  name: string,
  help: string,
  type: 'counter' | 'gauge',
  rows: readonly OperationalMetricCount[],
): void {
  appendMetric(
    lines,
    name,
    help,
    type,
    rows.map(({ labels, count }) => ({ labels, value: count.toString() })),
  );
}

function appendMetric(
  lines: string[],
  name: string,
  help: string,
  type: 'counter' | 'gauge',
  samples: readonly {
    readonly labels: Readonly<Record<string, string>>;
    readonly value: string;
  }[],
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  for (const sample of samples) {
    assertMetricValue(sample.value);
    lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
  }
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  return `{${entries.map(([label, value]) => `${label}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error('Metric value must be finite and positive.');
  return value.toString();
}

function assertMetricValue(value: string): void {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`Invalid Prometheus metric value: ${value}`);
  }
}

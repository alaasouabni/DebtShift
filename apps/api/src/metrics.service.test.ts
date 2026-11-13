import type { OperationalMetricsSnapshot } from '@debtshift/database';
import { describe, expect, it } from 'vitest';

import { renderOperationalMetrics } from './metrics.service.js';

describe('Prometheus operational metrics renderer', () => {
  it('renders histograms and safely escapes dynamic label values without identifiers', () => {
    const snapshot: OperationalMetricsSnapshot = {
      collectedAt: new Date('2026-11-13T06:00:00.000Z'),
      migrationPhases: [
        {
          phase: 'ROUTING',
          count: 1,
          ageSecondsSum: 30,
          ageSecondsBuckets: [0, 1, 1, 1, 1, 1, 1, 1],
        },
      ],
      commands: [],
      commandAttempts: [],
      evidence: [],
      chainActions: [],
      transportLegs: [{ labels: { provider: 'provider"\\\nname', state: 'PROCESSING' }, count: 1 }],
      reservations: [],
      recoveries: [],
      maximumOpenRecoveryAgeSeconds: 0,
      alerts: [],
      outbox: [],
      ledger: [],
      unexplainedLedgerImbalanceUnits: '0',
      phaseTransitions: [{ labels: { phase: 'ROUTING' }, count: 1 }],
    };

    const rendered = renderOperationalMetrics(snapshot, 'sandbox');

    expect(rendered).toContain('debtshift_build_info{mode="sandbox"} 1');
    expect(rendered).toContain(
      'debtshift_migration_phase_age_seconds_bucket{le="30",phase="ROUTING"} 1',
    );
    expect(rendered).toContain(
      'debtshift_migration_phase_age_seconds_bucket{le="+Inf",phase="ROUTING"} 1',
    );
    expect(rendered).toContain('provider="provider\\"\\\\\\nname"');
    expect(rendered).toContain('debtshift_ledger_unexplained_imbalance_units 0');
    expect(rendered).not.toContain('migration_id');
    expect(rendered.endsWith('\n')).toBe(true);
  });
});

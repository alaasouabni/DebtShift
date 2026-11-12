import { describe, expect, it } from 'vitest';

import {
  FORWARD_PHASES,
  isTerminalPhase,
  type AuditEvent,
  type Evidence,
} from '../../lib/api/types';
import {
  evidenceProvenanceLine,
  hasChainProvenance,
  isSimulatedTransport,
  readRecoveryReason,
} from './evidence-line';
import { buildTimeline, isOffTrack, phaseEntryTimes, phasePosition } from './phase-timeline';
import { BASE_POLL_MS, MAX_POLL_MS, nextPollDelay, shouldKeepPolling } from './use-migration';

function event(sequence: number, phase: string, observedAt: string): AuditEvent {
  return {
    eventId: `0x${String(sequence).padStart(2, '0')}`,
    migrationId: '0xmigration',
    sequence,
    type: `${phase}_ENTERED`,
    phase: phase as AuditEvent['phase'],
    payload: {},
    observedAt,
  };
}

/** The event history of a migration that reached ROUTING. */
const HISTORY: AuditEvent[] = [
  event(1, 'DRAFT', '2026-11-11T16:03:02.000Z'),
  event(2, 'QUOTED', '2026-11-11T16:03:02.500Z'),
  event(3, 'AUTHORIZED', '2026-11-11T16:03:03.000Z'),
  event(4, 'RESERVED', '2026-11-11T16:03:09.000Z'),
  event(5, 'SOURCE_CLOSED', '2026-11-11T16:03:21.000Z'),
  event(6, 'ROUTING', '2026-11-11T16:03:24.000Z'),
];

describe('polling cadence', () => {
  it('uses the contract interval when nothing has failed', () => {
    expect(nextPollDelay(0)).toBe(BASE_POLL_MS);
    // The contract asks for 1.5–2 s.
    expect(BASE_POLL_MS).toBeGreaterThanOrEqual(1_500);
    expect(BASE_POLL_MS).toBeLessThanOrEqual(2_000);
  });

  it('backs off exponentially after transient failures', () => {
    expect(nextPollDelay(1)).toBe(BASE_POLL_MS * 2);
    expect(nextPollDelay(2)).toBe(BASE_POLL_MS * 4);
    expect(nextPollDelay(3)).toBe(BASE_POLL_MS * 8);
  });

  it('caps the backoff so a dead backend is still retried', () => {
    expect(nextPollDelay(50)).toBe(MAX_POLL_MS);
    expect(nextPollDelay(5)).toBeLessThanOrEqual(MAX_POLL_MS);
  });

  it('never returns a non-positive delay', () => {
    expect(nextPollDelay(-1)).toBe(BASE_POLL_MS);
  });
});

describe('when polling stops', () => {
  it('keeps polling through every non-terminal phase', () => {
    const nonTerminal = [
      'DRAFT',
      'QUOTED',
      'AUTHORIZED',
      'RESERVED',
      'SOURCE_CLOSED',
      'ROUTING',
      'DEST_FUNDED',
      'TARGET_OPEN',
      'SETTLED',
      'RECOVERY',
    ];
    for (const phase of nonTerminal) {
      expect(shouldKeepPolling(phase), phase).toBe(true);
    }
  });

  it('keeps polling through SETTLED, which is not the end', () => {
    // The one most likely to be mistaken for completion.
    expect(shouldKeepPolling('SETTLED')).toBe(true);
    expect(isTerminalPhase('SETTLED')).toBe(false);
  });

  it('keeps polling through RECOVERY, which is still working', () => {
    expect(shouldKeepPolling('RECOVERY')).toBe(true);
  });

  it('stops at the three terminal phases and only those', () => {
    expect(shouldKeepPolling('COMPLETED')).toBe(false);
    expect(shouldKeepPolling('FAILED_SAFE')).toBe(false);
    expect(shouldKeepPolling('EXPIRED')).toBe(false);
  });

  it('keeps polling when the phase is not known yet', () => {
    expect(shouldKeepPolling(undefined)).toBe(true);
  });
});

describe('phaseEntryTimes', () => {
  it('takes the first observation of each phase', () => {
    const repeated = [...HISTORY, event(7, 'ROUTING', '2026-11-11T16:04:00.000Z')];
    expect(phaseEntryTimes(repeated).get('ROUTING')).toBe('2026-11-11T16:03:24.000Z');
  });

  it('orders by sequence, not by array position', () => {
    const shuffled = [HISTORY[2]!, HISTORY[0]!, HISTORY[1]!];
    expect(phaseEntryTimes(shuffled).get('DRAFT')).toBe('2026-11-11T16:03:02.000Z');
  });

  it('is empty for a migration with no events', () => {
    expect(phaseEntryTimes([]).size).toBe(0);
  });
});

describe('buildTimeline', () => {
  it('has exactly the ten forward phases, in order', () => {
    const steps = buildTimeline('ROUTING', HISTORY);
    expect(steps).toHaveLength(10);
    expect(steps.map((step) => step.phase)).toEqual([...FORWARD_PHASES]);
  });

  it('marks the authoritative phase as current and earlier ones as done', () => {
    const steps = buildTimeline('ROUTING', HISTORY);
    expect(steps.find((step) => step.phase === 'ROUTING')?.state).toBe('current');
    expect(steps.find((step) => step.phase === 'SOURCE_CLOSED')?.state).toBe('done');
    expect(steps.find((step) => step.phase === 'DEST_FUNDED')?.state).toBe('pending');
  });

  it('attaches the entry time from the event history', () => {
    const steps = buildTimeline('ROUTING', HISTORY);
    expect(steps.find((step) => step.phase === 'RESERVED')?.at).toBe('2026-11-11T16:03:09.000Z');
    expect(steps.find((step) => step.phase === 'SETTLED')?.at).toBeUndefined();
  });

  it('marks every step done at COMPLETED', () => {
    const complete = [...HISTORY, event(7, 'COMPLETED', '2026-11-11T16:05:00.000Z')];
    const steps = buildTimeline('COMPLETED', complete);
    expect(steps.find((step) => step.phase === 'COMPLETED')?.state).toBe('current');
    expect(steps.filter((step) => step.state === 'pending')).toHaveLength(0);
  });

  it('leaves nothing current when the migration went off the track', () => {
    // A pulsing "in progress" step under a failed-safe banner would contradict
    // the banner, so an off-track phase marks what was reached and stops.
    const recovered = [...HISTORY, event(7, 'FAILED_SAFE', '2026-11-11T16:06:00.000Z')];
    const steps = buildTimeline('FAILED_SAFE', recovered);
    expect(steps.some((step) => step.state === 'current')).toBe(false);
    expect(steps.find((step) => step.phase === 'ROUTING')?.state).toBe('done');
    expect(steps.find((step) => step.phase === 'DEST_FUNDED')?.state).toBe('pending');
  });

  it('carries the honest caption for SETTLED', () => {
    const steps = buildTimeline('SETTLED', HISTORY);
    expect(steps.find((step) => step.phase === 'SETTLED')?.caption).toContain('not the end');
  });
});

describe('isOffTrack', () => {
  it('names the three phases that replace the forward track', () => {
    expect(isOffTrack('RECOVERY')).toBe(true);
    expect(isOffTrack('FAILED_SAFE')).toBe(true);
    expect(isOffTrack('EXPIRED')).toBe(true);
  });

  it('does not treat a forward phase as off-track', () => {
    for (const phase of FORWARD_PHASES) {
      expect(isOffTrack(phase), phase).toBe(false);
    }
  });
});

describe('phasePosition', () => {
  it('counts a forward phase against the ten', () => {
    expect(phasePosition('DRAFT')).toBe('phase 1 of 10');
    expect(phasePosition('ROUTING')).toBe('phase 6 of 10');
    expect(phasePosition('COMPLETED')).toBe('phase 10 of 10');
  });

  it('gives no position to an off-track phase', () => {
    expect(phasePosition('FAILED_SAFE')).toBeUndefined();
    expect(phasePosition('RECOVERY')).toBeUndefined();
  });
});

describe('evidenceProvenanceLine', () => {
  const base: Evidence = {
    evidenceId: '0x76e5a024',
    migrationId: '0xf58e24d7',
    type: 'INTENT_AUTHORIZATION',
    schemaVersion: 1,
    provider: 'EIP712',
    network: 'eip155:31337',
    rawObservationHash: '0x9b7fc988',
    normalizedPayload: {},
    observedAt: '2026-11-11T22:50:00.000Z',
    verificationState: 'FINALIZED',
    verificationMethod: 'eip712',
    verifierVersion: '1',
  };

  it('survives the null columns a real migration returns', () => {
    // These exact nulls crashed the evidence list before this helper existed:
    // the database columns are nullable, so JSON null arrives, not an absent key.
    const offChain: Evidence = {
      ...base,
      chainId: null,
      blockNumber: null,
      blockHash: null,
      transactionHash: null,
      logIndex: null,
    };
    expect(evidenceProvenanceLine(offChain)).toBe('EIP712 · eip155:31337');
  });

  it('survives absent keys too', () => {
    expect(evidenceProvenanceLine(base)).toBe('EIP712 · eip155:31337');
  });

  it('includes the full chain reference when the backend recorded one', () => {
    const onChain: Evidence = {
      ...base,
      provider: 'ANVIL',
      network: 'eip155:31338',
      chainId: 31_338,
      blockNumber: '1284',
      blockHash: '0x4f1c',
      transactionHash: '0x3e52',
      logIndex: 2,
    };
    expect(evidenceProvenanceLine(onChain)).toBe(
      'ANVIL · eip155:31338 · chain 31338 · block 1,284 · tx 0x3e52 · log 2',
    );
  });

  it('keeps a log index of zero, which is falsy but real', () => {
    const atZero: Evidence = { ...base, transactionHash: '0xabc', logIndex: 0 };
    expect(evidenceProvenanceLine(atZero)).toContain('log 0');
  });

  it('keeps chain id zero rather than dropping it', () => {
    expect(evidenceProvenanceLine({ ...base, chainId: 0 })).toContain('chain 0');
  });
});

describe('hasChainProvenance', () => {
  const base: Evidence = {
    evidenceId: '0x01',
    migrationId: '0x02',
    type: 'SOURCE_CLOSE',
    schemaVersion: 1,
    provider: 'ANVIL',
    network: 'eip155:31337',
    rawObservationHash: '0x03',
    normalizedPayload: {},
    observedAt: '2026-11-11T22:50:00.000Z',
    verificationState: 'CONFIRMED',
    verificationMethod: 'receipt',
    verifierVersion: '1',
  };

  it('is false for off-chain evidence with null columns', () => {
    expect(hasChainProvenance({ ...base, transactionHash: null, blockHash: null })).toBe(false);
  });

  it('is true once a transaction or block hash exists', () => {
    expect(hasChainProvenance({ ...base, transactionHash: '0xdead' })).toBe(true);
    expect(hasChainProvenance({ ...base, blockHash: '0xbeef' })).toBe(true);
  });
});

describe('REQUOTE_REQUIRED', () => {
  it('is terminal, so polling stops there instead of running forever', () => {
    // Added on main on 2026-11-11. Before this frontend knew the phase, a
    // migration that reached it would have been polled indefinitely.
    expect(isTerminalPhase('REQUOTE_REQUIRED')).toBe(true);
    expect(shouldKeepPolling('REQUOTE_REQUIRED')).toBe(false);
  });

  it('is off the forward track, like the other exceptional outcomes', () => {
    expect(isOffTrack('REQUOTE_REQUIRED')).toBe(true);
    expect(phasePosition('REQUOTE_REQUIRED')).toBeUndefined();
  });

  it('leaves nothing current on the timeline', () => {
    const steps = buildTimeline('REQUOTE_REQUIRED', HISTORY.slice(0, 4));
    expect(steps.some((step) => step.state === 'current')).toBe(false);
    // The source was never closed: that step must not read as done.
    expect(steps.find((step) => step.phase === 'SOURCE_CLOSED')?.state).toBe('pending');
  });
});

describe('isSimulatedTransport', () => {
  const base: Evidence = {
    evidenceId: '0x01',
    migrationId: '0x02',
    type: 'TRANSPORT_DESTINATION',
    schemaVersion: 1,
    provider: 'DEBTSHIFT_SIMULATOR',
    network: 'eip155:31338',
    rawObservationHash: '0x03',
    normalizedPayload: {},
    observedAt: '2026-11-11T22:50:00.000Z',
    verificationState: 'FINALIZED',
    verificationMethod: 'receipt',
    verifierVersion: '1',
  };

  it('marks only the transport simulator observations', () => {
    expect(isSimulatedTransport(base)).toBe(true);
  });

  it('does not mark real chain evidence in the same sandbox migration', () => {
    // A sandbox migration has both kinds side by side; one label for all of
    // them would misdescribe the real receipts.
    expect(isSimulatedTransport({ ...base, provider: 'DIRECT_RPC' })).toBe(false);
    expect(isSimulatedTransport({ ...base, provider: 'EIP712' })).toBe(false);
    expect(isSimulatedTransport({ ...base, provider: 'NEAR_INTENTS_1CLICK' })).toBe(false);
  });
});

describe('readRecoveryReason', () => {
  const opened: Evidence = {
    evidenceId: '0x0c2e',
    migrationId: '0x3a59',
    type: 'RECOVERY_OPENED',
    schemaVersion: 1,
    provider: 'DEBTSHIFT_WORKER',
    network: 'eip155:31337',
    rawObservationHash: '0x01',
    normalizedPayload: {
      reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
      policy: 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION',
    },
    observedAt: '2026-11-12T01:02:32.826Z',
    verificationState: 'FINALIZED',
    verificationMethod: 'state',
    verifierVersion: '1',
  };

  it('reads the reason and the policy the backend recorded', () => {
    expect(readRecoveryReason([opened])).toEqual({
      reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
      policy: 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION',
    });
  });

  it('returns the reason alone when no policy is recorded', () => {
    expect(
      readRecoveryReason([{ ...opened, normalizedPayload: { reason: 'TRANSPORT_REFUNDED' } }]),
    ).toEqual({ reason: 'TRANSPORT_REFUNDED' });
  });

  it('invents nothing when there is no recovery evidence or no string reason', () => {
    expect(readRecoveryReason([])).toBeUndefined();
    expect(readRecoveryReason([{ ...opened, normalizedPayload: {} }])).toBeUndefined();
    expect(readRecoveryReason([{ ...opened, normalizedPayload: { reason: 42 } }])).toBeUndefined();
    expect(readRecoveryReason([{ ...opened, type: 'SOURCE_CLOSE' }])).toBeUndefined();
  });
});

/*
 * The phase stepper's data.
 *
 * The frontend does not derive or advance phases — the API's
 * `migration.phase` is authoritative and is what marks the current step. What
 * this module does is find the moment each phase was ENTERED, by looking it up
 * in the authoritative event history, so the stepper can show times without
 * inventing them.
 *
 * Recovery, failed-safe and expired are deliberately NOT positions on the
 * track: they replace it. `isOffTrack` says so.
 */

import { FORWARD_PHASES, type AuditEvent, type MigrationPhase } from '../../lib/api/types';
import { PHASE_LABELS } from '../../lib/labels';

export interface TimelineStep {
  readonly phase: MigrationPhase;
  readonly label: string;
  readonly caption: string;
  readonly state: 'done' | 'current' | 'pending';
  /** When this phase was first observed, from the event history. */
  readonly at?: string | undefined;
}

/** True for the four phases that are not steps on the forward track. */
export function isOffTrack(phase: MigrationPhase): boolean {
  return (
    phase === 'RECOVERY' ||
    phase === 'FAILED_SAFE' ||
    phase === 'REQUOTE_REQUIRED' ||
    phase === 'EXPIRED'
  );
}

/**
 * The first time each phase appears in the event history.
 *
 * Events are ordered by `sequence`, so the first occurrence is the entry.
 */
export function phaseEntryTimes(
  events: readonly AuditEvent[],
): ReadonlyMap<MigrationPhase, string> {
  const times = new Map<MigrationPhase, string>();
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  for (const event of ordered) {
    if (!times.has(event.phase)) times.set(event.phase, event.observedAt);
  }
  return times;
}

/**
 * The ten forward steps, with the current one marked.
 *
 * When the migration has gone off-track every forward phase up to the last one
 * reached stays `done` and nothing is `current`: the off-track presentation
 * carries the state instead, and showing a pulsing "in progress" step under a
 * failed-safe banner would contradict it.
 */
export function buildTimeline(
  phase: MigrationPhase,
  events: readonly AuditEvent[],
): TimelineStep[] {
  const times = phaseEntryTimes(events);
  const offTrack = isOffTrack(phase);
  const currentIndex = offTrack ? -1 : FORWARD_PHASES.indexOf(phase);

  // How far the forward track got before leaving it: the furthest forward
  // phase the event history records.
  const reachedIndex = offTrack
    ? FORWARD_PHASES.reduce(
        (furthest, candidate, index) => (times.has(candidate) ? index : furthest),
        -1,
      )
    : currentIndex;

  return FORWARD_PHASES.map((forwardPhase, index) => {
    const entry = PHASE_LABELS[forwardPhase];
    const at = times.get(forwardPhase);
    const state: TimelineStep['state'] =
      index < currentIndex || (offTrack && index <= reachedIndex)
        ? 'done'
        : index === currentIndex
          ? 'current'
          : 'pending';
    return {
      phase: forwardPhase,
      label: entry.label,
      caption: entry.caption,
      state,
      at,
    };
  });
}

/** `phase 6 of 10`, or undefined when the migration is off the forward track. */
export function phasePosition(phase: MigrationPhase): string | undefined {
  const index = FORWARD_PHASES.indexOf(phase);
  if (index < 0) return undefined;
  return `phase ${index + 1} of ${FORWARD_PHASES.length}`;
}

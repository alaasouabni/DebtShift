'use client';

/*
 * Migration polling.
 *
 * There is no SSE and no WebSocket on this API — the README and
 * `docs/architecture.md` say otherwise, but `apps/api/src` contains no `@Sse`
 * handler. So this polls, and it is deliberately the ONLY place that does, so
 * that swapping it for a stream later touches one file.
 *
 * The rules it implements, from the frontend contract:
 *   - poll every 1.5–2 s while the phase is non-terminal;
 *   - pause entirely while the tab is hidden;
 *   - back off after transient failures;
 *   - stop at COMPLETED, FAILED_SAFE or EXPIRED;
 *   - never lose the last known state or the migration id on a failure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from '../../lib/api/client';
import { isTerminalPhase, type MigrationDetails } from '../../lib/api/types';
import { now } from '../../lib/clock';

export const BASE_POLL_MS = 1_800;
export const MAX_POLL_MS = 30_000;

/**
 * How long to wait before the next poll.
 *
 * Zero failures gives the base interval. Each consecutive failure doubles it,
 * capped, so a backend that has gone away is retried about twice a minute
 * instead of thirty times.
 */
export function nextPollDelay(
  consecutiveFailures: number,
  baseMs = BASE_POLL_MS,
  maxMs = MAX_POLL_MS,
): number {
  if (consecutiveFailures <= 0) return baseMs;
  const delay = baseMs * 2 ** consecutiveFailures;
  return delay > maxMs ? maxMs : delay;
}

/** Whether polling should continue for a phase the API just reported. */
export function shouldKeepPolling(phase: string | undefined): boolean {
  if (phase === undefined) return true;
  return !isTerminalPhase(phase);
}

export type PollStatus = 'loading' | 'live' | 'paused' | 'stopped' | 'retrying' | 'missing';

export interface MigrationPollState {
  /** The last successful read. Kept through failures, never cleared. */
  readonly details?: MigrationDetails | undefined;
  readonly status: PollStatus;
  readonly error?: string | undefined;
  readonly consecutiveFailures: number;
  readonly updatedAt?: Date | undefined;
  readonly nextAttemptMs: number;
  refresh(): void;
}

export function useMigrationPolling(migrationId: string): MigrationPollState {
  const [details, setDetails] = useState<MigrationDetails | undefined>(undefined);
  const [status, setStatus] = useState<PollStatus>('loading');
  const [error, setError] = useState<string | undefined>(undefined);
  const [failures, setFailures] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | undefined>(undefined);
  const [manualTick, setManualTick] = useState(0);

  // Read inside the loop without making it a dependency, so a new phase does
  // not tear down and rebuild the timer on every poll.
  const detailsRef = useRef<MigrationDetails | undefined>(undefined);
  detailsRef.current = details;
  const failuresRef = useRef(0);
  failuresRef.current = failures;

  const refresh = useCallback(() => setManualTick((value) => value + 1), []);

  useEffect(() => {
    if (migrationId === '') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void run(), delay);
    };

    const run = async (): Promise<void> => {
      if (cancelled) return;

      // A hidden tab polls nothing at all. It resumes on visibilitychange.
      if (typeof document !== 'undefined' && document.hidden) {
        setStatus('paused');
        schedule(BASE_POLL_MS);
        return;
      }

      try {
        const result = await api.migration(migrationId);
        if (cancelled) return;

        setDetails(result);
        setUpdatedAt(now());
        setFailures(0);
        failuresRef.current = 0;
        setError(undefined);

        if (shouldKeepPolling(result.migration.phase)) {
          setStatus('live');
          schedule(BASE_POLL_MS);
        } else {
          setStatus('stopped');
        }
      } catch (caught) {
        if (cancelled) return;

        const apiError = caught instanceof ApiError ? caught : undefined;

        // A migration that does not exist is not a transient failure: stop.
        if (apiError?.code === 'NOT_FOUND') {
          setStatus('missing');
          setError(apiError.message);
          return;
        }

        const count = failuresRef.current + 1;
        failuresRef.current = count;
        setFailures(count);
        setError(apiError?.message ?? 'The migration could not be read.');
        // The last known state stays on screen. Losing it, or the id, on a
        // blip would be worse than showing a slightly old phase with a notice.
        setStatus('retrying');
        schedule(nextPollDelay(count));
      }
    };

    void run();

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        if (timer !== undefined) clearTimeout(timer);
        const phase = detailsRef.current?.migration.phase;
        if (shouldKeepPolling(phase)) void run();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [migrationId, manualTick]);

  return {
    details,
    status,
    error,
    consecutiveFailures: failures,
    updatedAt,
    nextAttemptMs: nextPollDelay(failures),
    refresh,
  };
}

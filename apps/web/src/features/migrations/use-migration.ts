'use client';

/*
 * Reading a migration while it runs.
 *
 * The state on screen always comes from one place: a read of
 * `GET /migrations/:id`. Two things decide WHEN to read:
 *
 *   - the API's audit-event stream (`GET /migrations/:id/stream`, server-sent
 *     events). Each event means "something was recorded", and is answered by
 *     reading the migration again. An event is never itself treated as the
 *     state, and an open connection is never treated as progress;
 *   - a timer, which is the whole mechanism when there is no stream (the
 *     recorded demo, an old browser, a dropped connection) and a slow safety
 *     net when there is one.
 *
 * This is deliberately the ONLY place that polls or streams.
 *
 * The rules it implements, from the frontend contract:
 *   - read every 1.5–2 s while the phase is non-terminal and no stream is open;
 *   - resume the stream after the last event already read;
 *   - pause entirely while the tab is hidden;
 *   - back off after transient failures;
 *   - stop at a terminal phase;
 *   - never lose the last known state or the migration id on a failure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { latestMigrationEventSequence } from '../../components/migration-client';
import { ApiError, api } from '../../lib/api/client';
import { isTerminalPhase, type MigrationDetails } from '../../lib/api/types';
import { now } from '../../lib/clock';

export const BASE_POLL_MS = 1_800;
export const MAX_POLL_MS = 30_000;
/** How often to read anyway while the stream is open, in case an event is missed. */
export const STREAM_SAFETY_POLL_MS = 15_000;
/** Consecutive refused stream connections after which the timer is left to do the work. */
export const MAX_STREAM_REFUSALS = 3;

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
/** What is prompting the reads right now. */
export type PollTransport = 'stream' | 'polling';

export interface MigrationPollState {
  /** The last successful read. Kept through failures, never cleared. */
  readonly details?: MigrationDetails | undefined;
  readonly status: PollStatus;
  readonly transport: PollTransport;
  readonly error?: string | undefined;
  readonly consecutiveFailures: number;
  readonly updatedAt?: Date | undefined;
  readonly nextAttemptMs: number;
  refresh(): void;
}

export function useMigrationPolling(migrationId: string): MigrationPollState {
  const [details, setDetails] = useState<MigrationDetails | undefined>(undefined);
  const [status, setStatus] = useState<PollStatus>('loading');
  const [transport, setTransport] = useState<PollTransport>('polling');
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
    let reading = false;
    let readAgain = false;

    let stream: EventSource | undefined;
    let streamOpen = false;
    let streamRefusals = 0;

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };

    const closeStream = () => {
      stream?.close();
      stream = undefined;
      streamOpen = false;
      setTransport('polling');
    };

    /** Read now. If a read is already in flight, read once more when it lands. */
    const readNow = () => {
      if (cancelled) return;
      if (reading) {
        readAgain = true;
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      void run();
    };

    const openStream = (current: MigrationDetails) => {
      if (stream !== undefined || streamRefusals >= MAX_STREAM_REFUSALS) return;
      if (typeof EventSource === 'undefined') return;
      const url = api.migrationStreamUrl(migrationId, latestMigrationEventSequence(current.events));
      if (url === undefined) return;

      // The session cookie has to travel with the stream, as with every read.
      const source = new EventSource(url, { withCredentials: true });
      stream = source;

      const markOpen = () => {
        if (cancelled || stream !== source) return;
        streamOpen = true;
        streamRefusals = 0;
        setTransport('stream');
      };
      source.onopen = markOpen;
      source.addEventListener('keepalive', markOpen);
      // Something was recorded. What it was is read from the API, not from
      // the event.
      source.addEventListener('migration', () => {
        if (cancelled || stream !== source) return;
        markOpen();
        readNow();
      });
      source.onerror = () => {
        if (cancelled || stream !== source) return;
        streamOpen = false;
        setTransport('polling');
        // The browser reconnects by itself and resumes after the last event
        // it saw. If it has given up instead, the next read opens a new one.
        if (source.readyState === 2) {
          source.close();
          stream = undefined;
          streamRefusals += 1;
        }
        // A dropped stream says nothing about the migration. Read it.
        readNow();
      };
    };

    const run = async (): Promise<void> => {
      if (cancelled || reading) return;

      // A hidden tab reads nothing at all. It resumes on visibilitychange.
      if (typeof document !== 'undefined' && document.hidden) {
        closeStream();
        setStatus('paused');
        schedule(BASE_POLL_MS);
        return;
      }

      reading = true;
      readAgain = false;
      // Decided inside the read, done after it: starting the next read before
      // this one has let go of `reading` would let the two overlap.
      let next: (() => void) | undefined;
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
          openStream(result);
          next = () => {
            if (readAgain) void run();
            else schedule(streamOpen ? STREAM_SAFETY_POLL_MS : BASE_POLL_MS);
          };
        } else {
          closeStream();
          setStatus('stopped');
        }
      } catch (caught) {
        if (cancelled) return;

        const apiError = caught instanceof ApiError ? caught : undefined;

        // A migration that does not exist is not a transient failure: stop.
        if (apiError?.code === 'NOT_FOUND') {
          closeStream();
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
        next = () => schedule(nextPollDelay(count));
      } finally {
        reading = false;
      }
      next?.();
    };

    void run();

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        const phase = detailsRef.current?.migration.phase;
        if (shouldKeepPolling(phase)) readNow();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      stream?.close();
      stream = undefined;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [migrationId, manualTick]);

  return {
    details,
    status,
    transport,
    error,
    consecutiveFailures: failures,
    updatedAt,
    nextAttemptMs: nextPollDelay(failures),
    refresh,
  };
}

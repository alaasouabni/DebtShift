import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api/client';
import type { MigrationDetails, PreparedMigration } from '../api/types';
import { anchorClock, isClockAnchored, now, resetClock } from '../clock';
import { secondsSince, secondsUntilIso, secondsUntilUnix } from '../formatting';
import {
  DemoApi,
  DEMO_ACCOUNT,
  DEMO_MIGRATION_ID,
  migrationAtStep,
  replayStepCount,
} from './demo-api';
import { demoClient, isDemoActive, startDemo, stopDemo } from './index';
import migrationRecording from './recordings/migration-settled.json' with { type: 'json' };
import prepareRecording from './recordings/prepare.json' with { type: 'json' };

const recordedMigration = migrationRecording as unknown as MigrationDetails;
const recordedPrepare = prepareRecording as unknown as PreparedMigration;

function installSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

beforeEach(() => {
  installSessionStorage();
  resetClock();
});

afterEach(() => {
  stopDemo();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the clock', () => {
  it('is the real clock until something anchors it', () => {
    expect(isClockAnchored()).toBe(false);
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(50);
  });

  it('reads the anchored instant and keeps running from it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
    anchorClock(new Date('2026-11-11T22:36:17.000Z'));
    expect(now().toISOString()).toBe('2026-11-11T22:36:17.000Z');

    vi.advanceTimersByTime(5_000);
    expect(now().toISOString()).toBe('2026-11-11T22:36:22.000Z');
  });

  it('drives the formatters, so ages and countdowns follow the anchor', () => {
    // Frozen, so the few milliseconds between anchoring and reading cannot
    // push a countdown across a whole-second boundary.
    vi.useFakeTimers();
    anchorClock(new Date('2026-11-11T22:36:17.000Z'));
    expect(secondsSince('2026-11-11T22:36:07.000Z')).toBe(10);
    expect(secondsUntilIso('2026-11-11T22:37:17.000Z')).toBe(60);
  });

  it('returns to real time on reset', () => {
    anchorClock(0);
    resetClock();
    expect(isClockAnchored()).toBe(false);
  });
});

describe('turning the demo on and off', () => {
  it('is off by default', () => {
    expect(isDemoActive()).toBe(false);
    expect(demoClient()).toBeUndefined();
  });

  it('survives a reload through sessionStorage, and stops cleanly', () => {
    startDemo();
    expect(isDemoActive()).toBe(true);
    expect(demoClient()).toBeInstanceOf(DemoApi);

    stopDemo();
    expect(isDemoActive()).toBe(false);
    expect(demoClient()).toBeUndefined();
  });

  it('puts the clock back when the demo ends', () => {
    startDemo();
    anchorClock(0);
    stopDemo();
    expect(isClockAnchored()).toBe(false);
  });

  it('is off, not broken, when storage is unavailable', () => {
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('denied');
      },
    });
    expect(isDemoActive()).toBe(false);
    expect(() => startDemo()).not.toThrow();
  });
});

describe('the demo never reaches a backend', () => {
  it('answers every call from the recording without a single request', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('the demo must not fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    startDemo();

    await api.health();
    await api.position(DEMO_ACCOUNT);
    await api.markets();
    await api.positionHistory(DEMO_ACCOUNT);
    await api.analyzeRoutes(DEMO_ACCOUNT);
    const prepared = await api.prepare(DEMO_ACCOUNT);
    await api.execute({
      signedIntent: { intent: prepared.intent, intentHash: prepared.intentHash, signature: '0x' },
      signedPlan: { plan: prepared.plan, planHash: prepared.planHash, signature: '0x' },
      quote: prepared.quote,
      sourceSnapshot: prepared.sourceSnapshot,
      sourceAuthorization: { kind: 'NONE' },
      targetAuthorization: { kind: 'NONE' },
    });
    await api.migration(DEMO_MIGRATION_ID);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('goes back to the live client the moment the demo stops', () => {
    // The facade chooses per call. The live client captured `fetch` when the
    // module loaded, so this checks the routing itself rather than a stub.
    startDemo();
    expect(api.baseUrl).toBe('recorded://debtshift-sandbox');

    stopDemo();
    expect(api.baseUrl).not.toContain('recorded://');
    expect(api.baseUrl).toMatch(/^https?:\/\//);
  });
});

describe('the recording is shown untouched', () => {
  it('returns the recorded prepare response itself, hashes and deadlines included', async () => {
    const prepared = await new DemoApi().prepare();
    expect(prepared.planHash).toBe(recordedPrepare.planHash);
    expect(prepared.intentHash).toBe(recordedPrepare.intentHash);
    expect(prepared.plan.deadline).toBe(recordedPrepare.plan.deadline);
    expect(prepared.quote.expiresAt).toBe(recordedPrepare.quote.expiresAt);
  });

  it('anchors the clock inside every recorded window instead of moving the windows', async () => {
    const prepared = await new DemoApi().prepare();
    expect(secondsUntilIso(prepared.quote.expiresAt)).toBeGreaterThan(200);
    expect(secondsUntilUnix(prepared.plan.deadline)).toBeGreaterThan(200);
    expect(secondsUntilUnix(prepared.intent.expiration)).toBeGreaterThan(200);
  });

  it('shows the recorded position as fresh as it was when it was read', async () => {
    const snapshot = await new DemoApi().position();
    expect(snapshot).toBeDefined();
    expect(secondsSince(snapshot!.block.observedAt)).toBeLessThan(10);
  });

  it('executes nothing and points at the recorded migration', async () => {
    const result = await new DemoApi().execute();
    expect(result.migrationId).toBe(recordedMigration.migration.migrationId);
    expect(result.created).toBe(false);
  });
});

describe('the migration replay', () => {
  const steps = replayStepCount(recordedMigration);

  it('has one step per recorded event', () => {
    expect(steps).toBe(recordedMigration.events.length);
  });

  it('starts at the first recorded phase with only what existed then', () => {
    const first = migrationAtStep(recordedMigration, 0);
    const firstEvent = [...recordedMigration.events].sort((a, b) => a.sequence - b.sequence)[0]!;
    expect(first.migration.phase).toBe(firstEvent.phase);
    expect(first.events).toHaveLength(1);
    expect(first.evidence.length).toBeLessThan(recordedMigration.evidence.length);
  });

  it('only ever reveals more, never less', () => {
    let previousEvidence = 0;
    let previousEvents = 0;
    for (let step = 0; step < steps; step += 1) {
      const view = migrationAtStep(recordedMigration, step);
      expect(view.evidence.length).toBeGreaterThanOrEqual(previousEvidence);
      expect(view.events.length).toBeGreaterThan(previousEvents);
      previousEvidence = view.evidence.length;
      previousEvents = view.events.length;
    }
  });

  it('follows the recorded phases in their recorded order', () => {
    const ordered = [...recordedMigration.events].sort((a, b) => a.sequence - b.sequence);
    for (let step = 0; step < steps; step += 1) {
      expect(migrationAtStep(recordedMigration, step).migration.phase).toBe(ordered[step]!.phase);
    }
  });

  it('shows a command the recording finished later as still running', () => {
    for (let step = 0; step < steps - 1; step += 1) {
      const view = migrationAtStep(recordedMigration, step);
      const cutoff = Date.parse(view.migration.updatedAt);
      for (const command of view.commands) {
        const recorded = recordedMigration.commands.find((c) => c.commandId === command.commandId)!;
        if (Date.parse(recorded.updatedAt) > cutoff) expect(command.status).toBe('RUNNING');
      }
    }
  });

  it('ends on the complete recording and stays there', () => {
    expect(migrationAtStep(recordedMigration, steps - 1)).toBe(recordedMigration);
    expect(migrationAtStep(recordedMigration, steps + 50)).toBe(recordedMigration);
  });

  it('ends on the phase the real run ended on — it does not invent a completion', () => {
    const last = migrationAtStep(recordedMigration, steps + 50);
    expect(last.migration.phase).toBe(recordedMigration.migration.phase);
    expect(last.migration.phase).not.toBe('COMPLETED');
  });

  it('clamps a negative step to the beginning', () => {
    expect(migrationAtStep(recordedMigration, -3).events).toHaveLength(1);
  });

  it('advances with time when polled', async () => {
    vi.useFakeTimers();
    const demo = new DemoApi();
    const first = await demo.migration();
    vi.advanceTimersByTime(60_000);
    const later = await demo.migration();
    expect(later.events.length).toBeGreaterThan(first.events.length);
    expect(later.migration.phase).toBe(recordedMigration.migration.phase);
  });
});

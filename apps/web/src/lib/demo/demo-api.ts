/*
 * The recorded demo's data source.
 *
 * It answers the same calls as the real API client, from responses captured on
 * the contract-backed sandbox — a real position, a real route analysis, a real
 * `prepare`, and a real migration with its evidence, commands and events. So a
 * judge with no wallet and no local chains sees the product exactly as the
 * backend drove it.
 *
 * Rules it keeps:
 *   - nothing is invented or rewritten: amounts, hashes, timestamps and
 *     rejection reasons are the recorded ones (the app clock is anchored to
 *     the recording instead — see `lib/clock.ts`);
 *   - it never talks to a backend, so "submitting" in the demo executes
 *     nothing, anywhere;
 *   - the UI labels the whole session as a recorded run, on every screen.
 */

import type {
  AuditEvent,
  CancellationResponse,
  ExecuteRequest,
  ExecuteResponse,
  ExplanationConfiguration,
  HealthResponse,
  MarketRow,
  MigrationDetails,
  PersistedPositionRow,
  PositionSnapshot,
  PreparedMigration,
  RouteAnalysisResponse,
  WalletChallenge,
  WalletSession,
} from '../api/types';
import { anchorClock, now } from '../clock';
import marketsRecording from './recordings/markets.json' with { type: 'json' };
import migrationRecording from './recordings/migration-settled.json' with { type: 'json' };
import historyRecording from './recordings/position-history.json' with { type: 'json' };
import prepareRecording from './recordings/prepare.json' with { type: 'json' };
import routesRecording from './recordings/route-analysis.json' with { type: 'json' };

const prepared = prepareRecording as unknown as PreparedMigration;
const routes = routesRecording as unknown as RouteAnalysisResponse;
const migration = migrationRecording as unknown as MigrationDetails;
const history = historyRecording as unknown as PersistedPositionRow[];
const markets = marketsRecording as unknown as MarketRow[];

/** The account the recording was made with. */
export const DEMO_ACCOUNT = prepared.intent.borrower;
/** The chain the recorded authorization is bound to. */
export const DEMO_CHAIN_ID = prepared.intent.sourcePosition.market.chainId;
/** The recorded migration the monitor replays. */
export const DEMO_MIGRATION_ID = migration.migration.migrationId;

/** How long each recorded step stays on screen during the replay. */
export const REPLAY_STEP_MS = 2_600;

/** Small pause so loading states are visible, as they would be on a network. */
function settle<T>(value: T, ms = 450): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function sortedEvents(details: MigrationDetails): AuditEvent[] {
  return [...details.events].sort((left, right) => left.sequence - right.sequence);
}

/**
 * The recorded migration as it stood after `step` of its events.
 *
 * Pure, so the replay can be tested without timers: step 0 is the first
 * recorded event, the last step is the complete recording.
 */
export function migrationAtStep(details: MigrationDetails, step: number): MigrationDetails {
  const events = sortedEvents(details);
  if (events.length === 0) return details;

  const index = Math.min(Math.max(step, 0), events.length - 1);
  if (index === events.length - 1) return details;

  const current = events[index]!;
  const cutoff = Date.parse(current.observedAt);

  return {
    ...details,
    migration: {
      ...details.migration,
      phase: current.phase,
      version: index,
      updatedAt: current.observedAt,
    },
    events: events.slice(0, index + 1),
    evidence: details.evidence.filter((item) => Date.parse(item.observedAt) <= cutoff),
    commands: details.commands
      .filter((command) => Date.parse(command.createdAt) <= cutoff)
      .map((command) =>
        // A command the recording finished later was still running at this point.
        Date.parse(command.updatedAt) > cutoff
          ? { ...command, status: 'RUNNING' as const, lastError: null }
          : command,
      ),
    ledger: [],
  };
}

/** Number of replay steps in the recorded migration. */
export function replayStepCount(details: MigrationDetails = migration): number {
  return Math.max(1, details.events.length);
}

export class DemoApi {
  readonly baseUrl = 'recorded://debtshift-sandbox';
  #replayStartedAt: number | undefined;

  health(): Promise<HealthResponse> {
    return Promise.resolve({
      service: 'debtshift-api',
      status: 'ok',
      timestamp: now().toISOString(),
    });
  }

  /*
   * The recorded demo has no backend, so it has no session to open. It
   * reports the recorded account as signed in and refuses to issue a
   * challenge: nothing in the demo ever asks a wallet to sign.
   */
  session(): Promise<WalletSession | undefined> {
    return Promise.resolve({
      wallet: DEMO_ACCOUNT,
      chainId: DEMO_CHAIN_ID,
      expiresAt: new Date(now().getTime() + 8 * 60 * 60 * 1000).toISOString(),
    });
  }

  authChallenge(): Promise<WalletChallenge> {
    return Promise.reject(new Error('The recorded demo does not sign in.'));
  }

  authVerify(): Promise<WalletSession> {
    return Promise.reject(new Error('The recorded demo does not sign in.'));
  }

  logout(): Promise<void> {
    return Promise.resolve();
  }

  position(): Promise<PositionSnapshot | undefined> {
    // Anchor the clock a few seconds after the recorded observation, so the
    // snapshot is fresh exactly as it was when it was read.
    anchorClock(Date.parse(prepared.sourceSnapshot.block.observedAt) + 4_000);
    return settle(prepared.sourceSnapshot);
  }

  positionHistory(): Promise<PersistedPositionRow[]> {
    return settle(history);
  }

  markets(): Promise<MarketRow[]> {
    return settle(markets, 150);
  }

  analyzeRoutes(
    _wallet?: string,
    _explanation?: ExplanationConfiguration,
  ): Promise<RouteAnalysisResponse> {
    return settle(routes, 700);
  }

  prepare(): Promise<PreparedMigration> {
    // Four minutes before the first recorded window closes: the countdowns
    // run against the recorded deadlines, which stay untouched.
    const firstWindowMs = Math.min(
      Date.parse(prepared.quote.expiresAt),
      Number(prepared.plan.deadline) * 1000,
      Number(prepared.intent.expiration) * 1000,
      Number(prepared.plan.financing.validUntil) * 1000,
    );
    anchorClock(firstWindowMs - 240_000);
    return settle(prepared, 900);
  }

  /** Executes nothing. Returns the id of the recorded migration to replay. */
  execute(_request?: ExecuteRequest): Promise<ExecuteResponse> {
    this.#replayStartedAt = undefined;
    return settle({ migrationId: DEMO_MIGRATION_ID, created: false }, 700);
  }

  /**
   * The recorded migration, replayed one recorded event at a time.
   *
   * Whatever id is asked for, the answer is the one recorded run — the demo
   * has no other. Opening the monitor starts the replay; it ends on the
   * recording's real final state and stays there.
   */
  migration(_migrationId?: string): Promise<MigrationDetails> {
    this.#replayStartedAt ??= Date.now();
    const elapsed = Date.now() - this.#replayStartedAt;
    const step = Math.floor(elapsed / REPLAY_STEP_MS);
    const details = migrationAtStep(migration, step);
    anchorClock(Date.parse(details.migration.updatedAt) + 800);
    return Promise.resolve(details);
  }

  /** A recording cannot be cancelled: it already happened. */
  cancelMigration(): Promise<CancellationResponse> {
    return Promise.reject(new Error('The recorded demo cannot cancel a migration.'));
  }

  /** No stream: the replay is driven by reading the recording. */
  migrationStreamUrl(): string | undefined {
    return undefined;
  }

  /** Start the migration replay again from its first recorded event. */
  restartReplay(): void {
    this.#replayStartedAt = undefined;
  }
}

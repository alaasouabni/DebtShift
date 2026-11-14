/*
 * The one HTTP boundary to the DebtShift API.
 *
 * Nothing else in the app calls `fetch`. Every response is validated here, and
 * every failure becomes an `ApiError` carrying the HTTP status and a stable
 * client code the UI can route on.
 *
 * Three rules this module enforces on itself:
 *   - an unparseable or unexpected response is NEVER treated as success;
 *   - a request body is never echoed into an error, a log or a message, because
 *     bodies can carry a user-supplied model API key;
 *   - the borrower session is an HttpOnly cookie the browser attaches. This
 *     code sends it along (`credentials: 'include'`) and never reads, stores
 *     or logs it.
 */

import type {
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
} from './types';
import { demoClient } from '../demo';
import { migrationStreamUrl as buildMigrationStreamUrl } from '../../components/migration-client';

/** Stable codes for UI routing. The HTTP status is preserved alongside. */
export type ApiErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SERVER'
  | 'MALFORMED'
  | 'UNKNOWN';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Every message the backend sent, already split out of `message[]`. */
  readonly messages: readonly string[];
  readonly path: string;

  constructor(options: {
    code: ApiErrorCode;
    status: number;
    messages: readonly string[];
    path: string;
  }) {
    const joined =
      options.messages.length > 0
        ? options.messages.join(' ')
        : `The request to ${options.path} failed.`;
    super(joined);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.messages = options.messages;
    this.path = options.path;
  }
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 400 || status === 422) return 'VALIDATION';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status >= 500) return 'SERVER';
  return 'UNKNOWN';
}

/**
 * Pull the messages out of a NestJS error envelope.
 *
 * NestJS sends `{ message: string | string[] }`, sometimes with `error` and
 * `statusCode` beside it. Anything else yields an empty list, and the caller
 * falls back to a generic sentence rather than rendering a raw object.
 */
export function normalizeErrorBody(body: unknown): readonly string[] {
  if (typeof body === 'string' && body.trim() !== '') return [body.trim()];
  if (body === null || typeof body !== 'object') return [];

  const record = body as Record<string, unknown>;
  const message = record.message;
  if (typeof message === 'string' && message.trim() !== '') return [message.trim()];
  if (Array.isArray(message)) {
    const parts = message
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .map((part) => part.trim());
    if (parts.length > 0) return parts;
  }
  if (typeof record.error === 'string' && record.error.trim() !== '') {
    return [record.error.trim()];
  }
  return [];
}

/*
 * Session loss.
 *
 * Every borrower route answers 401 once the session cookie is missing, expired
 * or revoked, and 403 when it belongs to another wallet. Either way the app
 * has to ask for a new proof of wallet control, so the wallet layer subscribes
 * here instead of every screen handling it on its own.
 */
export type SessionLostReason = 'missing' | 'mismatch';
type SessionLostListener = (reason: SessionLostReason) => void;
const sessionLostListeners = new Set<SessionLostListener>();

/** Be told when a borrower route rejected the session. Returns the unsubscribe. */
export function onSessionLost(listener: SessionLostListener): () => void {
  sessionLostListeners.add(listener);
  return () => {
    sessionLostListeners.delete(listener);
  };
}

function reportSessionLost(reason: SessionLostReason): void {
  for (const listener of sessionLostListeners) listener(reason);
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function resolveBaseUrl(explicit?: string): string {
  const configured = explicit ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/v1';
  return configured.replace(/\/+$/u, '');
}

export class DebtShiftApi {
  readonly #baseUrl: string;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.#baseUrl = resolveBaseUrl(options.baseUrl);
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async #request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal | undefined } = {
      method: 'GET',
    },
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // Built conditionally rather than with undefined members: the repo compiles
    // with exactOptionalPropertyTypes, and `headers: undefined` is not the same
    // as an absent `headers`.
    // `credentials: 'include'` on every request: the session cookie is the
    // only thing that identifies the borrower to the API.
    const request: RequestInit =
      init.body === undefined
        ? { method: init.method, credentials: 'include', signal: controller.signal }
        : {
            method: init.method,
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(init.body),
            signal: controller.signal,
          };

    let response: Response;
    try {
      response = await this.#fetcher(url, request);
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ApiError({
        code: aborted ? 'TIMEOUT' : 'NETWORK',
        status: 0,
        messages: [
          aborted
            ? 'The API did not answer in time.'
            : 'The API could not be reached. Is it running on this machine?',
        ],
        path,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed: unknown;
    let parseFailed = false;
    if (text.trim() === '') {
      parsed = undefined;
    } else {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parseFailed = true;
      }
    }

    if (!response.ok) {
      const messages = parseFailed ? [] : normalizeErrorBody(parsed);
      // The login routes answer 401 as part of their normal contract (a bad
      // signature, or simply nobody signed in). Only a borrower route
      // rejecting the session means the session was lost.
      if (!path.startsWith('/auth/')) {
        if (response.status === 401) reportSessionLost('missing');
        else if (response.status === 403) reportSessionLost('mismatch');
      }
      throw new ApiError({
        code: codeForStatus(response.status),
        status: response.status,
        messages,
        path,
      });
    }

    // A 2xx whose body we cannot read is a failure, not a success.
    if (parseFailed || parsed === undefined) {
      throw new ApiError({
        code: 'MALFORMED',
        status: response.status,
        messages: ['The API returned a response this client could not read.'],
        path,
      });
    }

    return parsed as T;
  }

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.#request<HealthResponse>('/health', { method: 'GET', signal });
  }

  /**
   * Ask for a one-time login message for `wallet`. Public route.
   *
   * The message is returned for the wallet to sign as-is; nothing here may
   * alter it.
   */
  authChallenge(wallet: string, signal?: AbortSignal): Promise<WalletChallenge> {
    return this.#request<WalletChallenge>('/auth/challenge', {
      method: 'POST',
      body: { wallet },
      signal,
    });
  }

  /**
   * Exchange the signed challenge for a session. The API answers with the
   * session's public facts and sets the HttpOnly cookie itself.
   */
  async authVerify(
    challengeId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<WalletSession> {
    const body = await this.#request<{ session?: WalletSession }>('/auth/verify', {
      method: 'POST',
      body: { challengeId, signature },
      signal,
    });
    return readSession(body, '/auth/verify');
  }

  /** The current session, or `undefined` when nobody is signed in. */
  async session(signal?: AbortSignal): Promise<WalletSession | undefined> {
    try {
      const body = await this.#request<{ session?: WalletSession }>('/auth/session', {
        method: 'GET',
        signal,
      });
      return readSession(body, '/auth/session');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'UNAUTHORIZED') return undefined;
      throw caught;
    }
  }

  /** Revoke the session on the server and expire its cookie. */
  async logout(signal?: AbortSignal): Promise<void> {
    try {
      await this.#request<{ revoked: boolean }>('/auth/logout', { method: 'POST', signal });
    } catch (caught) {
      // Already signed out is the outcome that was asked for.
      if (caught instanceof ApiError && caught.code === 'UNAUTHORIZED') return;
      throw caught;
    }
  }

  /**
   * The live source position.
   *
   * The controller returns an ARRAY wrapping one snapshot
   * (`return [await preparation.getPosition(wallet)]`), so this method unwraps
   * it and returns `undefined` when the wallet has no supported position.
   */
  async position(wallet: string, signal?: AbortSignal): Promise<PositionSnapshot | undefined> {
    const rows = await this.#request<PositionSnapshot[]>(
      `/positions/${encodeURIComponent(wallet)}`,
      { method: 'GET', signal },
    );
    if (!Array.isArray(rows)) {
      throw new ApiError({
        code: 'MALFORMED',
        status: 200,
        messages: ['The position endpoint did not return a list.'],
        path: `/positions/${wallet}`,
      });
    }
    return rows[0];
  }

  positionHistory(wallet: string, signal?: AbortSignal): Promise<PersistedPositionRow[]> {
    return this.#request<PersistedPositionRow[]>(
      `/positions/${encodeURIComponent(wallet)}/history`,
      { method: 'GET', signal },
    );
  }

  markets(signal?: AbortSignal): Promise<MarketRow[]> {
    return this.#request<MarketRow[]>('/markets', { method: 'GET', signal });
  }

  analyzeRoutes(
    wallet: string,
    explanation?: ExplanationConfiguration,
    signal?: AbortSignal,
  ): Promise<RouteAnalysisResponse> {
    return this.#request<RouteAnalysisResponse>('/analysis/routes', {
      method: 'POST',
      body: explanation === undefined ? { wallet } : { wallet, explanation },
      signal,
    });
  }

  prepare(borrower: string, signal?: AbortSignal): Promise<PreparedMigration> {
    return this.#request<PreparedMigration>('/migrations/prepare', {
      method: 'POST',
      body: { borrower },
      signal,
    });
  }

  /**
   * Start the migration.
   *
   * `request` must hold the EXACT objects `prepare` returned. Do not rebuild,
   * round, reorder or re-serialize them on the way here.
   */
  execute(request: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse> {
    return this.#request<ExecuteResponse>('/migrations/execute', {
      method: 'POST',
      body: request,
      signal,
    });
  }

  migration(migrationId: string, signal?: AbortSignal): Promise<MigrationDetails> {
    return this.#request<MigrationDetails>(`/migrations/${encodeURIComponent(migrationId)}`, {
      method: 'GET',
      signal,
    });
  }

  /**
   * Ask the backend to cancel a migration before its source loan is touched.
   *
   * The answer is a request acknowledgement, not a result: the phase may still
   * be RESERVED while the workflow releases the reservation. Only a later read
   * of the migration says CANCELLED.
   */
  cancelMigration(migrationId: string, signal?: AbortSignal): Promise<CancellationResponse> {
    return this.#request<CancellationResponse>(
      `/migrations/${encodeURIComponent(migrationId)}/cancel`,
      { method: 'POST', signal },
    );
  }

  /**
   * Where the migration's audit-event stream is served, resuming after the
   * last event already read. A stream event is a prompt to re-read the
   * migration; it is never itself the state.
   */
  migrationStreamUrl(migrationId: string, afterSequence: number): string | undefined {
    try {
      return buildMigrationStreamUrl(this.#baseUrl, migrationId, afterSequence);
    } catch {
      // An id or cursor the stream would refuse: read by polling instead.
      return undefined;
    }
  }
}

function readSession(body: { session?: WalletSession }, path: string): WalletSession {
  const session = body.session;
  if (
    session === undefined ||
    session === null ||
    typeof session.wallet !== 'string' ||
    typeof session.expiresAt !== 'string'
  ) {
    throw new ApiError({
      code: 'MALFORMED',
      status: 200,
      messages: ['The API returned a session this client could not read.'],
      path,
    });
  }
  return session;
}

/** The calls every screen makes. The live client and the recorded demo both answer them. */
export interface ApiSurface {
  readonly baseUrl: string;
  health(signal?: AbortSignal): Promise<HealthResponse>;
  authChallenge(wallet: string, signal?: AbortSignal): Promise<WalletChallenge>;
  authVerify(challengeId: string, signature: string, signal?: AbortSignal): Promise<WalletSession>;
  session(signal?: AbortSignal): Promise<WalletSession | undefined>;
  logout(signal?: AbortSignal): Promise<void>;
  position(wallet: string, signal?: AbortSignal): Promise<PositionSnapshot | undefined>;
  positionHistory(wallet: string, signal?: AbortSignal): Promise<PersistedPositionRow[]>;
  markets(signal?: AbortSignal): Promise<MarketRow[]>;
  analyzeRoutes(
    wallet: string,
    explanation?: ExplanationConfiguration,
    signal?: AbortSignal,
  ): Promise<RouteAnalysisResponse>;
  prepare(borrower: string, signal?: AbortSignal): Promise<PreparedMigration>;
  execute(request: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse>;
  migration(migrationId: string, signal?: AbortSignal): Promise<MigrationDetails>;
  cancelMigration(migrationId: string, signal?: AbortSignal): Promise<CancellationResponse>;
  /** `undefined` when there is no stream to open, as in the recorded demo. */
  migrationStreamUrl(migrationId: string, afterSequence: number): string | undefined;
}

const liveClient = new DebtShiftApi();

/** The live client, or the recorded one while this tab is in the demo. */
function current(): ApiSurface {
  return demoClient() ?? liveClient;
}

/**
 * The shared browser client.
 *
 * A thin facade: each call goes to the live API, or to the recorded demo when
 * the demo is active. The choice is made per call, so a reload in the middle
 * of the demo can never fall through to a real backend, and leaving the demo
 * takes effect immediately.
 */
export const api: ApiSurface = {
  get baseUrl() {
    return current().baseUrl;
  },
  health: (signal) => current().health(signal),
  authChallenge: (wallet, signal) => current().authChallenge(wallet, signal),
  authVerify: (challengeId, signature, signal) =>
    current().authVerify(challengeId, signature, signal),
  session: (signal) => current().session(signal),
  logout: (signal) => current().logout(signal),
  position: (wallet, signal) => current().position(wallet, signal),
  positionHistory: (wallet, signal) => current().positionHistory(wallet, signal),
  markets: (signal) => current().markets(signal),
  analyzeRoutes: (wallet, explanation, signal) =>
    current().analyzeRoutes(wallet, explanation, signal),
  prepare: (borrower, signal) => current().prepare(borrower, signal),
  execute: (request, signal) => current().execute(request, signal),
  migration: (migrationId, signal) => current().migration(migrationId, signal),
  cancelMigration: (migrationId, signal) => current().cancelMigration(migrationId, signal),
  migrationStreamUrl: (migrationId, afterSequence) =>
    current().migrationStreamUrl(migrationId, afterSequence),
};

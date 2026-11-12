/*
 * The one HTTP boundary to the DebtShift API.
 *
 * Nothing else in the app calls `fetch`. Every response is validated here, and
 * every failure becomes an `ApiError` carrying the HTTP status and a stable
 * client code the UI can route on.
 *
 * Two rules this module enforces on itself:
 *   - an unparseable or unexpected response is NEVER treated as success;
 *   - a request body is never echoed into an error, a log or a message, because
 *     bodies can carry a user-supplied model API key.
 */

import type {
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
} from './types';

/** Stable codes for UI routing. The HTTP status is preserved alongside. */
export type ApiErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
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
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
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
    const request: RequestInit =
      init.body === undefined
        ? { method: init.method, signal: controller.signal }
        : {
            method: init.method,
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
}

/** The shared browser client. */
export const api = new DebtShiftApi();

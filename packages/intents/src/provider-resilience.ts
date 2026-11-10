export interface ProviderRequestGovernorConfig {
  readonly maximumAttempts: number;
  readonly baseRetryDelayMs: number;
  readonly maximumRetryDelayMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitResetMs: number;
  readonly rateLimitCapacity: number;
  readonly rateLimitWindowMs: number;
  readonly maximumCacheEntries: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

export interface GovernedRequestOptions<T> {
  readonly key: string;
  readonly operation: () => Promise<T>;
  readonly shouldRetry: (error: unknown) => boolean;
  readonly cacheTtlMs?: number;
}

export interface ProviderGovernorSnapshot {
  readonly circuit: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly consecutiveFailures: number;
  readonly cachedEntries: number;
  readonly inFlightRequests: number;
}

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/**
 * In-process provider guard for one replica. Upstream gateways still need a
 * distributed quota, but every process independently enforces bounded retry,
 * token-bucket rate limiting, request coalescing, caching, and a circuit.
 */
export class ProviderRequestGovernor {
  readonly #config: ProviderRequestGovernorConfig;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  #availableTokens: number;
  #lastTokenRefillAt: number;
  #consecutiveFailures = 0;
  #circuitOpenedAt: number | undefined;
  #halfOpenInFlight = false;

  constructor(config: ProviderRequestGovernorConfig) {
    assertIntegerInRange(config.maximumAttempts, 1, 10, 'maximum attempts');
    assertIntegerInRange(config.baseRetryDelayMs, 1, 60_000, 'base retry delay');
    assertIntegerInRange(
      config.maximumRetryDelayMs,
      config.baseRetryDelayMs,
      120_000,
      'maximum retry delay',
    );
    assertIntegerInRange(config.circuitFailureThreshold, 1, 100, 'circuit failure threshold');
    assertIntegerInRange(config.circuitResetMs, 100, 600_000, 'circuit reset');
    assertIntegerInRange(config.rateLimitCapacity, 1, 10_000, 'rate limit capacity');
    assertIntegerInRange(config.rateLimitWindowMs, 100, 60_000, 'rate limit window');
    assertIntegerInRange(config.maximumCacheEntries, 1, 10_000, 'maximum cache entries');
    this.#config = config;
    this.#now = config.now ?? Date.now;
    this.#sleep =
      config.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = config.random ?? Math.random;
    this.#availableTokens = config.rateLimitCapacity;
    this.#lastTokenRefillAt = this.#now();
  }

  execute<T>(options: GovernedRequestOptions<T>): Promise<T> {
    if (options.key.trim().length === 0) throw new Error('Provider request key cannot be empty.');
    if (
      options.cacheTtlMs !== undefined &&
      (!Number.isInteger(options.cacheTtlMs) || options.cacheTtlMs <= 0)
    ) {
      throw new Error('Provider cache TTL must be a positive integer.');
    }
    this.#removeExpiredCacheEntries();
    const cached = this.#cache.get(options.key);
    if (cached !== undefined) return Promise.resolve(cached.value as T);
    const existing = this.#inFlight.get(options.key);
    if (existing !== undefined) return existing as Promise<T>;

    const request = this.#executeUncoalesced(options).finally(() => {
      this.#inFlight.delete(options.key);
    });
    this.#inFlight.set(options.key, request);
    return request;
  }

  snapshot(): ProviderGovernorSnapshot {
    return {
      circuit: this.#currentCircuitState(),
      consecutiveFailures: this.#consecutiveFailures,
      cachedEntries: this.#cache.size,
      inFlightRequests: this.#inFlight.size,
    };
  }

  async #executeUncoalesced<T>(options: GovernedRequestOptions<T>): Promise<T> {
    const circuit = this.#currentCircuitState();
    if (circuit === 'OPEN') throw new Error('Provider circuit is open.');
    if (circuit === 'HALF_OPEN') {
      if (this.#halfOpenInFlight) throw new Error('Provider circuit probe is already in flight.');
      this.#halfOpenInFlight = true;
    }
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= this.#config.maximumAttempts; attempt += 1) {
        await this.#acquireRateLimitToken();
        try {
          const value = await options.operation();
          this.#recordSuccess();
          if (options.cacheTtlMs !== undefined) {
            this.#storeCacheEntry(options.key, value, options.cacheTtlMs);
          }
          return value;
        } catch (error) {
          lastError = error;
          if (!options.shouldRetry(error) || attempt === this.#config.maximumAttempts) break;
          await this.#sleep(this.#retryDelay(attempt));
        }
      }
      if (options.shouldRetry(lastError)) this.#recordFailure();
      throw lastError;
    } finally {
      if (circuit === 'HALF_OPEN') this.#halfOpenInFlight = false;
    }
  }

  async #acquireRateLimitToken(): Promise<void> {
    while (true) {
      const now = this.#now();
      const elapsed = Math.max(0, now - this.#lastTokenRefillAt);
      const refill = (elapsed * this.#config.rateLimitCapacity) / this.#config.rateLimitWindowMs;
      this.#availableTokens = Math.min(
        this.#config.rateLimitCapacity,
        this.#availableTokens + refill,
      );
      this.#lastTokenRefillAt = now;
      if (this.#availableTokens >= 1) {
        this.#availableTokens -= 1;
        return;
      }
      const missing = 1 - this.#availableTokens;
      const waitMs = Math.max(
        1,
        Math.ceil((missing * this.#config.rateLimitWindowMs) / this.#config.rateLimitCapacity),
      );
      await this.#sleep(waitMs);
    }
  }

  #retryDelay(failedAttempt: number): number {
    const exponential = Math.min(
      this.#config.maximumRetryDelayMs,
      this.#config.baseRetryDelayMs * 2 ** (failedAttempt - 1),
    );
    const jitterMultiplier = 0.5 + this.#random() * 0.5;
    return Math.max(1, Math.floor(exponential * jitterMultiplier));
  }

  #recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#circuitOpenedAt = undefined;
  }

  #recordFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#config.circuitFailureThreshold) {
      this.#circuitOpenedAt = this.#now();
    }
  }

  #currentCircuitState(): ProviderGovernorSnapshot['circuit'] {
    if (this.#circuitOpenedAt === undefined) return 'CLOSED';
    if (this.#now() - this.#circuitOpenedAt < this.#config.circuitResetMs) return 'OPEN';
    return 'HALF_OPEN';
  }

  #storeCacheEntry(key: string, value: unknown, ttlMs: number): void {
    if (this.#cache.size >= this.#config.maximumCacheEntries && !this.#cache.has(key)) {
      const oldestKey = this.#cache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.#cache.delete(oldestKey);
    }
    this.#cache.delete(key);
    this.#cache.set(key, { value, expiresAt: this.#now() + ttlMs });
  }

  #removeExpiredCacheEntries(): void {
    const now = this.#now();
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= now) this.#cache.delete(key);
    }
  }
}

function assertIntegerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Provider ${name} must be between ${minimum} and ${maximum}.`);
  }
}

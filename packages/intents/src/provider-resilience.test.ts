import { describe, expect, it, vi } from 'vitest';

import {
  ProviderRequestGovernor,
  type ProviderRequestGovernorConfig,
} from './provider-resilience.js';

function createGovernor(overrides: Partial<ProviderRequestGovernorConfig> = {}): {
  readonly governor: ProviderRequestGovernor;
  readonly advance: (milliseconds: number) => void;
  readonly sleeps: number[];
} {
  let now = 1_000;
  const sleeps: number[] = [];
  const config: ProviderRequestGovernorConfig = {
    maximumAttempts: 3,
    baseRetryDelayMs: 100,
    maximumRetryDelayMs: 1_000,
    circuitFailureThreshold: 2,
    circuitResetMs: 5_000,
    rateLimitCapacity: 2,
    rateLimitWindowMs: 1_000,
    maximumCacheEntries: 10,
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    random: () => 1,
    ...overrides,
  };
  return {
    governor: new ProviderRequestGovernor(config),
    advance: (milliseconds) => {
      now += milliseconds;
    },
    sleeps,
  };
}

describe('ProviderRequestGovernor', () => {
  it('coalesces concurrent calls and serves a bounded cache entry', async () => {
    const { governor, advance } = createGovernor();
    let resolveOperation: ((value: string) => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOperation = resolve;
        }),
    );
    const options = {
      key: 'catalog',
      operation,
      shouldRetry: () => true,
      cacheTtlMs: 1_000,
    };

    const first = governor.execute(options);
    const concurrent = governor.execute(options);
    await Promise.resolve();
    resolveOperation?.('value');
    await expect(Promise.all([first, concurrent])).resolves.toEqual(['value', 'value']);
    await expect(governor.execute(options)).resolves.toBe('value');
    expect(operation).toHaveBeenCalledTimes(1);

    advance(1_001);
    operation.mockResolvedValueOnce('refreshed');
    await expect(governor.execute(options)).resolves.toBe('refreshed');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries retryable failures with bounded backoff and token-bucket waits', async () => {
    const { governor, sleeps } = createGovernor();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('ok');

    await expect(
      governor.execute({ key: 'quote', operation, shouldRetry: () => true }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200, 200]);
  });

  it('opens after consecutive request failures and recovers through one half-open probe', async () => {
    const { governor, advance } = createGovernor({ maximumAttempts: 1 });
    const failure = () => Promise.reject(new Error('offline'));
    const options = { key: 'first', operation: failure, shouldRetry: () => true };

    await expect(governor.execute(options)).rejects.toThrow('offline');
    await expect(governor.execute({ ...options, key: 'second' })).rejects.toThrow('offline');
    expect(governor.snapshot().circuit).toBe('OPEN');
    await expect(governor.execute({ ...options, key: 'third' })).rejects.toThrow(
      'Provider circuit is open',
    );

    advance(5_001);
    await expect(
      governor.execute({
        key: 'probe',
        operation: async () => 'healthy',
        shouldRetry: () => true,
      }),
    ).resolves.toBe('healthy');
    expect(governor.snapshot()).toMatchObject({ circuit: 'CLOSED', consecutiveFailures: 0 });
  });

  it('does not retry or trip the circuit for non-retryable failures', async () => {
    const { governor } = createGovernor();
    const operation = vi.fn(async () => {
      throw new Error('invalid request');
    });
    await expect(
      governor.execute({ key: 'invalid', operation, shouldRetry: () => false }),
    ).rejects.toThrow('invalid request');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(governor.snapshot()).toMatchObject({ circuit: 'CLOSED', consecutiveFailures: 0 });
  });
});

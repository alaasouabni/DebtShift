import { afterEach, describe, expect, it, vi } from 'vitest';

import prepared from '../../lib/demo/recordings/prepare.json' with { type: 'json' };
import {
  canSubmit,
  defaultBadge,
  defaultEnvironmentMode,
  environmentBadge,
  readEnvironment,
  submitBlockedReason,
  transportIsSimulated,
  type BackendEnvironment,
} from './index';

function environment(overrides: Partial<BackendEnvironment> = {}): BackendEnvironment {
  return {
    mode: 'sandbox',
    transportProvider: 'DEBTSHIFT_SIMULATOR',
    executionEnabled: true,
    source: 'environment',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function execution(overrides: Record<string, unknown> = {}) {
  return {
    execution: {
      mode: 'sandbox',
      transportProvider: 'DEBTSHIFT_SIMULATOR',
      transportMode: 'SIMULATED',
      simulatedTransport: true,
      fundedExecutionEnabled: true,
      warning: 'w',
      ...overrides,
    },
  };
}

describe('readEnvironment — the shape the API returns', () => {
  it('reads the real captured prepare response as a sandbox', () => {
    // The fixture is a real response from the API of 2026-11-13.
    const result = readEnvironment(prepared);
    expect(result).toEqual({
      mode: 'sandbox',
      transportProvider: 'DEBTSHIFT_SIMULATOR',
      executionEnabled: true,
      simulatedTransport: true,
      warning:
        'Contract-backed sandbox: test assets and an explicitly simulated external transport provider.',
      source: 'execution',
    });
    expect(canSubmit(result)).toBe(true);
  });

  it('reads every mode', () => {
    for (const mode of ['sandbox', 'testnet', 'mainnet-readonly', 'mainnet'] as const) {
      expect(readEnvironment(execution({ mode }))?.mode).toBe(mode);
    }
  });

  it('takes the execution capability from fundedExecutionEnabled', () => {
    expect(readEnvironment(execution({ fundedExecutionEnabled: false }))?.executionEnabled).toBe(
      false,
    );
  });

  it('wins over both older shapes when a response carries several', () => {
    const result = readEnvironment({
      ...execution({ mode: 'testnet' }),
      environment: {
        mode: 'mainnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        executionEnabled: true,
      },
      simulation: { provider: 'DEBTSHIFT_SIMULATOR', mode: 'SIMULATED', warning: 'old' },
    });
    expect(result?.mode).toBe('testnet');
    expect(result?.source).toBe('execution');
  });

  it('does not guess when a field is missing or of the wrong type', () => {
    expect(readEnvironment(execution({ mode: 'production' }))).toBeUndefined();
    expect(readEnvironment(execution({ fundedExecutionEnabled: 'true' }))).toBeUndefined();
    expect(readEnvironment(execution({ simulatedTransport: undefined }))).toBeUndefined();
    expect(readEnvironment(execution({ transportProvider: 'SOMETHING' }))).toBeUndefined();
  });

  it('does not fall back to an older shape when this one is malformed', () => {
    const result = readEnvironment({
      ...execution({ mode: 'nope' }),
      simulation: { provider: 'DEBTSHIFT_SIMULATOR', mode: 'SIMULATED', warning: 'old' },
    });
    expect(result).toBeUndefined();
  });

  it('blocks submission in any mode when the backend says funded execution is off', () => {
    const off = readEnvironment(execution({ mode: 'testnet', fundedExecutionEnabled: false }));
    expect(canSubmit(off)).toBe(false);
    expect(submitBlockedReason(off)).toMatch(/funded execution as disabled/i);
  });

  it('trusts the backend on whether the transport is simulated', () => {
    // On testnet the transport is simulated whatever the provider is called.
    const testnet = readEnvironment(
      execution({
        mode: 'testnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        simulatedTransport: true,
      }),
    );
    expect(transportIsSimulated(testnet)).toBe(true);
    const live = readEnvironment(
      execution({
        mode: 'mainnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        simulatedTransport: false,
      }),
    );
    expect(transportIsSimulated(live)).toBe(false);
  });
});

describe('readEnvironment — the legacy shape, still in older recordings', () => {
  it('reads a simulation block as the sandbox', () => {
    const result = readEnvironment({
      simulation: {
        provider: 'DEBTSHIFT_SIMULATOR',
        mode: 'SIMULATED',
        warning: 'This route uses test assets and is not a 1Click testnet transaction.',
      },
    });
    expect(result).toEqual({
      mode: 'sandbox',
      transportProvider: 'DEBTSHIFT_SIMULATOR',
      executionEnabled: true,
      warning: 'This route uses test assets and is not a 1Click testnet transaction.',
      source: 'legacy-simulation',
    });
  });
});

describe('readEnvironment — the interim shape the handoff once specified', () => {
  it('reads every mode', () => {
    for (const mode of ['sandbox', 'testnet', 'mainnet-readonly', 'mainnet'] as const) {
      const result = readEnvironment({
        environment: { mode, transportProvider: 'NEAR_INTENTS_1CLICK', executionEnabled: false },
      });
      expect(result?.mode, mode).toBe(mode);
      expect(result?.source).toBe('environment');
    }
  });

  it('keeps the optional warning and tolerates its absence', () => {
    const base = {
      mode: 'testnet',
      transportProvider: 'DEBTSHIFT_SIMULATOR',
      executionEnabled: true,
    };
    expect(readEnvironment({ environment: { ...base, warning: 'Test assets.' } })?.warning).toBe(
      'Test assets.',
    );
    expect(readEnvironment({ environment: base })?.warning).toBeUndefined();
  });

  it('prefers the new shape when a response carries both', () => {
    const result = readEnvironment({
      simulation: { provider: 'DEBTSHIFT_SIMULATOR', mode: 'SIMULATED', warning: 'old' },
      environment: {
        mode: 'mainnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        executionEnabled: false,
      },
    });
    expect(result?.mode).toBe('mainnet');
  });
});

describe('readEnvironment — failing closed', () => {
  it('returns nothing when the response carries neither shape', () => {
    expect(readEnvironment({ intent: {}, plan: {} })).toBeUndefined();
    expect(readEnvironment(undefined)).toBeUndefined();
    expect(readEnvironment(null)).toBeUndefined();
  });

  it('does not patch up an unknown mode with a default', () => {
    expect(
      readEnvironment({
        environment: {
          mode: 'staging',
          transportProvider: 'DEBTSHIFT_SIMULATOR',
          executionEnabled: true,
        },
      }),
    ).toBeUndefined();
  });

  it('does not guess a missing or non-boolean execution capability', () => {
    expect(
      readEnvironment({
        environment: { mode: 'mainnet', transportProvider: 'NEAR_INTENTS_1CLICK' },
      }),
    ).toBeUndefined();
    expect(
      readEnvironment({
        environment: {
          mode: 'mainnet',
          transportProvider: 'NEAR_INTENTS_1CLICK',
          executionEnabled: 'true',
        },
      }),
    ).toBeUndefined();
  });

  it('does not fall back to the legacy shape when the new one is malformed', () => {
    // A broken `environment` must not be silently replaced by a comfortable
    // sandbox reading from a leftover `simulation` field.
    expect(
      readEnvironment({
        simulation: { provider: 'DEBTSHIFT_SIMULATOR', mode: 'SIMULATED', warning: 'old' },
        environment: { mode: 'mainnet' },
      }),
    ).toBeUndefined();
  });

  it('ignores a legacy block from an unknown provider', () => {
    expect(readEnvironment({ simulation: { provider: 'SOMETHING_ELSE' } })).toBeUndefined();
  });
});

describe('environmentBadge — the contract wording', () => {
  it('uses the sandbox and testnet wording', () => {
    expect(environmentBadge(environment()).label).toBe('Contract-backed sandbox · test funds');
    expect(environmentBadge(environment({ mode: 'testnet' })).label).toBe(
      'Public testnet · simulated transport',
    );
  });

  it('says mainnet execution is disabled while the backend reports it so', () => {
    const badge = environmentBadge(
      environment({
        mode: 'mainnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        executionEnabled: false,
      }),
    );
    expect(badge.label).toBe('Mainnet execution disabled');
    expect(badge.title).toMatch(/Only the server can change that/);
  });

  it('is loud when the backend reports mainnet execution enabled', () => {
    const badge = environmentBadge(
      environment({
        mode: 'mainnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        executionEnabled: true,
      }),
    );
    expect(badge.label).toBe('Mainnet · real funds');
    expect(badge.tone).toBe('danger');
  });

  it('never calls a sandbox or a testnet a 1Click testnet', () => {
    for (const mode of ['sandbox', 'testnet'] as const) {
      const badge = environmentBadge(environment({ mode }));
      expect(`${badge.label} ${badge.title}`).not.toMatch(/1Click testnet(?! \.)/);
    }
  });

  it('has its own wording when nothing was reported', () => {
    const badge = environmentBadge(undefined);
    expect(badge.label).toBe('Environment not reported');
    expect(badge.tone).toBe('warning');
  });
});

describe('canSubmit', () => {
  it('allows the sandbox and the testnet, where the workflow must execute', () => {
    expect(canSubmit(environment())).toBe(true);
    expect(canSubmit(environment({ mode: 'testnet' }))).toBe(true);
  });

  it('never allows a read-only environment, whatever the flag says', () => {
    expect(canSubmit(environment({ mode: 'mainnet-readonly', executionEnabled: true }))).toBe(
      false,
    );
  });

  it('follows the backend switch on mainnet', () => {
    expect(canSubmit(environment({ mode: 'mainnet', executionEnabled: false }))).toBe(false);
    expect(canSubmit(environment({ mode: 'mainnet', executionEnabled: true }))).toBe(true);
  });

  it('refuses when the environment is unknown', () => {
    expect(canSubmit(undefined)).toBe(false);
  });
});

describe('submitBlockedReason', () => {
  it('explains each refusal and stays silent when submission is allowed', () => {
    expect(submitBlockedReason(environment())).toBeUndefined();
    expect(submitBlockedReason(undefined)).toMatch(/did not report an environment/);
    expect(submitBlockedReason(environment({ mode: 'mainnet-readonly' }))).toMatch(/read-only/);
    expect(submitBlockedReason(environment({ mode: 'mainnet', executionEnabled: false }))).toMatch(
      /Nothing in this browser can enable it/,
    );
  });
});

describe('transportIsSimulated', () => {
  it('follows the transport provider, not the mode', () => {
    expect(transportIsSimulated(environment())).toBe(true);
    expect(transportIsSimulated(environment({ transportProvider: 'NEAR_INTENTS_1CLICK' }))).toBe(
      false,
    );
    expect(transportIsSimulated(undefined)).toBe(false);
  });
});

describe('the label shown before the backend reports', () => {
  it('reads the deployment configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_DEBTSHIFT_MODE', 'testnet');
    expect(defaultEnvironmentMode()).toBe('testnet');
  });

  it('ignores a value that is not a mode', () => {
    vi.stubEnv('NEXT_PUBLIC_DEBTSHIFT_MODE', 'production');
    expect(defaultEnvironmentMode()).toBeUndefined();
  });

  it('says it is not yet reported when nothing is configured', () => {
    expect(defaultBadge(undefined).label).toBe('Environment not reported yet');
  });

  it('never claims mainnet execution is enabled from configuration alone', () => {
    // Only a backend report may say that.
    expect(defaultBadge('mainnet').label).toBe('Mainnet execution disabled');
  });

  it('marks a configured label as unconfirmed', () => {
    expect(defaultBadge('sandbox').title).toMatch(/the backend confirms it on prepare/);
  });
});

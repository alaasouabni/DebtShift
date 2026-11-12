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

describe('readEnvironment — the legacy shape the API returns today', () => {
  it('reads the real captured prepare response as a sandbox', () => {
    // The fixture is a real response: it carries `simulation`, not `environment`.
    const result = readEnvironment(prepared);
    expect(result).toEqual({
      mode: 'sandbox',
      transportProvider: 'DEBTSHIFT_SIMULATOR',
      executionEnabled: true,
      warning: 'This route uses test assets and is not a 1Click testnet transaction.',
      source: 'legacy-simulation',
    });
  });
});

describe('readEnvironment — the shape the contract now specifies', () => {
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

import { describe, expect, it } from 'vitest';

import { parseDebtShiftEnvironment } from './environment.js';

describe('parseDebtShiftEnvironment', () => {
  it('defaults to the deterministic local simulator', () => {
    const environment = parseDebtShiftEnvironment({});

    expect(environment.DEBTSHIFT_ENV).toBe('local');
    expect(environment.TRANSPORT_PROVIDER).toBe('DEBTSHIFT_SIMULATOR');
    expect(environment.AGENT_MODE).toBe('DETERMINISTIC');
    expect(environment.MAINNET_CANARY_ENABLED).toBe(false);
  });

  it('rejects production transport in a local environment', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_ENV: 'local',
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet-canary',
      }),
    ).toThrow('Local, CI, and testnet environments require the DebtShift simulator.');
  });

  it('rejects general funded mainnet execution', () => {
    expect(() => parseDebtShiftEnvironment({ DEBTSHIFT_ENV: 'mainnet-controlled' })).toThrow(
      'General funded mainnet refinancing is disabled in this release.',
    );
  });

  it('requires a fully bounded canary configuration', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_ENV: 'mainnet-canary',
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet-canary',
        MAINNET_CANARY_ENABLED: 'true',
      }),
    ).toThrow('Mainnet canary mode requires an enabled, capped, fully allowlisted route.');
  });
});

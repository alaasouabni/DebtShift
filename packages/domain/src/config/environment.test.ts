import { describe, expect, it } from 'vitest';

import { parseDebtShiftEnvironment } from './environment.js';

describe('parseDebtShiftEnvironment', () => {
  it('defaults to the deterministic local simulator', () => {
    const environment = parseDebtShiftEnvironment({});

    expect(environment.DEBTSHIFT_ENV).toBe('local');
    expect(environment.MARKET_DATA_PROVIDER).toBe('SIMULATOR');
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
    ).toThrow('Mainnet canary mode requires disabled lending data');
  });

  it('prevents simulator market data from loading in mainnet read-only mode', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_ENV: 'mainnet-readonly',
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet-readonly',
      }),
    ).toThrow('Mainnet read-only mode must use live market data');
  });

  it('requires the isolated canary to disable lending market providers', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_ENV: 'mainnet-canary',
        MARKET_DATA_PROVIDER: 'SIMULATOR',
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet-canary',
        MAINNET_CANARY_ENABLED: 'true',
        MAINNET_CANARY_ORIGIN_ASSET: 'origin',
        MAINNET_CANARY_DESTINATION_ASSET: 'destination',
        MAINNET_CANARY_MAX_INPUT_UNITS: '1',
        MAINNET_CANARY_RECIPIENT: 'recipient',
        MAINNET_CANARY_REFUND_RECEIVER: 'refund',
      }),
    ).toThrow('Mainnet canary mode requires disabled lending data');
  });

  it('rejects a retry ceiling below the configured base delay', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        INTENTS_RETRY_BASE_DELAY_MS: '1000',
        INTENTS_RETRY_MAX_DELAY_MS: '999',
      }),
    ).toThrow('maximum retry delay cannot be lower');
  });
});

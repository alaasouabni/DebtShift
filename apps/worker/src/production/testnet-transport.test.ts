import { describe, expect, it } from 'vitest';

import {
  assertFundedTestnetTransportReadiness,
  type FundedTestnetTransportReadiness,
} from './testnet-transport.js';

const environment = {
  SOURCE_CHAIN_ID: 11_155_111,
  DESTINATION_CHAIN_ID: 84_532,
} as const;

describe('funded testnet transport readiness', () => {
  it('accepts two matching networks with token code, gas, and custody funding', () => {
    expect(() => assertFundedTestnetTransportReadiness(environment, ready())).not.toThrow();
  });

  it('rejects a wrong network or missing collateral token deployment', () => {
    expect(() =>
      assertFundedTestnetTransportReadiness(environment, {
        ...ready(),
        destinationChainId: 84_533,
      }),
    ).toThrow('RPC chain IDs');
    expect(() =>
      assertFundedTestnetTransportReadiness(environment, {
        ...ready(),
        sourceTokenCodePresent: false,
      }),
    ).toThrow('token deployment is missing');
  });

  it('rejects missing relayer gas or either pre-funded recovery/delivery balance', () => {
    expect(() =>
      assertFundedTestnetTransportReadiness(environment, {
        ...ready(),
        destinationNativeBalanceWei: 0n,
      }),
    ).toThrow('native gas on both chains');
    expect(() =>
      assertFundedTestnetTransportReadiness(environment, {
        ...ready(),
        sourceCollateralBalanceUnits: 0n,
      }),
    ).toThrow('pre-funded collateral on both chains');
    expect(() =>
      assertFundedTestnetTransportReadiness(environment, {
        ...ready(),
        destinationCollateralBalanceUnits: 0n,
      }),
    ).toThrow('pre-funded collateral on both chains');
  });
});

function ready(): FundedTestnetTransportReadiness {
  return {
    sourceChainId: environment.SOURCE_CHAIN_ID,
    destinationChainId: environment.DESTINATION_CHAIN_ID,
    sourceTokenCodePresent: true,
    destinationTokenCodePresent: true,
    sourceNativeBalanceWei: 1n,
    destinationNativeBalanceWei: 1n,
    sourceCollateralBalanceUnits: 1n,
    destinationCollateralBalanceUnits: 1n,
  };
}

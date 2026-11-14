import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { isWithinAaveAccrualBounds, LiveProtocolService } from './live-protocol.service.js';

describe('LiveProtocolService registry binding', () => {
  it('builds live Aave-to-Morpho identities only from explicit configuration', () => {
    const configuration = liveConfiguration();
    const service = new LiveProtocolService(
      new ConfigService({
        DEBTSHIFT_MODE: 'mainnet-readonly',
        MARKET_DATA_PROVIDER: 'LIVE_READ_ONLY',
        SOURCE_CHAIN_ID: 8453,
        SOURCE_RPC_URL: 'https://base.example',
        SOURCE_FINALITY_CONFIRMATIONS: 1,
        SOURCE_LENDING_ADDRESS: '0x4000000000000000000000000000000000000006',
        DESTINATION_CHAIN_ID: 42161,
        DESTINATION_RPC_URL: 'https://arbitrum.example',
        DESTINATION_LENDING_ADDRESS: '0x4000000000000000000000000000000000000005',
        LIVE_MARKET_CONFIG_JSON: JSON.stringify(configuration),
      }),
    );

    expect(service.provider).toBe('LIVE_READ_ONLY');
    expect(service.route).toMatchObject({
      sourceMarket: {
        chainId: 8453,
        protocol: 'AAVE_V3',
        deployment: configuration.source.pool,
      },
      targetMarket: {
        chainId: 42161,
        protocol: 'MORPHO_BLUE',
        deployment: configuration.destination.morpho,
        marketId: configuration.destination.marketId,
      },
      execution: { kind: 'READ_ONLY' },
    });
  });

  it('binds explicit DebtShift deployments for the executable mainnet route', () => {
    const configuration = liveConfiguration();
    const service = new LiveProtocolService(
      new ConfigService({
        DEBTSHIFT_MODE: 'mainnet',
        MARKET_DATA_PROVIDER: 'LIVE_READ_ONLY',
        SOURCE_CHAIN_ID: 8453,
        SOURCE_RPC_URL: 'https://base.example',
        SOURCE_FINALITY_CONFIRMATIONS: 1,
        SOURCE_LENDING_ADDRESS: '0x4000000000000000000000000000000000000006',
        DESTINATION_CHAIN_ID: 42161,
        DESTINATION_RPC_URL: 'https://arbitrum.example',
        LIVE_MARKET_CONFIG_JSON: JSON.stringify(configuration),
        DESTINATION_LENDING_ADDRESS: '0x4000000000000000000000000000000000000005',
        DESTINATION_ESCROW_ADDRESS: '0x4000000000000000000000000000000000000001',
        SOURCE_ESCROW_ADDRESS: '0x4000000000000000000000000000000000000004',
        SOURCE_VAULT_ADDRESS: '0x4000000000000000000000000000000000000002',
        EXECUTOR_ADDRESS: '0x4000000000000000000000000000000000000003',
      }),
    );

    expect(service.route.execution).toEqual({
      kind: 'EXECUTABLE',
      mode: 'mainnet',
      destinationEscrow: '0x4000000000000000000000000000000000000001',
      sourceEscrow: '0x4000000000000000000000000000000000000004',
      sourceVault: '0x4000000000000000000000000000000000000002',
      executor: '0x4000000000000000000000000000000000000003',
    });
  });
});

describe('Aave source accrual bounds', () => {
  const base = {
    snapshotCollateralUnits: 10_000n,
    snapshotDebtUnits: 1_000_000n,
    debtBufferBps: 10,
  } as const;

  it('accepts passive collateral and variable-debt accrual within the signed debt cap', () => {
    expect(
      isWithinAaveAccrualBounds({
        ...base,
        currentCollateralUnits: 10_001n,
        currentDebtUnits: 1_000_001n,
      }),
    ).toBe(true);
  });

  it.each([
    { currentCollateralUnits: 9_999n, currentDebtUnits: 1_000_001n },
    { currentCollateralUnits: 10_001n, currentDebtUnits: 999_999n },
    { currentCollateralUnits: 10_001n, currentDebtUnits: 1_001_001n },
  ])('rejects a material source-position change: %o', (current) => {
    expect(isWithinAaveAccrualBounds({ ...base, ...current })).toBe(false);
  });
});

function liveConfiguration() {
  const feed = (address: string) => ({ address, maximumAgeSeconds: 3600 });
  return {
    version: 1,
    source: {
      pool: '0x1000000000000000000000000000000000000001',
      dataProvider: '0x1000000000000000000000000000000000000002',
      collateralAsset: {
        address: '0x1000000000000000000000000000000000000003',
        decimals: 18,
        symbol: 'WETH',
        providerAssetId: 'nep141:base-weth.omft.near',
      },
      debtAsset: {
        address: '0x1000000000000000000000000000000000000004',
        decimals: 6,
        symbol: 'USDC',
        providerAssetId: 'nep141:base-usdc.omft.near',
      },
    },
    destination: {
      morpho: '0x2000000000000000000000000000000000000001',
      marketId: `0x${'22'.repeat(32)}`,
      morphoOracle: '0x2000000000000000000000000000000000000002',
      collateralAsset: {
        address: '0x2000000000000000000000000000000000000003',
        decimals: 18,
        symbol: 'WETH',
        providerAssetId: 'nep141:arb-weth.omft.near',
      },
      debtAsset: {
        address: '0x2000000000000000000000000000000000000004',
        decimals: 6,
        symbol: 'USDC',
        providerAssetId: 'nep141:arb-usdc.omft.near',
      },
      morphoOracleFeeds: [feed('0x2000000000000000000000000000000000000005')],
    },
    prices: {
      sourceCollateralUsd: feed('0x3000000000000000000000000000000000000001'),
      sourceDebtUsd: feed('0x3000000000000000000000000000000000000002'),
      sourceNativeUsd: feed('0x3000000000000000000000000000000000000003'),
      destinationCollateralUsd: feed('0x3000000000000000000000000000000000000004'),
      destinationDebtUsd: feed('0x3000000000000000000000000000000000000005'),
      destinationNativeUsd: feed('0x3000000000000000000000000000000000000006'),
    },
    policy: {
      horizonDays: 180,
      maxAllInCostUsdMicro: '250000000',
      minAprReductionBps: 150,
      maxPositionSnapshotAgeSeconds: 30,
      maxMarketSnapshotAgeSeconds: 30,
      maxOracleAgeSeconds: 3600,
      minimumLiquidityBufferBps: 1000,
      stressCollateralDropBps: 1000,
      stressTargetAprIncreaseBps: 200,
      maximumLtvBps: 7000,
      stressMaximumLtvBps: 6500,
    },
    analyticsCosts: {
      sourceGasUnitsUpperBound: 800000,
      destinationGasUnitsUpperBound: 800000,
      estimatedSettlementSeconds: 120,
      settlementTimeP95Seconds: 600,
      tailLossEstimateUsdMicro: '5000000',
      settlementRiskCostUsdMicro: '3000000',
      dependencyRiskCostUsdMicro: '2000000',
    },
  };
}

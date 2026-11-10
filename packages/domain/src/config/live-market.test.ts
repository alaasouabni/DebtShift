import { describe, expect, it } from 'vitest';

import { parseLiveMarketConfiguration } from './live-market.js';

describe('live market configuration', () => {
  it('parses a fully explicit registry without deployment defaults', () => {
    const configuration = parseLiveMarketConfiguration(JSON.stringify(validConfiguration()));

    expect(configuration.source.pool).toBe('0x1000000000000000000000000000000000000001');
    expect(configuration.destination.marketId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(configuration.destination.debtAsset.providerAssetId).toBe('nep141:arb-usdc.omft.near');
  });

  it('rejects malformed JSON and incomplete registries', () => {
    expect(() => parseLiveMarketConfiguration('{')).toThrow('valid JSON');
    expect(() => parseLiveMarketConfiguration('{}')).toThrow();
  });
});

function validConfiguration() {
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

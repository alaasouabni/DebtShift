import { positionSnapshotSchema, type PositionSnapshot } from '@debtshift/domain';
import { compareRoutes } from '@debtshift/optimizer';
import { describe, expect, it } from 'vitest';

import type { LocalRouteDefinition } from './local-protocol.service.js';
import {
  buildLocalRouteCandidates,
  LOCAL_EXECUTABLE_ROUTE_ID,
  LOCAL_REJECTED_ROUTE_ID,
  localRoutePolicy,
} from './local-market-tools.service.js';

const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa' as const;

describe('local market intelligence fixtures', () => {
  it('returns an executable route and a lower-liquidity rejection with block provenance', () => {
    const source = sourcePosition();
    const candidates = buildLocalRouteCandidates(source, localRoute(), {
      blockNumber: 200n,
      blockHash: `0x${'23'.repeat(32)}`,
      observedAt: '2026-11-09T12:00:00.000Z',
      availableBorrowUnits: 100_000_000_000n,
      collateralPriceInDebtWad: 2_000n * 10n ** 18n,
      maximumLtvBps: 7_500,
    });
    const comparison = compareRoutes({
      sourcePosition: source,
      candidates,
      policy: localRoutePolicy('2026-11-09T12:00:05.000Z'),
    });

    expect(comparison.selectedCandidateId).toBe(LOCAL_EXECUTABLE_ROUTE_ID);
    expect(comparison.evaluations).toHaveLength(2);
    const selected = comparison.evaluations.find(
      (evaluation) => evaluation.candidateId === LOCAL_EXECUTABLE_ROUTE_ID,
    );
    expect(selected?.eligible).toBe(true);
    expect(selected?.economics.allInCostUsdMicro).toBe('85000000');
    expect(selected?.economics.netBenefitUsdMicro).toBe('38287671');
    expect(selected?.provenance.marketBlockNumber).toBe('200');

    const rejected = comparison.evaluations.find(
      (evaluation) => evaluation.candidateId === LOCAL_REJECTED_ROUTE_ID,
    );
    expect(rejected?.eligible).toBe(false);
    expect(rejected?.rejections.map(({ code }) => code)).toContain('INSUFFICIENT_BORROW_LIQUIDITY');
  });
});

function sourcePosition(): PositionSnapshot {
  return positionSnapshotSchema.parse({
    snapshotId: `0x${'11'.repeat(32)}`,
    position: {
      market: {
        chainId: 31_337,
        protocol: 'LOCAL_AAVE_MOCK',
        deployment: '0x1000000000000000000000000000000000000001',
        marketId: `0x${'12'.repeat(32)}`,
      },
      borrower: BORROWER,
      collateralAsset: {
        chainId: 31_337,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 18,
        symbol: 'sWETH',
      },
      debtAsset: {
        chainId: 31_337,
        address: '0x3000000000000000000000000000000000000003',
        decimals: 6,
        symbol: 'sUSDC',
      },
    },
    collateralUnits: '10000000000000000000',
    debtUnits: '10000000000',
    health: { kind: 'AAVE_HEALTH_FACTOR', healthFactorWad: '1500000000000000000' },
    borrowAprBps: 700,
    block: {
      number: '100',
      hash: `0x${'13'.repeat(32)}`,
      observedAt: '2026-11-09T12:00:00.000Z',
    },
  });
}

function localRoute(): LocalRouteDefinition {
  return {
    sourceMarket: {
      chainId: 31_337,
      protocol: 'LOCAL_AAVE_MOCK',
      deployment: '0x1000000000000000000000000000000000000001',
      marketId: `0x${'12'.repeat(32)}`,
    },
    targetMarket: {
      chainId: 31_338,
      protocol: 'LOCAL_MORPHO_MOCK',
      deployment: '0x4000000000000000000000000000000000000004',
      marketId: `0x${'22'.repeat(32)}`,
    },
    sourceDebtAsset: {
      chainId: 31_337,
      address: '0x3000000000000000000000000000000000000003',
      decimals: 6,
      symbol: 'sUSDC',
    },
    sourceCollateralAsset: {
      chainId: 31_337,
      address: '0x2000000000000000000000000000000000000002',
      decimals: 18,
      symbol: 'sWETH',
    },
    destinationDebtAsset: {
      chainId: 31_338,
      address: '0x5000000000000000000000000000000000000005',
      decimals: 6,
      symbol: 'dUSDC',
    },
    destinationCollateralAsset: {
      chainId: 31_338,
      address: '0x6000000000000000000000000000000000000006',
      decimals: 18,
      symbol: 'dWETH',
    },
    destinationEscrow: '0x7000000000000000000000000000000000000007',
    sourceVault: '0x8000000000000000000000000000000000000008',
    executor: '0x9000000000000000000000000000000000000009',
  };
}

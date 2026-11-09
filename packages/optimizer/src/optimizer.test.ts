import { describe, expect, it } from 'vitest';

import { compareRoutes } from './optimizer.js';
import { projectBorrowRate } from './rate.js';

const SOURCE_SNAPSHOT_ID = `0x${'11'.repeat(32)}` as const;
const MARKET_SNAPSHOT_ID = `0x${'22'.repeat(32)}` as const;
const BLOCK_HASH = `0x${'33'.repeat(32)}` as const;
const MARKET_ID = `0x${'44'.repeat(32)}` as const;
const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa' as const;
const EVALUATED_AT = '2026-11-09T12:00:10.000Z';

describe('deterministic route optimizer', () => {
  it('reproduces the specification worked example with integer micro-USD math', () => {
    const comparison = compareRoutes(exampleInput(90));
    const route = comparison.evaluations[0];

    expect(comparison.selectedCandidateId).toBe('morpho-example');
    expect(route?.eligible).toBe(true);
    expect(route?.economics).toMatchObject({
      sourceAprBps: 900,
      targetAprAfterBps: 500,
      aprReductionBps: 400,
      annualGrossSavingsUsdMicro: '400000000',
      allInCostUsdMicro: '85000000',
      grossSavingsUsdMicro: '98630136',
      netBenefitUsdMicro: '13630136',
      breakEvenSeconds: '6701400',
    });
    expect(route?.safety).toMatchObject({
      kind: 'MAX_LTV_BPS',
      postLtvBps: 5000,
      stressLtvBps: 5556,
    });

    const at180Days = compareRoutes(exampleInput(180)).evaluations[0];
    expect(at180Days?.economics.grossSavingsUsdMicro).toBe('197260273');
    expect(at180Days?.economics.netBenefitUsdMicro).toBe('112260273');
  });

  it('projects utilization-sensitive target rate impact exactly', () => {
    expect(
      projectBorrowRate(
        {
          kind: 'LINEAR_KINK',
          availableLiquidityUnits: '80000000' as never,
          totalBorrowUnits: '20000000' as never,
          optimalUtilizationBps: 8000,
          baseRateBps: 100,
          slope1Bps: 400,
          slope2Bps: 4000,
          provenance: 'pinned-aave-rate-fixture',
        },
        10_000_000n,
      ),
    ).toEqual({
      currentBorrowAprBps: 200,
      projectedBorrowAprBps: 250,
      rateImpactBps: 50,
      utilizationBeforeBps: 2000,
      utilizationAfterBps: 3000,
      provenance: 'pinned-aave-rate-fixture',
    });
  });

  it('evaluates health-factor and stressed health-factor policies with exact WAD values', () => {
    const input = exampleInput(180);
    const route = compareRoutes({
      ...input,
      policy: {
        ...input.policy,
        safetyPolicy: {
          kind: 'MIN_HEALTH_FACTOR_WAD',
          minimumWad: '1300000000000000000',
          stressMinimumWad: '1340000000000000000',
        },
      },
    }).evaluations[0];

    expect(route?.eligible).toBe(true);
    expect(route?.safety).toEqual({
      kind: 'MIN_HEALTH_FACTOR_WAD',
      postHealthFactorWad: '1500000000000000000',
      stressHealthFactorWad: '1350000000000000000',
      minimumWad: '1300000000000000000',
      stressMinimumWad: '1340000000000000000',
      riskLimitBps: 7500,
    });
  });

  it('returns explicit rejection reasons for stale, costly, unsupported, and unsafe routes', () => {
    const input = exampleInput(90);
    const candidate = input.candidates[0];
    if (candidate === undefined) throw new Error('Missing candidate fixture.');
    candidate.assetRouteSupported = false;
    candidate.adapterVersionApproved = false;
    candidate.transportMinimumMet = false;
    candidate.targetDebtValueUsdMicro = '19000000000';
    candidate.costs.transportFeeUsdMicro = '200000000';
    candidate.market.block.observedAt = '2026-11-09T11:00:00.000Z';
    candidate.market.oracle.updatedAt = '2026-11-09T11:00:00.000Z';
    candidate.rateProjection.projectedBorrowAprBps = 850;

    const route = compareRoutes(input).evaluations[0];
    expect(route?.eligible).toBe(false);
    expect(route?.rejections.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'ADAPTER_VERSION_UNAPPROVED',
        'APR_REDUCTION_BELOW_MINIMUM',
        'COST_ABOVE_MAXIMUM',
        'MARKET_SNAPSHOT_STALE',
        'NEGATIVE_NET_BENEFIT',
        'ORACLE_STALE',
        'ROUTE_UNSUPPORTED',
        'TRANSPORT_MINIMUM_NOT_MET',
        'UNSAFE_POST_STATE',
        'UNSAFE_STRESS_STATE',
      ]),
    );
  });

  it('ranks eligible routes deterministically and breaks exact ties by candidate ID', () => {
    const input = exampleInput(180);
    const original = input.candidates[0];
    if (original === undefined) throw new Error('Missing candidate fixture.');
    input.candidates = [
      { ...structuredClone(original), candidateId: 'route-b' },
      { ...structuredClone(original), candidateId: 'route-a' },
    ];

    const first = compareRoutes(input);
    const second = compareRoutes(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.evaluations.map((route) => [route.candidateId, route.rank])).toEqual([
      ['route-a', 1],
      ['route-b', 2],
    ]);
  });
});

function exampleInput(horizonDays: number) {
  return {
    sourcePosition: {
      snapshotId: SOURCE_SNAPSHOT_ID,
      position: {
        market: {
          chainId: 8453,
          protocol: 'AAVE_V3' as const,
          deployment: '0x1000000000000000000000000000000000000001',
          marketId: `0x${'55'.repeat(32)}`,
        },
        borrower: BORROWER,
        collateralAsset: {
          chainId: 8453,
          address: '0x2000000000000000000000000000000000000002',
          decimals: 18,
          symbol: 'WETH',
        },
        debtAsset: {
          chainId: 8453,
          address: '0x3000000000000000000000000000000000000003',
          decimals: 6,
          symbol: 'USDC',
        },
      },
      collateralUnits: '10000000000000000000',
      debtUnits: '10000000000',
      health: { kind: 'AAVE_HEALTH_FACTOR' as const, healthFactorWad: '1600000000000000000' },
      borrowAprBps: 900,
      block: { number: '100', hash: BLOCK_HASH, observedAt: '2026-11-09T12:00:00.000Z' },
    },
    candidates: [
      {
        candidateId: 'morpho-example',
        market: {
          snapshotId: MARKET_SNAPSHOT_ID,
          market: {
            chainId: 42161,
            protocol: 'MORPHO_BLUE' as const,
            deployment: '0x4000000000000000000000000000000000000004',
            marketId: MARKET_ID,
          },
          collateralAsset: {
            chainId: 42161,
            address: '0x5000000000000000000000000000000000000005',
            decimals: 18,
            symbol: 'WETH',
          },
          debtAsset: {
            chainId: 42161,
            address: '0x6000000000000000000000000000000000000006',
            decimals: 6,
            symbol: 'USDC',
          },
          borrowAprBps: 500,
          availableBorrowUnits: '100000000000',
          lltvBps: 7500,
          oracle: {
            oracle: 'morpho-fixture-oracle',
            priceMantissa: '2000000000000000000000',
            priceDecimals: 18,
            updatedAt: '2026-11-09T12:00:00.000Z',
            block: {
              number: '200',
              hash: BLOCK_HASH,
              observedAt: '2026-11-09T12:00:00.000Z',
            },
          },
          block: { number: '200', hash: BLOCK_HASH, observedAt: '2026-11-09T12:00:00.000Z' },
        },
        requestedBorrowUnits: '10000000000',
        principalDebtValueUsdMicro: '10000000000',
        targetDebtValueUsdMicro: '10000000000',
        deliveredCollateralValueUsdMicro: '20000000000',
        costs: {
          sourceGasUsdMicro: '0',
          destinationGasUsdMicro: '0',
          transportFeeUsdMicro: '85000000',
          slippageUsdMicro: '0',
          solverFeeUsdMicro: '0',
          protocolFeeUsdMicro: '0',
          collateralSwapCostUsdMicro: '0',
        },
        carryingCostAprBps: 0,
        tailLossEstimateUsdMicro: '0',
        settlementRiskCostUsdMicro: '0',
        dependencyRiskCostUsdMicro: '0',
        estimatedSettlementSeconds: 120,
        settlementTimeP95Seconds: 300,
        rateProjection: {
          kind: 'DIRECT_PROJECTION' as const,
          currentBorrowAprBps: 500,
          projectedBorrowAprBps: 500,
          provenance: 'specification-worked-example',
        },
        assetRouteSupported: true,
        adapterVersionApproved: true,
        transportMinimumMet: true,
      },
    ],
    policy: {
      evaluatedAt: EVALUATED_AT,
      horizonDays,
      maxAllInCostUsdMicro: '100000000',
      minAprReductionBps: 150,
      maxPositionSnapshotAgeSeconds: 15,
      maxMarketSnapshotAgeSeconds: 15,
      maxOracleAgeSeconds: 15,
      minimumLiquidityBufferBps: 1000,
      stressCollateralDropBps: 1000,
      stressTargetAprIncreaseBps: 200,
      requirePositiveNetBenefit: true,
      safetyPolicy: {
        kind: 'MAX_LTV_BPS' as const,
        maximumLtvBps: 7000,
        stressMaximumLtvBps: 6500,
      },
    },
  };
}

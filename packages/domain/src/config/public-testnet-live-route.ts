import { z } from 'zod';
import type { Hex } from 'viem';

import { bytes32Schema, canonicalTextSchema } from '../primitives.js';
import {
  liveAnalyticsCostConfigurationSchema,
  liveMarketConfigurationSchema,
  liveRoutePolicyConfigurationSchema,
  type LiveMarketConfiguration,
} from './live-market.js';
import type { PublicTestnetRouteDependencies } from './public-testnet-route.js';
import type { TestnetMorphoDeploymentManifest } from './testnet-morpho-deployment.js';

export const publicTestnetLiveRoutePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    routeId: canonicalTextSchema,
    environment: z.literal('testnet'),
    status: z.literal('reviewed-executable-route-policy'),
    workflowWriteSwitchEnabled: z.literal(false),
    policy: liveRoutePolicyConfigurationSchema,
    analyticsCosts: liveAnalyticsCostConfigurationSchema,
  })
  .strict();

export type PublicTestnetLiveRoutePolicy = z.infer<typeof publicTestnetLiveRoutePolicySchema>;

export function parsePublicTestnetLiveRoutePolicy(
  input: string,
): Readonly<PublicTestnetLiveRoutePolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Public testnet live-route policy must contain valid JSON.');
  }
  return Object.freeze(publicTestnetLiveRoutePolicySchema.parse(parsed));
}

export interface DerivePublicTestnetLiveRouteInput {
  readonly dependencies: Readonly<PublicTestnetRouteDependencies>;
  readonly routeDependenciesHash: Hex;
  readonly morphoManifest: Readonly<TestnetMorphoDeploymentManifest>;
  readonly generationPolicy: Readonly<PublicTestnetLiveRoutePolicy>;
}

export function derivePublicTestnetLiveRoute(
  input: DerivePublicTestnetLiveRouteInput,
): Readonly<LiveMarketConfiguration> {
  const { dependencies, routeDependenciesHash, morphoManifest, generationPolicy } = input;
  const normalizedHash = bytes32Schema.parse(routeDependenciesHash);

  assertEqual('generation policy route ID', generationPolicy.routeId, dependencies.routeId);
  assertEqual('Morpho manifest route ID', morphoManifest.routeId, dependencies.routeId);
  assertEqual(
    'Morpho manifest dependency hash',
    morphoManifest.routeDependenciesHash,
    normalizedHash,
  );
  assertEqual('Morpho manifest chain ID', morphoManifest.chainId, dependencies.destination.chainId);

  const addressBindings: readonly (readonly [string, string, string])[] = [
    [
      'Morpho collateral token',
      morphoManifest.tokens.collateral.address,
      dependencies.destination.collateralAsset.address,
    ],
    [
      'Morpho loan token',
      morphoManifest.tokens.loan.address,
      dependencies.destination.loanAsset.address,
    ],
    [
      'Morpho collateral feed',
      morphoManifest.feeds.collateral.address,
      dependencies.destination.collateralFeed.address,
    ],
    [
      'Morpho loan feed',
      morphoManifest.feeds.loan.address,
      dependencies.destination.loanFeed.address,
    ],
    [
      'Morpho market collateral token',
      morphoManifest.market.collateralToken,
      dependencies.destination.collateralAsset.address,
    ],
    [
      'Morpho market loan token',
      morphoManifest.market.loanToken,
      dependencies.destination.loanAsset.address,
    ],
    ['Morpho market oracle', morphoManifest.market.oracle, morphoManifest.contracts.oracle.address],
    ['Morpho market IRM', morphoManifest.market.irm, morphoManifest.contracts.irm.address],
  ];
  for (const [label, actual, expected] of addressBindings) {
    assertAddress(label, actual, expected);
  }

  assertEqual(
    'Morpho collateral token decimals',
    morphoManifest.tokens.collateral.decimals,
    dependencies.destination.collateralAsset.decimals,
  );
  assertEqual(
    'Morpho loan token decimals',
    morphoManifest.tokens.loan.decimals,
    dependencies.destination.loanAsset.decimals,
  );
  assertEqual(
    'Morpho collateral feed decimals',
    morphoManifest.feeds.collateral.decimals,
    dependencies.destination.collateralFeed.decimals,
  );
  assertEqual(
    'Morpho loan feed decimals',
    morphoManifest.feeds.loan.decimals,
    dependencies.destination.loanFeed.decimals,
  );
  assertEqual('Morpho market LLTV', morphoManifest.market.lltv, dependencies.destination.lltv);
  assertEqual(
    'Morpho collateral feed maximum age',
    morphoManifest.feeds.collateralMaxPriceAgeSeconds,
    dependencies.destination.collateralFeed.maximumAgeSeconds.toString(),
  );
  assertEqual(
    'Morpho loan feed maximum age',
    morphoManifest.feeds.loanMaxPriceAgeSeconds,
    dependencies.destination.loanFeed.maximumAgeSeconds.toString(),
  );
  if (
    morphoManifest.feeds.sequencerUptime !== null ||
    dependencies.destination.sequencerUptimeFeed !== null ||
    morphoManifest.feeds.sequencerGracePeriodSeconds !==
      dependencies.destination.sequencerGracePeriodSeconds.toString()
  ) {
    throw new Error('Morpho sequencer policy does not match the reviewed route dependencies.');
  }
  if (
    BigInt(morphoManifest.market.seedLiquidityAssets) <
    BigInt(dependencies.destination.minimumSeedLiquidityUnits)
  ) {
    throw new Error('Morpho seed liquidity is below the reviewed route minimum.');
  }
  const reviewedLltvBps = BigInt(dependencies.destination.lltv) / 100_000_000_000_000n;
  if (BigInt(generationPolicy.policy.maximumLtvBps) > reviewedLltvBps) {
    throw new Error('Live-route maximum LTV exceeds the manifested Morpho market LLTV.');
  }

  const feed = (address: `0x${string}`, maximumAgeSeconds: number) => ({
    address,
    maximumAgeSeconds,
  });
  const sourceCollateralFeed = feed(
    dependencies.source.collateralFeed.address,
    dependencies.source.collateralFeed.maximumAgeSeconds,
  );
  const sourceDebtFeed = feed(
    dependencies.source.debtFeed.address,
    dependencies.source.debtFeed.maximumAgeSeconds,
  );
  const destinationCollateralFeed = feed(
    dependencies.destination.collateralFeed.address,
    dependencies.destination.collateralFeed.maximumAgeSeconds,
  );
  const destinationDebtFeed = feed(
    dependencies.destination.loanFeed.address,
    dependencies.destination.loanFeed.maximumAgeSeconds,
  );

  return Object.freeze(
    liveMarketConfigurationSchema.parse({
      version: 1,
      source: {
        pool: dependencies.source.pool,
        dataProvider: dependencies.source.dataProvider,
        collateralAsset: {
          address: dependencies.source.collateralAsset.address,
          decimals: dependencies.source.collateralAsset.decimals,
          symbol: dependencies.source.collateralAsset.symbol,
        },
        debtAsset: {
          address: dependencies.source.debtAsset.address,
          decimals: dependencies.source.debtAsset.decimals,
          symbol: dependencies.source.debtAsset.symbol,
        },
      },
      destination: {
        morpho: morphoManifest.contracts.morpho.address,
        marketId: morphoManifest.market.id,
        morphoOracle: morphoManifest.contracts.oracle.address,
        collateralAsset: {
          address: dependencies.destination.collateralAsset.address,
          decimals: dependencies.destination.collateralAsset.decimals,
          symbol: dependencies.destination.collateralAsset.symbol,
        },
        debtAsset: {
          address: dependencies.destination.loanAsset.address,
          decimals: dependencies.destination.loanAsset.decimals,
          symbol: dependencies.destination.loanAsset.symbol,
        },
        morphoOracleFeeds: [destinationCollateralFeed, destinationDebtFeed],
      },
      prices: {
        sourceCollateralUsd: sourceCollateralFeed,
        sourceDebtUsd: sourceDebtFeed,
        sourceNativeUsd: sourceCollateralFeed,
        destinationCollateralUsd: destinationCollateralFeed,
        destinationDebtUsd: destinationDebtFeed,
        destinationNativeUsd: destinationCollateralFeed,
      },
      policy: generationPolicy.policy,
      analyticsCosts: generationPolicy.analyticsCosts,
    }),
  );
}

function assertAddress(label: string, actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} does not match the reviewed route dependencies.`);
  }
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label} does not match the reviewed route dependencies.`);
  }
}

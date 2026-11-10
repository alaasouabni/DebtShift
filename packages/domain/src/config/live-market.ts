import { z } from 'zod';

import {
  baseUnitAmountSchema,
  basisPointsSchema,
  bytes32Schema,
  canonicalTextSchema,
  evmAddressSchema,
  tokenDecimalsSchema,
} from '../primitives.js';

export const liveTokenConfigurationSchema = z
  .object({
    address: evmAddressSchema,
    decimals: tokenDecimalsSchema,
    symbol: z.string().trim().min(1).max(32),
    providerAssetId: canonicalTextSchema,
  })
  .strict();

export const chainlinkFeedConfigurationSchema = z
  .object({
    address: evmAddressSchema,
    maximumAgeSeconds: z.number().int().min(30).max(86_400),
  })
  .strict();

export const liveRoutePolicyConfigurationSchema = z
  .object({
    horizonDays: z.number().int().min(1).max(3_650),
    maxAllInCostUsdMicro: baseUnitAmountSchema,
    minAprReductionBps: z.number().int().min(0).max(1_000_000),
    maxPositionSnapshotAgeSeconds: z.number().int().min(1).max(86_400),
    maxMarketSnapshotAgeSeconds: z.number().int().min(1).max(86_400),
    maxOracleAgeSeconds: z.number().int().min(1).max(86_400),
    minimumLiquidityBufferBps: basisPointsSchema,
    stressCollateralDropBps: z.number().int().min(0).max(9_500),
    stressTargetAprIncreaseBps: z.number().int().min(0).max(1_000_000),
    maximumLtvBps: basisPointsSchema,
    stressMaximumLtvBps: basisPointsSchema,
  })
  .strict()
  .refine(
    (policy) => policy.stressMaximumLtvBps <= policy.maximumLtvBps,
    'Stress maximum LTV must not exceed the normal maximum LTV.',
  );

export const liveAnalyticsCostConfigurationSchema = z
  .object({
    sourceGasUnitsUpperBound: z.number().int().positive().max(10_000_000),
    destinationGasUnitsUpperBound: z.number().int().positive().max(10_000_000),
    estimatedSettlementSeconds: z.number().int().positive().max(86_400),
    settlementTimeP95Seconds: z.number().int().positive().max(604_800),
    tailLossEstimateUsdMicro: baseUnitAmountSchema,
    settlementRiskCostUsdMicro: baseUnitAmountSchema,
    dependencyRiskCostUsdMicro: baseUnitAmountSchema,
  })
  .strict();

export const liveMarketConfigurationSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        pool: evmAddressSchema,
        dataProvider: evmAddressSchema,
        collateralAsset: liveTokenConfigurationSchema,
        debtAsset: liveTokenConfigurationSchema,
        sequencerUptimeFeed: z
          .object({
            address: evmAddressSchema,
            recoveryGraceSeconds: z.number().int().min(3_600).max(86_400),
          })
          .strict()
          .optional(),
      })
      .strict(),
    destination: z
      .object({
        morpho: evmAddressSchema,
        marketId: bytes32Schema,
        morphoOracle: evmAddressSchema,
        collateralAsset: liveTokenConfigurationSchema,
        debtAsset: liveTokenConfigurationSchema,
        morphoOracleFeeds: z.array(chainlinkFeedConfigurationSchema).min(1).max(8),
        sequencerUptimeFeed: z
          .object({
            address: evmAddressSchema,
            recoveryGraceSeconds: z.number().int().min(3_600).max(86_400),
          })
          .strict()
          .optional(),
      })
      .strict(),
    prices: z
      .object({
        sourceCollateralUsd: chainlinkFeedConfigurationSchema,
        sourceDebtUsd: chainlinkFeedConfigurationSchema,
        sourceNativeUsd: chainlinkFeedConfigurationSchema,
        destinationCollateralUsd: chainlinkFeedConfigurationSchema,
        destinationDebtUsd: chainlinkFeedConfigurationSchema,
        destinationNativeUsd: chainlinkFeedConfigurationSchema,
      })
      .strict(),
    policy: liveRoutePolicyConfigurationSchema,
    analyticsCosts: liveAnalyticsCostConfigurationSchema,
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.source.collateralAsset.address === configuration.source.debtAsset.address) {
      context.addIssue({
        code: 'custom',
        message: 'Live source collateral and debt assets must differ.',
        path: ['source'],
      });
    }
    if (
      configuration.destination.collateralAsset.address ===
      configuration.destination.debtAsset.address
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Live destination collateral and debt assets must differ.',
        path: ['destination'],
      });
    }
  });

export type LiveMarketConfiguration = z.infer<typeof liveMarketConfigurationSchema>;

export function parseLiveMarketConfiguration(input: string): Readonly<LiveMarketConfiguration> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('LIVE_MARKET_CONFIG_JSON must contain valid JSON.');
  }
  return Object.freeze(liveMarketConfigurationSchema.parse(parsed));
}

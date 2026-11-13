import { z } from 'zod';

import { canonicalTextSchema, evmAddressSchema } from '../primitives.js';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const sourceCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const unsignedIntegerTextSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const httpsUrlSchema = z
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'Public references must use HTTPS.');

const tokenSchema = z
  .object({
    address: evmAddressSchema,
    decimals: z.number().int().min(0).max(36),
    symbol: z.string().trim().min(1).max(32),
  })
  .strict();

const aaveAssetSchema = tokenSchema
  .extend({
    aToken: evmAddressSchema,
    variableDebtToken: evmAddressSchema,
    oracle: evmAddressSchema,
  })
  .strict();

const chainlinkFeedSchema = z
  .object({
    address: evmAddressSchema,
    registryPath: canonicalTextSchema,
    expectedDescription: canonicalTextSchema,
    decimals: z.number().int().min(0).max(36),
    heartbeatSeconds: z.number().int().positive().max(604_800),
    maximumAgeSeconds: z.number().int().positive().max(604_800),
  })
  .strict()
  .refine(
    (feed) => feed.maximumAgeSeconds >= feed.heartbeatSeconds,
    'Feed maximum age must cover its published heartbeat.',
  );

export const publicTestnetRouteDependenciesSchema = z
  .object({
    schemaVersion: z.literal(1),
    routeId: canonicalTextSchema,
    environment: z.literal('testnet'),
    status: z.literal('candidate-dependencies'),
    workflowWriteSwitchEnabled: z.literal(false),
    source: z
      .object({
        chainId: z.literal(11_155_111),
        network: z.literal('Ethereum Sepolia'),
        addressBook: z
          .object({
            manifestUrl: httpsUrlSchema,
            moduleName: z.literal('AaveV3Sepolia'),
            commit: sourceCommitSchema,
            aggregateSha256: sha256Schema,
            moduleSha256: sha256Schema,
            moduleBytes: z.number().int().positive(),
          })
          .strict(),
        references: z
          .object({
            chainlinkDirectoryUrl: httpsUrlSchema,
            chainlinkRegistryUrl: httpsUrlSchema,
          })
          .strict(),
        pool: evmAddressSchema,
        poolAddressesProvider: evmAddressSchema,
        dataProvider: evmAddressSchema,
        oracle: evmAddressSchema,
        faucet: evmAddressSchema,
        collateralAsset: aaveAssetSchema,
        debtAsset: aaveAssetSchema,
        collateralFeed: chainlinkFeedSchema,
        debtFeed: chainlinkFeedSchema,
      })
      .strict(),
    destination: z
      .object({
        chainId: z.literal(84_532),
        network: z.literal('Base Sepolia'),
        references: z
          .object({
            baseContractsUrl: httpsUrlSchema,
            circleUsdcUrl: httpsUrlSchema,
            chainlinkDirectoryUrl: httpsUrlSchema,
            chainlinkRegistryUrl: httpsUrlSchema,
            chainlinkSequencerFeedsUrl: httpsUrlSchema,
          })
          .strict(),
        collateralAsset: tokenSchema,
        loanAsset: tokenSchema,
        collateralFeed: chainlinkFeedSchema,
        loanFeed: chainlinkFeedSchema,
        sequencerUptimeFeed: z.null(),
        sequencerGracePeriodSeconds: z.literal(0),
        lltv: unsignedIntegerTextSchema.refine(
          (value) => BigInt(value) > 0n && BigInt(value) < 10n ** 18n,
          'Morpho LLTV must be between zero and one WAD.',
        ),
        minimumSeedLiquidityUnits: unsignedIntegerTextSchema.refine(
          (value) => BigInt(value) > 0n,
          'Morpho seed liquidity must be positive.',
        ),
      })
      .strict(),
    transport: z
      .object({
        provider: z.literal('NEAR_INTENTS_1CLICK'),
        testnetBoundary: z.literal('SIMULATED_UNAVAILABLE_PROVIDER_BOUNDARY'),
        sourceAndDestinationTransfers: z.literal('REAL_PUBLIC_CHAIN_TRANSACTIONS'),
        collateralMapping: z
          .object({ sourceSymbol: z.literal('WETH'), destinationSymbol: z.literal('WETH') })
          .strict(),
        debtMapping: z
          .object({ sourceSymbol: z.literal('USDC'), destinationSymbol: z.literal('USDC') })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((route, context) => {
    if (route.source.collateralAsset.address === route.source.debtAsset.address) {
      context.addIssue({
        code: 'custom',
        message: 'Source collateral and debt assets must differ.',
        path: ['source'],
      });
    }
    if (route.destination.collateralAsset.address === route.destination.loanAsset.address) {
      context.addIssue({
        code: 'custom',
        message: 'Destination collateral and loan assets must differ.',
        path: ['destination'],
      });
    }
    if (route.destination.collateralFeed.address === route.destination.loanFeed.address) {
      context.addIssue({
        code: 'custom',
        message: 'Destination collateral and loan feeds must differ.',
        path: ['destination'],
      });
    }
    if (route.source.collateralFeed.address === route.source.debtFeed.address) {
      context.addIssue({
        code: 'custom',
        message: 'Source collateral and debt feeds must differ.',
        path: ['source'],
      });
    }
  });

export type PublicTestnetRouteDependencies = z.infer<typeof publicTestnetRouteDependenciesSchema>;

export function parsePublicTestnetRouteDependencies(
  input: string,
): Readonly<PublicTestnetRouteDependencies> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Public testnet route dependencies must contain valid JSON.');
  }
  return Object.freeze(publicTestnetRouteDependenciesSchema.parse(parsed));
}

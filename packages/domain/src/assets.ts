import { z } from 'zod';

import {
  bytes32Schema,
  canonicalTextSchema,
  chainIdSchema,
  evmAddressSchema,
  identifierTextSchema,
  tokenDecimalsSchema,
} from './primitives.js';

export const protocolSchema = z.enum([
  'AAVE_V3',
  'MORPHO_BLUE',
  'LOCAL_AAVE_MOCK',
  'LOCAL_MORPHO_MOCK',
]);

export const tokenReferenceSchema = z
  .object({
    chainId: chainIdSchema,
    address: evmAddressSchema,
    decimals: tokenDecimalsSchema,
    symbol: z.string().trim().min(1).max(32).optional(),
    providerAssetId: canonicalTextSchema.optional(),
  })
  .strict();

export const marketReferenceSchema = z
  .object({
    chainId: chainIdSchema,
    protocol: protocolSchema,
    deployment: evmAddressSchema,
    marketId: bytes32Schema,
  })
  .strict();

export const positionReferenceSchema = z
  .object({
    market: marketReferenceSchema,
    borrower: evmAddressSchema,
    collateralAsset: tokenReferenceSchema,
    debtAsset: tokenReferenceSchema,
  })
  .strict()
  .superRefine((position, context) => {
    const expectedChainId = position.market.chainId;
    if (
      position.collateralAsset.chainId !== expectedChainId ||
      position.debtAsset.chainId !== expectedChainId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Position assets must belong to the position market chain.',
      });
    }

    if (position.collateralAsset.address === position.debtAsset.address) {
      context.addIssue({
        code: 'custom',
        message: 'Collateral and debt assets must be distinct.',
      });
    }
  });

export const transportProviderSchema = z.enum(['DEBTSHIFT_SIMULATOR', 'NEAR_INTENTS_1CLICK']);
export const providerModeSchema = z.enum(['SIMULATED', 'DRY', 'COMMITTED']);
export const actorReferenceSchema = z
  .object({
    network: identifierTextSchema,
    account: canonicalTextSchema,
  })
  .strict();

export type Protocol = z.infer<typeof protocolSchema>;
export type TokenReference = z.infer<typeof tokenReferenceSchema>;
export type MarketReference = z.infer<typeof marketReferenceSchema>;
export type PositionReference = z.infer<typeof positionReferenceSchema>;
export type TransportProvider = z.infer<typeof transportProviderSchema>;

import { z } from 'zod';

import { marketReferenceSchema, positionReferenceSchema, tokenReferenceSchema } from './assets.js';
import {
  baseUnitAmountSchema,
  basisPointsSchema,
  bytes32Schema,
  isoTimestampSchema,
  nonNegativeBasisPointsSchema,
  positiveBaseUnitAmountSchema,
  uint64StringSchema,
} from './primitives.js';

export const blockReferenceSchema = z
  .object({
    number: uint64StringSchema,
    hash: bytes32Schema,
    observedAt: isoTimestampSchema,
  })
  .strict();

export const oracleSnapshotSchema = z
  .object({
    oracle: z.string().min(1),
    priceMantissa: positiveBaseUnitAmountSchema,
    priceDecimals: z.number().int().min(0).max(36),
    updatedAt: isoTimestampSchema,
    block: blockReferenceSchema,
  })
  .strict();

export const healthMetricSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('AAVE_HEALTH_FACTOR'),
      healthFactorWad: positiveBaseUnitAmountSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('MORPHO_LTV'),
      ltvBps: basisPointsSchema,
      lltvBps: basisPointsSchema,
    })
    .strict()
    .refine((metric) => metric.ltvBps <= metric.lltvBps, 'Morpho LTV cannot exceed LLTV.'),
]);

export const positionSnapshotSchema = z
  .object({
    snapshotId: bytes32Schema,
    position: positionReferenceSchema,
    collateralUnits: baseUnitAmountSchema,
    debtUnits: baseUnitAmountSchema,
    health: healthMetricSchema,
    borrowAprBps: nonNegativeBasisPointsSchema,
    block: blockReferenceSchema,
  })
  .strict();

export const marketSnapshotSchema = z
  .object({
    snapshotId: bytes32Schema,
    market: marketReferenceSchema,
    collateralAsset: tokenReferenceSchema,
    debtAsset: tokenReferenceSchema,
    borrowAprBps: nonNegativeBasisPointsSchema,
    availableBorrowUnits: baseUnitAmountSchema,
    collateralFactorBps: basisPointsSchema.optional(),
    lltvBps: basisPointsSchema.optional(),
    oracle: oracleSnapshotSchema,
    block: blockReferenceSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.market.chainId !== snapshot.collateralAsset.chainId ||
      snapshot.market.chainId !== snapshot.debtAsset.chainId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Market assets must belong to the market chain.',
      });
    }
  });

export type BlockReference = z.infer<typeof blockReferenceSchema>;
export type PositionSnapshot = z.infer<typeof positionSnapshotSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

import { z } from 'zod';

import {
  marketReferenceSchema,
  positionReferenceSchema,
  providerModeSchema,
  tokenReferenceSchema,
  transportProviderSchema,
} from './assets.js';
import {
  baseUnitAmountSchema,
  basisPointsSchema,
  bytes32Schema,
  canonicalTextSchema,
  evmAddressSchema,
  isoTimestampSchema,
  nonNegativeBasisPointsSchema,
  nonceSchema,
  positiveBaseUnitAmountSchema,
  signatureSchema,
  uint64StringSchema,
} from './primitives.js';

export const accountTypeSchema = z.enum(['EOA', 'EIP1271']);

export const safetyPolicySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('MIN_HEALTH_FACTOR_WAD'),
      minimumWad: positiveBaseUnitAmountSchema,
      stressMinimumWad: positiveBaseUnitAmountSchema,
    })
    .strict()
    .refine(
      (policy) => BigInt(policy.stressMinimumWad) >= BigInt(policy.minimumWad),
      'The stressed minimum health factor cannot be weaker than the normal minimum.',
    ),
  z
    .object({
      kind: z.literal('MAX_LTV_BPS'),
      maximumLtvBps: basisPointsSchema,
      stressMaximumLtvBps: basisPointsSchema,
    })
    .strict()
    .refine(
      (policy) => policy.stressMaximumLtvBps <= policy.maximumLtvBps,
      'The stressed maximum LTV cannot be weaker than the normal maximum.',
    ),
]);

export const refinanceIntentSchema = z
  .object({
    borrower: evmAddressSchema,
    accountType: accountTypeSchema,
    sourcePosition: positionReferenceSchema,
    allowedTargets: z.array(marketReferenceSchema).min(1).max(16),
    feeAsset: tokenReferenceSchema,
    maxSourceDebtUnits: positiveBaseUnitAmountSchema,
    minSourceCollateralUnits: positiveBaseUnitAmountSchema,
    maxTotalFeeUnits: baseUnitAmountSchema,
    maxSlippageBps: basisPointsSchema,
    minAprReductionBps: nonNegativeBasisPointsSchema,
    safetyPolicy: safetyPolicySchema,
    maxDurationSeconds: z.number().int().positive().max(86_400),
    expiration: uint64StringSchema,
    nonce: nonceSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.borrower !== intent.sourcePosition.borrower) {
      context.addIssue({
        code: 'custom',
        path: ['borrower'],
        message: 'Intent borrower must own the referenced source position.',
      });
    }

    if (intent.feeAsset.chainId !== intent.sourcePosition.market.chainId) {
      context.addIssue({
        code: 'custom',
        path: ['feeAsset'],
        message: 'The initial fee cap must be denominated on the source chain.',
      });
    }

    const targetKeys = intent.allowedTargets.map(
      (target) =>
        `${target.chainId}:${target.protocol}:${target.deployment.toLowerCase()}:${target.marketId}`,
    );
    if (new Set(targetKeys).size !== targetKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['allowedTargets'],
        message: 'Allowed targets must not contain duplicates.',
      });
    }
  });

export const signedRefinanceIntentSchema = z
  .object({
    intent: refinanceIntentSchema,
    intentHash: bytes32Schema,
    signature: signatureSchema,
  })
  .strict();

export const providerFeeSchema = z
  .object({
    kind: z.enum(['NETWORK', 'TRANSPORT', 'SLIPPAGE', 'SOLVER', 'PROTOCOL', 'OTHER']),
    asset: tokenReferenceSchema,
    amountUnits: baseUnitAmountSchema,
  })
  .strict();

export const providerQuoteSchema = z
  .object({
    quoteId: canonicalTextSchema,
    quoteHash: bytes32Schema,
    provider: transportProviderSchema,
    mode: providerModeSchema,
    inputAsset: tokenReferenceSchema,
    outputAsset: tokenReferenceSchema,
    amountInUnits: positiveBaseUnitAmountSchema,
    expectedAmountOutUnits: positiveBaseUnitAmountSchema,
    minAmountOutUnits: positiveBaseUnitAmountSchema,
    fees: z.array(providerFeeSchema).max(32),
    destinationReceiver: canonicalTextSchema,
    refundReceiver: canonicalTextSchema,
    depositAddress: canonicalTextSchema.optional(),
    expiresAt: isoTimestampSchema,
    correlationId: canonicalTextSchema.optional(),
    rawResponseHash: bytes32Schema,
  })
  .strict()
  .superRefine((quote, context) => {
    if (BigInt(quote.minAmountOutUnits) > BigInt(quote.expectedAmountOutUnits)) {
      context.addIssue({
        code: 'custom',
        path: ['minAmountOutUnits'],
        message: 'Minimum output cannot exceed expected output.',
      });
    }

    if (quote.mode === 'COMMITTED' && quote.depositAddress === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['depositAddress'],
        message: 'A committed provider quote requires a deposit address.',
      });
    }

    if (quote.provider === 'DEBTSHIFT_SIMULATOR' && quote.mode !== 'SIMULATED') {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Simulator quotes must be explicitly marked SIMULATED.',
      });
    }
  });

export const executionPlanSchema = z
  .object({
    intentHash: bytes32Schema,
    migrationId: bytes32Schema,
    borrower: evmAddressSchema,
    sourcePositionId: bytes32Schema,
    sourceMarket: marketReferenceSchema,
    targetMarket: marketReferenceSchema,
    sourceDebtAsset: tokenReferenceSchema,
    sourceCollateralAsset: tokenReferenceSchema,
    destinationDebtAsset: tokenReferenceSchema,
    destinationCollateralAsset: tokenReferenceSchema,
    sourceRepaymentMaxUnits: positiveBaseUnitAmountSchema,
    sourceCollateralMinUnits: positiveBaseUnitAmountSchema,
    targetDebtMaxUnits: positiveBaseUnitAmountSchema,
    minDestinationCollateralUnits: positiveBaseUnitAmountSchema,
    transportProvider: transportProviderSchema,
    transportQuoteHash: bytes32Schema,
    transportDepositAddress: canonicalTextSchema,
    destinationReceiver: evmAddressSchema,
    refundReceiver: evmAddressSchema,
    fundingProvider: evmAddressSchema,
    reservationHash: bytes32Schema,
    payoutAsset: tokenReferenceSchema,
    payoutReceiver: evmAddressSchema,
    principalMaxUnits: positiveBaseUnitAmountSchema,
    feeMaxUnits: baseUnitAmountSchema,
    routeHash: bytes32Schema,
    deadline: uint64StringSchema,
    nonce: nonceSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const sourceChainId = plan.sourceMarket.chainId;
    const destinationChainId = plan.targetMarket.chainId;
    const sourceAssets = [plan.sourceDebtAsset, plan.sourceCollateralAsset, plan.payoutAsset];
    const destinationAssets = [plan.destinationDebtAsset, plan.destinationCollateralAsset];

    if (sourceAssets.some((asset) => asset.chainId !== sourceChainId)) {
      context.addIssue({
        code: 'custom',
        message: 'Source debt, collateral, and payout assets must belong to the source chain.',
      });
    }

    if (destinationAssets.some((asset) => asset.chainId !== destinationChainId)) {
      context.addIssue({
        code: 'custom',
        message: 'Destination debt and collateral assets must belong to the target chain.',
      });
    }
  });

export const signedExecutionPlanSchema = z
  .object({
    plan: executionPlanSchema,
    planHash: bytes32Schema,
    signature: signatureSchema,
  })
  .strict();

export type SafetyPolicy = z.infer<typeof safetyPolicySchema>;
export type RefinanceIntent = z.infer<typeof refinanceIntentSchema>;
export type SignedRefinanceIntent = z.infer<typeof signedRefinanceIntentSchema>;
export type ProviderQuote = z.infer<typeof providerQuoteSchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type SignedExecutionPlan = z.infer<typeof signedExecutionPlanSchema>;

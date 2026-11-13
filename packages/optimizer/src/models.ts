import {
  baseUnitAmountSchema,
  marketSnapshotSchema,
  positionSnapshotSchema,
  positiveBaseUnitAmountSchema,
  safetyPolicySchema,
} from '@debtshift/domain';
import { z } from 'zod';

import {
  feasibilityRejectionCodes,
  refinancingFeasibilityResultSchema,
  refinancingFeasibilityInputSchema,
  type RefinancingFeasibilityResult,
} from './feasibility.js';

export const usdMicroSchema = baseUnitAmountSchema.describe(
  'Unsigned USD amount with six decimals',
);
export const positiveUsdMicroSchema = positiveBaseUnitAmountSchema.describe(
  'Positive USD amount with six decimals',
);

export const routeCostBreakdownSchema = z
  .object({
    sourceGasUsdMicro: usdMicroSchema,
    destinationGasUsdMicro: usdMicroSchema,
    transportFeeUsdMicro: usdMicroSchema,
    slippageUsdMicro: usdMicroSchema,
    solverFeeUsdMicro: usdMicroSchema,
    protocolFeeUsdMicro: usdMicroSchema,
    collateralSwapCostUsdMicro: usdMicroSchema,
  })
  .strict();

export const rateProjectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('LINEAR_KINK'),
      availableLiquidityUnits: baseUnitAmountSchema,
      totalBorrowUnits: baseUnitAmountSchema,
      optimalUtilizationBps: z.number().int().min(1).max(9_999),
      baseRateBps: z.number().int().min(0).max(1_000_000),
      slope1Bps: z.number().int().min(0).max(1_000_000),
      slope2Bps: z.number().int().min(0).max(1_000_000),
      provenance: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('DIRECT_PROJECTION'),
      currentBorrowAprBps: z.number().int().min(0).max(1_000_000),
      projectedBorrowAprBps: z.number().int().min(0).max(1_000_000),
      provenance: z.string().trim().min(1).max(256),
    })
    .strict(),
]);

export const routeCandidateSchema = z
  .object({
    candidateId: z.string().trim().min(1).max(256),
    market: marketSnapshotSchema,
    requestedBorrowUnits: positiveBaseUnitAmountSchema,
    principalDebtValueUsdMicro: positiveUsdMicroSchema,
    targetDebtValueUsdMicro: positiveUsdMicroSchema,
    deliveredCollateralValueUsdMicro: positiveUsdMicroSchema,
    costs: routeCostBreakdownSchema,
    carryingCostAprBps: z.number().int().min(0).max(1_000_000),
    tailLossEstimateUsdMicro: usdMicroSchema,
    settlementRiskCostUsdMicro: usdMicroSchema,
    dependencyRiskCostUsdMicro: usdMicroSchema,
    estimatedSettlementSeconds: z.number().int().positive().max(86_400),
    settlementTimeP95Seconds: z.number().int().positive().max(604_800),
    rateProjection: rateProjectionSchema,
    assetRouteSupported: z.boolean(),
    adapterVersionApproved: z.boolean(),
    transportMinimumMet: z.boolean(),
    financing: refinancingFeasibilityInputSchema,
  })
  .strict();

export const routePolicySchema = z
  .object({
    evaluatedAt: z.iso.datetime({ offset: true }),
    horizonDays: z.number().int().positive().max(3_650),
    maxAllInCostUsdMicro: usdMicroSchema,
    minAprReductionBps: z.number().int().min(0).max(1_000_000),
    maxPositionSnapshotAgeSeconds: z.number().int().positive().max(86_400),
    maxMarketSnapshotAgeSeconds: z.number().int().positive().max(86_400),
    maxOracleAgeSeconds: z.number().int().positive().max(86_400),
    minimumLiquidityBufferBps: z.number().int().min(0).max(10_000),
    stressCollateralDropBps: z.number().int().min(0).max(9_500),
    stressTargetAprIncreaseBps: z.number().int().min(0).max(1_000_000),
    requirePositiveNetBenefit: z.boolean(),
    safetyPolicy: safetyPolicySchema,
  })
  .strict();

export const compareRoutesInputSchema = z
  .object({
    sourcePosition: positionSnapshotSchema,
    candidates: z.array(routeCandidateSchema).min(1).max(64),
    policy: routePolicySchema,
  })
  .strict();

const routeRiskRejectionCodes = [
  'ADAPTER_VERSION_UNAPPROVED',
  'APR_REDUCTION_BELOW_MINIMUM',
  'COST_ABOVE_MAXIMUM',
  'INSUFFICIENT_BORROW_LIQUIDITY',
  'MARKET_RISK_LIMIT_MISSING',
  'MARKET_SNAPSHOT_STALE',
  'NEGATIVE_NET_BENEFIT',
  'ORACLE_STALE',
  'ROUTE_UNSUPPORTED',
  'SOURCE_POSITION_STALE',
  'TRANSPORT_MINIMUM_NOT_MET',
  'UNSAFE_POST_STATE',
  'UNSAFE_STRESS_STATE',
  'REQUESTED_BORROW_MISMATCH',
] as const;

export const rejectionCodeSchema = z.enum([
  ...routeRiskRejectionCodes,
  ...feasibilityRejectionCodes,
]);

export type RouteCostBreakdown = z.infer<typeof routeCostBreakdownSchema>;
export type RateProjection = z.infer<typeof rateProjectionSchema>;
export type RouteCandidate = z.infer<typeof routeCandidateSchema>;
export type RoutePolicy = z.infer<typeof routePolicySchema>;
export type CompareRoutesInput = z.infer<typeof compareRoutesInputSchema>;
export type RejectionCode = z.infer<typeof rejectionCodeSchema>;

export interface RouteRejection {
  readonly code: RejectionCode;
  readonly message: string;
}

export interface RouteEconomics {
  readonly sourceAprBps: number;
  readonly targetAprBeforeBps: number;
  readonly targetAprAfterBps: number;
  readonly targetRateImpactBps: number;
  readonly aprReductionBps: number;
  readonly stressTargetAprBps: number;
  readonly allInCostUsdMicro: string;
  readonly carryingCostUsdMicro: string;
  readonly grossSavingsUsdMicro: string;
  readonly stressGrossSavingsUsdMicro: string;
  readonly netBenefitUsdMicro: string;
  readonly stressNetBenefitUsdMicro: string;
  readonly annualGrossSavingsUsdMicro: string;
  readonly breakEvenSeconds?: string;
}

export type RouteSafety =
  | {
      readonly kind: 'MAX_LTV_BPS';
      readonly postLtvBps: number;
      readonly stressLtvBps: number;
      readonly maximumLtvBps: number;
      readonly stressMaximumLtvBps: number;
    }
  | {
      readonly kind: 'MIN_HEALTH_FACTOR_WAD';
      readonly postHealthFactorWad: string;
      readonly stressHealthFactorWad: string;
      readonly minimumWad: string;
      readonly stressMinimumWad: string;
      readonly riskLimitBps?: number;
    };

export interface RouteEvaluation {
  readonly candidateId: string;
  readonly eligible: boolean;
  readonly rank?: number;
  readonly scoreUsdMicro: string;
  readonly economics: RouteEconomics;
  readonly safety: RouteSafety;
  readonly financing: RefinancingFeasibilityResult;
  readonly rejections: readonly RouteRejection[];
  readonly provenance: {
    readonly sourceSnapshotId: string;
    readonly marketSnapshotId: string;
    readonly marketBlockNumber: string;
    readonly marketBlockHash: string;
    readonly oracleUpdatedAt: string;
    readonly evaluatedAt: string;
    readonly rateProjection: string;
  };
}

export interface RouteComparison {
  readonly policyVersion: 1;
  readonly selectedCandidateId?: string;
  readonly evaluations: readonly RouteEvaluation[];
}

const signedIntegerTextSchema = z.string().regex(/^-?(0|[1-9][0-9]*)$/);

export const routeRejectionSchema = z
  .object({ code: rejectionCodeSchema, message: z.string() })
  .strict();

export const routeEconomicsSchema = z
  .object({
    sourceAprBps: z.number().int(),
    targetAprBeforeBps: z.number().int(),
    targetAprAfterBps: z.number().int(),
    targetRateImpactBps: z.number().int(),
    aprReductionBps: z.number().int(),
    stressTargetAprBps: z.number().int(),
    allInCostUsdMicro: baseUnitAmountSchema,
    carryingCostUsdMicro: baseUnitAmountSchema,
    grossSavingsUsdMicro: signedIntegerTextSchema,
    stressGrossSavingsUsdMicro: signedIntegerTextSchema,
    netBenefitUsdMicro: signedIntegerTextSchema,
    stressNetBenefitUsdMicro: signedIntegerTextSchema,
    annualGrossSavingsUsdMicro: signedIntegerTextSchema,
    breakEvenSeconds: baseUnitAmountSchema.optional(),
  })
  .strict();

export const routeSafetySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('MAX_LTV_BPS'),
      postLtvBps: z.number().int(),
      stressLtvBps: z.number().int(),
      maximumLtvBps: z.number().int(),
      stressMaximumLtvBps: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('MIN_HEALTH_FACTOR_WAD'),
      postHealthFactorWad: baseUnitAmountSchema,
      stressHealthFactorWad: baseUnitAmountSchema,
      minimumWad: baseUnitAmountSchema,
      stressMinimumWad: baseUnitAmountSchema,
      riskLimitBps: z.number().int().optional(),
    })
    .strict(),
]);

export const routeEvaluationSchema = z
  .object({
    candidateId: z.string(),
    eligible: z.boolean(),
    rank: z.number().int().positive().optional(),
    scoreUsdMicro: signedIntegerTextSchema,
    economics: routeEconomicsSchema,
    safety: routeSafetySchema,
    financing: refinancingFeasibilityResultSchema,
    rejections: z.array(routeRejectionSchema),
    provenance: z
      .object({
        sourceSnapshotId: z.string(),
        marketSnapshotId: z.string(),
        marketBlockNumber: z.string(),
        marketBlockHash: z.string(),
        oracleUpdatedAt: z.iso.datetime({ offset: true }),
        evaluatedAt: z.iso.datetime({ offset: true }),
        rateProjection: z.string(),
      })
      .strict(),
  })
  .strict();

export const routeComparisonSchema = z
  .object({
    policyVersion: z.literal(1),
    selectedCandidateId: z.string().optional(),
    evaluations: z.array(routeEvaluationSchema),
  })
  .strict() as z.ZodType<RouteComparison>;

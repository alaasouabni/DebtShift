import {
  baseUnitAmountSchema,
  bytes32Schema,
  canonicalTextSchema,
  evidenceVerificationStateSchema,
  evmAddressSchema,
  isoTimestampSchema,
  positiveBaseUnitAmountSchema,
  tokenReferenceSchema,
  type TokenReference,
} from '@debtshift/domain';
import { z } from 'zod';

export const feasibilityRejectionCodes = [
  'BORROWER_PREPAYMENT_ASSET_MISMATCH',
  'BORROWER_PREPAYMENT_EXCEEDS_SOURCE_DEBT',
  'BORROWER_PREPAYMENT_UNCONFIRMED',
  'COST_CONVERSION_INVALID',
  'DUPLICATE_FINANCING_COMPONENT',
  'EXTERNAL_FUNDING_ASSET_MISMATCH',
  'EXTERNAL_FUNDING_EXPIRED',
  'EXTERNAL_FUNDING_NOT_MIGRATION_BOUND',
  'EXTERNAL_FUNDING_UNCONFIRMED',
  'FUNDING_SHORTFALL',
  'REQUIRED_BORROW_EXCEEDS_SAFE_CAPACITY',
  'SOLVER_FEE_ASSET_MISMATCH',
  'SOLVER_FEE_EXCEEDS_SIGNED_CAP',
  'SOURCE_PAYOFF_CONVERSION_INVALID',
] as const;

export const feasibilityRejectionCodeSchema = z.enum(feasibilityRejectionCodes);

export const financingClassSchema = z.enum(['SOLVER_ADVANCED', 'CAPITALIZED', 'SEPARATELY_PAID']);

export const financingCostKindSchema = z.enum([
  'TRANSPORT',
  'PROTOCOL',
  'EXECUTION',
  'NETWORK',
  'SLIPPAGE',
  'OTHER',
]);

export const settlementConversionSchema = z
  .object({
    quoteHash: bytes32Schema,
    provider: canonicalTextSchema,
    inputAsset: tokenReferenceSchema,
    outputAsset: tokenReferenceSchema,
    amountInUnits: baseUnitAmountSchema,
    amountOutUnits: baseUnitAmountSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();

const settlementValuationSchema = z
  .object({
    asset: tokenReferenceSchema,
    amountUnits: baseUnitAmountSchema,
    settlementAmountUnits: baseUnitAmountSchema,
    conversion: settlementConversionSchema.optional(),
  })
  .strict();

export const sourcePayoffSchema = settlementValuationSchema.extend({
  amountUnits: positiveBaseUnitAmountSchema,
  settlementAmountUnits: positiveBaseUnitAmountSchema,
});

export const borrowerDebtPrepaymentSchema = settlementValuationSchema.extend({
  amountUnits: positiveBaseUnitAmountSchema,
  settlementAmountUnits: positiveBaseUnitAmountSchema,
  evidenceId: bytes32Schema,
  verificationState: evidenceVerificationStateSchema,
});

export const financingCostComponentSchema = settlementValuationSchema.extend({
  componentId: canonicalTextSchema,
  kind: financingCostKindSchema,
  financingClass: financingClassSchema,
});

export const solverFeeSchema = z
  .object({
    asset: tokenReferenceSchema,
    amountUnits: baseUnitAmountSchema,
    signedCapUnits: baseUnitAmountSchema,
  })
  .strict();

export const externalFundingSchema = z
  .object({
    fundingId: canonicalTextSchema,
    migrationId: bytes32Schema,
    evidenceId: bytes32Schema,
    asset: tokenReferenceSchema,
    amountUnits: positiveBaseUnitAmountSchema,
    escrow: evmAddressSchema,
    refundReceiver: evmAddressSchema,
    authorizedUse: canonicalTextSchema,
    verificationState: evidenceVerificationStateSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();

export const borrowingCapacitySchema = z
  .object({
    protocolUnits: baseUnitAmountSchema,
    policyUnits: baseUnitAmountSchema,
    liquidityUnits: baseUnitAmountSchema,
    signedUnits: baseUnitAmountSchema,
  })
  .strict();

export const refinancingFeasibilityInputSchema = z
  .object({
    evaluatedAt: isoTimestampSchema,
    migrationId: bytes32Schema.optional(),
    settlementAsset: tokenReferenceSchema,
    sourcePayoff: sourcePayoffSchema,
    borrowerDebtPrepayment: borrowerDebtPrepaymentSchema.optional(),
    costs: z.array(financingCostComponentSchema).max(64),
    solverFee: solverFeeSchema,
    externalFunding: z.array(externalFundingSchema).max(16),
    capacities: borrowingCapacitySchema,
  })
  .strict();

export type FeasibilityRejectionCode = z.infer<typeof feasibilityRejectionCodeSchema>;
export type FinancingClass = z.infer<typeof financingClassSchema>;
export type FinancingCostComponent = z.infer<typeof financingCostComponentSchema>;
export type RefinancingFeasibilityInput = z.infer<typeof refinancingFeasibilityInputSchema>;

export interface FeasibilityRejection {
  readonly code: FeasibilityRejectionCode;
  readonly message: string;
  readonly reference?: string;
}

export interface FinancingComponentResult {
  readonly componentId: string;
  readonly kind: z.infer<typeof financingCostKindSchema>;
  readonly financingClass: FinancingClass;
  readonly asset: TokenReference;
  readonly amountUnits: string;
  readonly settlementAmountUnits: string;
  readonly conversionQuoteHash?: string;
  readonly counted: boolean;
}

export interface ExternalFundingResult {
  readonly fundingId: string;
  readonly evidenceId: string;
  readonly migrationId: string;
  readonly asset: TokenReference;
  readonly amountUnits: string;
  readonly escrow: string;
  readonly refundReceiver: string;
  readonly authorizedUse: string;
  readonly verificationState: z.infer<typeof evidenceVerificationStateSchema>;
  readonly expiresAt: string;
  readonly counted: boolean;
  readonly exclusionCodes: readonly FeasibilityRejectionCode[];
}

export interface RefinancingFeasibilityResult {
  readonly modelVersion: 1;
  readonly eligible: boolean;
  readonly settlementAsset: TokenReference;
  readonly sourceDebtPayoffAssetUnits: string;
  readonly sourceDebtPayoffUnits: string;
  readonly sourceConversionQuoteHash?: string;
  readonly borrowerDebtPrepaymentUnits: string;
  readonly borrowerDebtPrepaymentEvidenceId?: string;
  readonly solverAdvancedCostUnits: string;
  readonly solverPrincipalUnits: string;
  readonly solverFeeUnits: string;
  readonly capitalizedCostUnits: string;
  readonly separatelyPaidCostUnits: string;
  readonly totalRequiredRepaymentAndFinancedCostUnits: string;
  readonly confirmedExternalFundingUnits: string;
  readonly protocolBorrowCapacityUnits: string;
  readonly policyBorrowCapacityUnits: string;
  readonly liquidityBorrowCapacityUnits: string;
  readonly signedBorrowCapacityUnits: string;
  readonly maximumSafeBorrowingCapacityUnits: string;
  readonly requiredDestinationBorrowUnits: string;
  readonly fundingShortfallUnits: string;
  readonly components: readonly FinancingComponentResult[];
  readonly externalFunding: readonly ExternalFundingResult[];
  readonly rejections: readonly FeasibilityRejection[];
}

/**
 * Reconciles every temporary-liquidity use against secured funding and the
 * independently bounded destination borrowing capacity. All arithmetic uses
 * settlement-token base units; display currency values are deliberately absent.
 */
export function evaluateRefinancingFeasibility(input: unknown): RefinancingFeasibilityResult {
  const parsed = refinancingFeasibilityInputSchema.parse(input);
  const rejections: FeasibilityRejection[] = [];
  const evaluatedAtMs = Date.parse(parsed.evaluatedAt);

  if (!validSettlementValuation(parsed.sourcePayoff, parsed.settlementAsset, evaluatedAtMs)) {
    reject(
      rejections,
      'SOURCE_PAYOFF_CONVERSION_INVALID',
      'The source payoff is not expressed through an exact, unexpired settlement-asset conversion.',
    );
  }

  const sourceDebt = BigInt(parsed.sourcePayoff.settlementAmountUnits);
  let borrowerPrepayment = 0n;
  if (parsed.borrowerDebtPrepayment !== undefined) {
    const prepayment = parsed.borrowerDebtPrepayment;
    if (!sameToken(prepayment.asset, parsed.sourcePayoff.asset)) {
      reject(
        rejections,
        'BORROWER_PREPAYMENT_ASSET_MISMATCH',
        'Borrower prepayment must reduce the exact source debt asset.',
      );
    }
    if (prepayment.verificationState !== 'FINALIZED') {
      reject(
        rejections,
        'BORROWER_PREPAYMENT_UNCONFIRMED',
        'Borrower prepayment is not backed by finalized source-protocol evidence.',
        prepayment.evidenceId,
      );
    }
    if (!validSettlementValuation(prepayment, parsed.settlementAsset, evaluatedAtMs)) {
      reject(
        rejections,
        'SOURCE_PAYOFF_CONVERSION_INVALID',
        'Borrower prepayment is not expressed through an exact, unexpired settlement-asset conversion.',
        prepayment.evidenceId,
      );
    }
    if (BigInt(prepayment.amountUnits) > BigInt(parsed.sourcePayoff.amountUnits)) {
      reject(
        rejections,
        'BORROWER_PREPAYMENT_EXCEEDS_SOURCE_DEBT',
        'Borrower prepayment exceeds the observed source payoff.',
        prepayment.evidenceId,
      );
    }
    if (
      prepayment.verificationState === 'FINALIZED' &&
      sameToken(prepayment.asset, parsed.sourcePayoff.asset) &&
      validSettlementValuation(prepayment, parsed.settlementAsset, evaluatedAtMs)
    ) {
      borrowerPrepayment = minBigInt(BigInt(prepayment.settlementAmountUnits), sourceDebt);
    }
  }

  const seenComponentIds = new Set<string>();
  const components: FinancingComponentResult[] = [];
  let solverAdvancedCosts = 0n;
  let capitalizedCosts = 0n;
  let separatelyPaidCosts = 0n;
  for (const component of parsed.costs) {
    const duplicate = seenComponentIds.has(component.componentId);
    if (duplicate) {
      reject(
        rejections,
        'DUPLICATE_FINANCING_COMPONENT',
        'A cost component identifier may be financed exactly once.',
        component.componentId,
      );
    } else {
      seenComponentIds.add(component.componentId);
    }
    const conversionValid = validSettlementValuation(
      component,
      parsed.settlementAsset,
      evaluatedAtMs,
    );
    if (!conversionValid) {
      reject(
        rejections,
        'COST_CONVERSION_INVALID',
        'A financed cost lacks an exact, unexpired conversion into the settlement asset.',
        component.componentId,
      );
    }
    const counted = !duplicate && conversionValid;
    const amount = counted ? BigInt(component.settlementAmountUnits) : 0n;
    if (component.financingClass === 'SOLVER_ADVANCED') solverAdvancedCosts += amount;
    if (component.financingClass === 'CAPITALIZED') capitalizedCosts += amount;
    if (component.financingClass === 'SEPARATELY_PAID') separatelyPaidCosts += amount;
    components.push({
      componentId: component.componentId,
      kind: component.kind,
      financingClass: component.financingClass,
      asset: component.asset,
      amountUnits: component.amountUnits,
      settlementAmountUnits: component.settlementAmountUnits,
      ...(component.conversion === undefined
        ? {}
        : { conversionQuoteHash: component.conversion.quoteHash }),
      counted,
    });
  }

  const solverFeeAssetMatches = sameToken(parsed.solverFee.asset, parsed.settlementAsset);
  if (!solverFeeAssetMatches) {
    reject(
      rejections,
      'SOLVER_FEE_ASSET_MISMATCH',
      'Solver fee must be denominated in the settlement asset.',
    );
  }
  const solverFee = solverFeeAssetMatches ? BigInt(parsed.solverFee.amountUnits) : 0n;
  if (BigInt(parsed.solverFee.amountUnits) > BigInt(parsed.solverFee.signedCapUnits)) {
    reject(
      rejections,
      'SOLVER_FEE_EXCEEDS_SIGNED_CAP',
      'Solver fee exceeds the borrower-signed fee cap.',
    );
  }

  let confirmedExternalFunding = 0n;
  const fundingResults: ExternalFundingResult[] = [];
  for (const funding of parsed.externalFunding) {
    const exclusionCodes: FeasibilityRejectionCode[] = [];
    if (!sameToken(funding.asset, parsed.settlementAsset)) {
      exclusionCodes.push('EXTERNAL_FUNDING_ASSET_MISMATCH');
      reject(
        rejections,
        'EXTERNAL_FUNDING_ASSET_MISMATCH',
        'External funding is not denominated in the settlement asset.',
        funding.fundingId,
      );
    }
    if (funding.verificationState !== 'FINALIZED') {
      exclusionCodes.push('EXTERNAL_FUNDING_UNCONFIRMED');
      reject(
        rejections,
        'EXTERNAL_FUNDING_UNCONFIRMED',
        'Only finalized escrow funding can satisfy the repayment obligation.',
        funding.fundingId,
      );
    }
    if (parsed.migrationId === undefined || funding.migrationId !== parsed.migrationId) {
      exclusionCodes.push('EXTERNAL_FUNDING_NOT_MIGRATION_BOUND');
      reject(
        rejections,
        'EXTERNAL_FUNDING_NOT_MIGRATION_BOUND',
        'External funding must be isolated for this exact migration.',
        funding.fundingId,
      );
    }
    if (Date.parse(funding.expiresAt) <= evaluatedAtMs) {
      exclusionCodes.push('EXTERNAL_FUNDING_EXPIRED');
      reject(
        rejections,
        'EXTERNAL_FUNDING_EXPIRED',
        'External funding authorization has expired.',
        funding.fundingId,
      );
    }
    const counted = exclusionCodes.length === 0;
    if (counted) confirmedExternalFunding += BigInt(funding.amountUnits);
    fundingResults.push({
      fundingId: funding.fundingId,
      evidenceId: funding.evidenceId,
      migrationId: funding.migrationId,
      asset: funding.asset,
      amountUnits: funding.amountUnits,
      escrow: funding.escrow,
      refundReceiver: funding.refundReceiver,
      authorizedUse: funding.authorizedUse,
      verificationState: funding.verificationState,
      expiresAt: funding.expiresAt,
      counted,
      exclusionCodes,
    });
  }

  const uncoveredSourceDebt =
    sourceDebt > borrowerPrepayment ? sourceDebt - borrowerPrepayment : 0n;
  const solverPrincipal = uncoveredSourceDebt + solverAdvancedCosts;
  const totalRequired = solverPrincipal + solverFee + capitalizedCosts;
  const protocolCapacity = BigInt(parsed.capacities.protocolUnits);
  const policyCapacity = BigInt(parsed.capacities.policyUnits);
  const liquidityCapacity = BigInt(parsed.capacities.liquidityUnits);
  const signedCapacity = BigInt(parsed.capacities.signedUnits);
  const maximumSafeCapacity = minBigInt(
    protocolCapacity,
    policyCapacity,
    liquidityCapacity,
    signedCapacity,
  );
  const requiredBorrow =
    totalRequired > confirmedExternalFunding ? totalRequired - confirmedExternalFunding : 0n;
  const availableFunding = maximumSafeCapacity + confirmedExternalFunding;
  const fundingShortfall = totalRequired > availableFunding ? totalRequired - availableFunding : 0n;

  if (requiredBorrow > maximumSafeCapacity) {
    reject(
      rejections,
      'REQUIRED_BORROW_EXCEEDS_SAFE_CAPACITY',
      'Required destination borrowing exceeds the minimum of protocol, policy, liquidity, and signed capacity.',
    );
  }
  if (fundingShortfall > 0n) {
    reject(
      rejections,
      'FUNDING_SHORTFALL',
      'Confirmed external funding plus safe destination borrowing cannot cover all financed uses.',
    );
  }

  return {
    modelVersion: 1,
    eligible: rejections.length === 0,
    settlementAsset: parsed.settlementAsset,
    sourceDebtPayoffAssetUnits: parsed.sourcePayoff.amountUnits,
    sourceDebtPayoffUnits: sourceDebt.toString(),
    ...(parsed.sourcePayoff.conversion === undefined
      ? {}
      : { sourceConversionQuoteHash: parsed.sourcePayoff.conversion.quoteHash }),
    borrowerDebtPrepaymentUnits: borrowerPrepayment.toString(),
    ...(parsed.borrowerDebtPrepayment === undefined
      ? {}
      : { borrowerDebtPrepaymentEvidenceId: parsed.borrowerDebtPrepayment.evidenceId }),
    solverAdvancedCostUnits: solverAdvancedCosts.toString(),
    solverPrincipalUnits: solverPrincipal.toString(),
    solverFeeUnits: solverFee.toString(),
    capitalizedCostUnits: capitalizedCosts.toString(),
    separatelyPaidCostUnits: separatelyPaidCosts.toString(),
    totalRequiredRepaymentAndFinancedCostUnits: totalRequired.toString(),
    confirmedExternalFundingUnits: confirmedExternalFunding.toString(),
    protocolBorrowCapacityUnits: protocolCapacity.toString(),
    policyBorrowCapacityUnits: policyCapacity.toString(),
    liquidityBorrowCapacityUnits: liquidityCapacity.toString(),
    signedBorrowCapacityUnits: signedCapacity.toString(),
    maximumSafeBorrowingCapacityUnits: maximumSafeCapacity.toString(),
    requiredDestinationBorrowUnits: requiredBorrow.toString(),
    fundingShortfallUnits: fundingShortfall.toString(),
    components,
    externalFunding: fundingResults,
    rejections,
  };
}

function validSettlementValuation(
  value: {
    readonly asset: TokenReference;
    readonly amountUnits: string;
    readonly settlementAmountUnits: string;
    readonly conversion?: z.infer<typeof settlementConversionSchema> | undefined;
  },
  settlementAsset: TokenReference,
  evaluatedAtMs: number,
): boolean {
  if (sameToken(value.asset, settlementAsset)) {
    return value.amountUnits === value.settlementAmountUnits && value.conversion === undefined;
  }
  const conversion = value.conversion;
  return (
    conversion !== undefined &&
    sameToken(conversion.inputAsset, value.asset) &&
    sameToken(conversion.outputAsset, settlementAsset) &&
    conversion.amountInUnits === value.amountUnits &&
    conversion.amountOutUnits === value.settlementAmountUnits &&
    Date.parse(conversion.expiresAt) > evaluatedAtMs
  );
}

function sameToken(left: TokenReference, right: TokenReference): boolean {
  return (
    left.chainId === right.chainId &&
    left.address.toLowerCase() === right.address.toLowerCase() &&
    left.decimals === right.decimals
  );
}

function reject(
  rejections: FeasibilityRejection[],
  code: FeasibilityRejectionCode,
  message: string,
  reference?: string,
): void {
  rejections.push({ code, message, ...(reference === undefined ? {} : { reference }) });
}

function minBigInt(first: bigint, ...rest: readonly bigint[]): bigint {
  return rest.reduce((minimum, value) => (value < minimum ? value : minimum), first);
}

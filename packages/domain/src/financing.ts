import { z } from 'zod';

import { tokenReferenceSchema, type TokenReference } from './assets.js';
import {
  baseUnitAmountSchema,
  basisPointsSchema,
  bytes32Schema,
  canonicalTextSchema,
  evmAddressSchema,
  isoTimestampSchema,
  positiveBaseUnitAmountSchema,
  uint64StringSchema,
} from './primitives.js';

export const executionFinancingClassSchema = z.enum([
  'SOLVER_ADVANCED',
  'CAPITALIZED',
  'SEPARATELY_PAID',
]);

export const executionFinancingCostKindSchema = z.enum([
  'TRANSPORT',
  'PROTOCOL',
  'EXECUTION',
  'NETWORK',
  'SLIPPAGE',
  'OTHER',
]);

export const executionFinancingComponentSchema = z
  .object({
    componentId: canonicalTextSchema,
    kind: executionFinancingCostKindSchema,
    financingClass: executionFinancingClassSchema,
    asset: tokenReferenceSchema,
    amountUnits: positiveBaseUnitAmountSchema,
    settlementAmountUnits: positiveBaseUnitAmountSchema,
    conversionQuoteHash: bytes32Schema.optional(),
  })
  .strict();

export const confirmedExternalFundingSchema = z
  .object({
    fundingId: canonicalTextSchema,
    evidenceId: bytes32Schema,
    asset: tokenReferenceSchema,
    amountUnits: positiveBaseUnitAmountSchema,
    escrow: evmAddressSchema,
    refundReceiver: evmAddressSchema,
    authorizedUse: canonicalTextSchema,
    verificationState: z.literal('FINALIZED'),
    expiresAt: uint64StringSchema,
  })
  .strict();

export const executionFinancingSchema = z
  .object({
    modelVersion: z.literal(1),
    evaluatedAt: isoTimestampSchema,
    validUntil: uint64StringSchema,
    capacityEvidenceHash: bytes32Schema,
    liquidityBufferBps: basisPointsSchema,
    stressCollateralDropBps: basisPointsSchema,
    settlementAsset: tokenReferenceSchema,
    sourceDebtPayoffAssetUnits: positiveBaseUnitAmountSchema,
    sourceDebtPayoffUnits: positiveBaseUnitAmountSchema,
    sourceConversionQuoteHash: bytes32Schema.optional(),
    borrowerDebtPrepaymentAssetUnits: baseUnitAmountSchema,
    borrowerDebtPrepaymentUnits: baseUnitAmountSchema,
    borrowerDebtPrepaymentEvidenceId: bytes32Schema.optional(),
    costs: z.array(executionFinancingComponentSchema).max(64),
    solverAdvancedCostUnits: baseUnitAmountSchema,
    solverPrincipalUnits: positiveBaseUnitAmountSchema,
    solverFeeUnits: baseUnitAmountSchema,
    capitalizedCostUnits: baseUnitAmountSchema,
    separatelyPaidCostUnits: baseUnitAmountSchema,
    totalRequiredRepaymentAndFinancedCostUnits: positiveBaseUnitAmountSchema,
    externalFunding: z.array(confirmedExternalFundingSchema).max(16),
    confirmedExternalFundingUnits: baseUnitAmountSchema,
    protocolBorrowCapacityUnits: baseUnitAmountSchema,
    policyBorrowCapacityUnits: baseUnitAmountSchema,
    liquidityBorrowCapacityUnits: baseUnitAmountSchema,
    signedBorrowCapacityUnits: baseUnitAmountSchema,
    maximumSafeBorrowingCapacityUnits: baseUnitAmountSchema,
    requiredDestinationBorrowUnits: baseUnitAmountSchema,
    fundingShortfallUnits: baseUnitAmountSchema,
  })
  .strict()
  .superRefine((financing, context) => {
    const evaluatedAtSeconds = BigInt(Math.floor(Date.parse(financing.evaluatedAt) / 1_000));
    if (BigInt(financing.validUntil) <= evaluatedAtSeconds) {
      issue(context, ['validUntil'], 'Financing evidence must remain valid after evaluation.');
    }

    const componentIds = new Set<string>();
    let solverAdvanced = 0n;
    let capitalized = 0n;
    let separatelyPaid = 0n;
    for (const [index, component] of financing.costs.entries()) {
      if (componentIds.has(component.componentId)) {
        issue(context, ['costs', index, 'componentId'], 'A cost component may be financed once.');
      }
      componentIds.add(component.componentId);
      const sameAsset = sameToken(component.asset, financing.settlementAsset);
      if (sameAsset && component.amountUnits !== component.settlementAmountUnits) {
        issue(
          context,
          ['costs', index, 'settlementAmountUnits'],
          'A settlement-asset cost must retain its exact base-unit amount.',
        );
      }
      if (!sameAsset && component.conversionQuoteHash === undefined) {
        issue(
          context,
          ['costs', index, 'conversionQuoteHash'],
          'A cost in another asset requires a signed conversion commitment.',
        );
      }
      const amount = BigInt(component.settlementAmountUnits);
      if (component.financingClass === 'SOLVER_ADVANCED') solverAdvanced += amount;
      if (component.financingClass === 'CAPITALIZED') capitalized += amount;
      if (component.financingClass === 'SEPARATELY_PAID') separatelyPaid += amount;
    }
    exactAmount(
      context,
      financing.solverAdvancedCostUnits,
      solverAdvanced,
      ['solverAdvancedCostUnits'],
      'Solver-advanced cost total does not reconcile.',
    );
    exactAmount(
      context,
      financing.capitalizedCostUnits,
      capitalized,
      ['capitalizedCostUnits'],
      'Capitalized cost total does not reconcile.',
    );
    exactAmount(
      context,
      financing.separatelyPaidCostUnits,
      separatelyPaid,
      ['separatelyPaidCostUnits'],
      'Separately paid cost total does not reconcile.',
    );

    const sourcePayoff = BigInt(financing.sourceDebtPayoffUnits);
    const prepayment = BigInt(financing.borrowerDebtPrepaymentUnits);
    if (prepayment > sourcePayoff) {
      issue(
        context,
        ['borrowerDebtPrepaymentUnits'],
        'Borrower prepayment cannot exceed the source payoff.',
      );
    }
    if (prepayment > 0n && financing.borrowerDebtPrepaymentEvidenceId === undefined) {
      issue(
        context,
        ['borrowerDebtPrepaymentEvidenceId'],
        'A non-zero borrower prepayment requires finalized evidence.',
      );
    }
    if (prepayment === 0n && BigInt(financing.borrowerDebtPrepaymentAssetUnits) !== 0n) {
      issue(
        context,
        ['borrowerDebtPrepaymentAssetUnits'],
        'Source-asset prepayment cannot be non-zero when settlement prepayment is zero.',
      );
    }
    const solverPrincipal = sourcePayoff - prepayment + solverAdvanced;
    exactAmount(
      context,
      financing.solverPrincipalUnits,
      solverPrincipal,
      ['solverPrincipalUnits'],
      'Solver principal does not reconcile to payoff, prepayment, and advanced costs.',
    );
    const totalRequired =
      solverPrincipal + BigInt(financing.solverFeeUnits) + BigInt(financing.capitalizedCostUnits);
    exactAmount(
      context,
      financing.totalRequiredRepaymentAndFinancedCostUnits,
      totalRequired,
      ['totalRequiredRepaymentAndFinancedCostUnits'],
      'Total repayment and financed costs do not reconcile.',
    );

    const fundingIds = new Set<string>();
    const evidenceIds = new Set<string>();
    let externalFunding = 0n;
    for (const [index, funding] of financing.externalFunding.entries()) {
      if (fundingIds.has(funding.fundingId) || evidenceIds.has(funding.evidenceId)) {
        issue(
          context,
          ['externalFunding', index],
          'Confirmed external funding identifiers must be unique.',
        );
      }
      fundingIds.add(funding.fundingId);
      evidenceIds.add(funding.evidenceId);
      if (!sameToken(funding.asset, financing.settlementAsset)) {
        issue(
          context,
          ['externalFunding', index, 'asset'],
          'Confirmed external funding must use the settlement asset.',
        );
      }
      if (BigInt(funding.expiresAt) < BigInt(financing.validUntil)) {
        issue(
          context,
          ['externalFunding', index, 'expiresAt'],
          'External funding must remain authorized through the financing validity window.',
        );
      }
      externalFunding += BigInt(funding.amountUnits);
    }
    exactAmount(
      context,
      financing.confirmedExternalFundingUnits,
      externalFunding,
      ['confirmedExternalFundingUnits'],
      'Confirmed external funding total does not reconcile.',
    );

    const safeCapacity = minimum(
      BigInt(financing.protocolBorrowCapacityUnits),
      BigInt(financing.policyBorrowCapacityUnits),
      BigInt(financing.liquidityBorrowCapacityUnits),
      BigInt(financing.signedBorrowCapacityUnits),
    );
    exactAmount(
      context,
      financing.maximumSafeBorrowingCapacityUnits,
      safeCapacity,
      ['maximumSafeBorrowingCapacityUnits'],
      'Maximum safe borrowing capacity is not the minimum of all capacity bounds.',
    );
    const requiredBorrow = totalRequired > externalFunding ? totalRequired - externalFunding : 0n;
    exactAmount(
      context,
      financing.requiredDestinationBorrowUnits,
      requiredBorrow,
      ['requiredDestinationBorrowUnits'],
      'Required destination borrowing does not reconcile.',
    );
    const totalAvailable = safeCapacity + externalFunding;
    const shortfall = totalRequired > totalAvailable ? totalRequired - totalAvailable : 0n;
    exactAmount(
      context,
      financing.fundingShortfallUnits,
      shortfall,
      ['fundingShortfallUnits'],
      'Funding shortfall does not reconcile.',
    );
    if (shortfall !== 0n) {
      issue(
        context,
        ['fundingShortfallUnits'],
        'An executable financing structure must have zero shortfall.',
      );
    }
    if (requiredBorrow > safeCapacity) {
      issue(
        context,
        ['requiredDestinationBorrowUnits'],
        'Required destination borrowing exceeds safe capacity.',
      );
    }
  });

export type ExecutionFinancingComponent = z.infer<typeof executionFinancingComponentSchema>;
export type ConfirmedExternalFunding = z.infer<typeof confirmedExternalFundingSchema>;
export type ExecutionFinancing = z.infer<typeof executionFinancingSchema>;

function sameToken(left: TokenReference, right: TokenReference): boolean {
  return (
    left.chainId === right.chainId &&
    left.address.toLowerCase() === right.address.toLowerCase() &&
    left.decimals === right.decimals
  );
}

function exactAmount(
  context: z.RefinementCtx,
  actual: string,
  expected: bigint,
  path: PropertyKey[],
  message: string,
): void {
  if (BigInt(actual) !== expected) issue(context, path, message);
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function minimum(first: bigint, ...rest: readonly bigint[]): bigint {
  return rest.reduce((current, value) => (value < current ? value : current), first);
}

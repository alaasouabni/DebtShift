import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseAbiParameters,
  stringToHex,
} from 'viem';
import type { Address, Hex } from 'viem';

import type { MarketReference, PositionReference, Protocol, TokenReference } from './assets.js';
import type { ExecutionPlan, RefinanceIntent, SafetyPolicy } from './authorization.js';
import type {
  ConfirmedExternalFunding,
  ExecutionFinancing,
  ExecutionFinancingComponent,
} from './financing.js';

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex;

const protocolIds: Readonly<Record<Protocol, Hex>> = Object.freeze({
  AAVE_V3: keccak256(stringToHex('debtshift.protocol.aave-v3.v1')),
  MORPHO_BLUE: keccak256(stringToHex('debtshift.protocol.morpho-blue.v1')),
  LOCAL_AAVE_MOCK: keccak256(stringToHex('debtshift.protocol.local-aave-mock.v1')),
  LOCAL_MORPHO_MOCK: keccak256(stringToHex('debtshift.protocol.local-morpho-mock.v1')),
});

const safetyPolicyIds = Object.freeze({
  MIN_HEALTH_FACTOR_WAD: keccak256(stringToHex('debtshift.safety.min-health-factor-wad.v1')),
  MAX_LTV_BPS: keccak256(stringToHex('debtshift.safety.max-ltv-bps.v1')),
});

export const refinanceIntentTypes = {
  RefinanceIntent: [
    { name: 'borrower', type: 'address' },
    { name: 'sourcePositionId', type: 'bytes32' },
    { name: 'allowedTargetsHash', type: 'bytes32' },
    { name: 'feeAssetHash', type: 'bytes32' },
    { name: 'maxSourceDebt', type: 'uint256' },
    { name: 'minSourceCollateral', type: 'uint256' },
    { name: 'maxTotalFee', type: 'uint256' },
    { name: 'maxSlippageBps', type: 'uint32' },
    { name: 'minAprReductionBps', type: 'uint32' },
    { name: 'safetyPolicyHash', type: 'bytes32' },
    { name: 'maxDurationSeconds', type: 'uint32' },
    { name: 'expiration', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const executionPlanTypes = {
  ExecutionPlan: [
    { name: 'intentHash', type: 'bytes32' },
    { name: 'migrationId', type: 'bytes32' },
    { name: 'borrower', type: 'address' },
    { name: 'sourcePositionId', type: 'bytes32' },
    { name: 'routeHash', type: 'bytes32' },
    { name: 'transportQuoteHash', type: 'bytes32' },
    { name: 'sourceRepaymentMax', type: 'uint256' },
    { name: 'sourceCollateralMin', type: 'uint256' },
    { name: 'targetDebtMax', type: 'uint256' },
    { name: 'minDestinationCollateral', type: 'uint256' },
    { name: 'principalMax', type: 'uint256' },
    { name: 'feeMax', type: 'uint256' },
    { name: 'destinationReceiver', type: 'address' },
    { name: 'transportRefundReceiver', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'payoutReceiver', type: 'address' },
    { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

function debtShiftDomain(chainId: number, verifyingContract: Address) {
  return {
    name: 'DebtShift',
    version: '2',
    chainId,
    verifyingContract,
  } as const;
}

export function protocolId(protocol: Protocol): Hex {
  return protocolIds[protocol];
}

export function hashCanonicalText(value: string): Hex {
  return keccak256(stringToHex(value.normalize('NFC')));
}

export function hashMarketReference(market: MarketReference): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('uint256, bytes32, address, bytes32'), [
      BigInt(market.chainId),
      protocolId(market.protocol),
      market.deployment,
      market.marketId,
    ]),
  );
}

export function hashTokenReference(asset: TokenReference): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('uint256, address, uint8'), [
      BigInt(asset.chainId),
      asset.address,
      asset.decimals,
    ]),
  );
}

export function hashSourcePosition(position: PositionReference): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, address, bytes32, bytes32'), [
      hashMarketReference(position.market),
      position.borrower,
      hashTokenReference(position.collateralAsset),
      hashTokenReference(position.debtAsset),
    ]),
  );
}

export function hashSafetyPolicy(policy: SafetyPolicy): Hex {
  if (policy.kind === 'MIN_HEALTH_FACTOR_WAD') {
    return keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, uint256, uint256'), [
        safetyPolicyIds.MIN_HEALTH_FACTOR_WAD,
        BigInt(policy.minimumWad),
        BigInt(policy.stressMinimumWad),
      ]),
    );
  }

  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, uint256, uint256'), [
      safetyPolicyIds.MAX_LTV_BPS,
      BigInt(policy.maximumLtvBps),
      BigInt(policy.stressMaximumLtvBps),
    ]),
  );
}

export function hashAllowedTargets(targets: readonly MarketReference[]): Hex {
  const targetHashes = targets.map(hashMarketReference).sort();
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32[]'), [targetHashes]));
}

export function getRefinanceIntentTypedData(intent: RefinanceIntent, verifyingContract: Address) {
  return {
    domain: debtShiftDomain(intent.sourcePosition.market.chainId, verifyingContract),
    primaryType: 'RefinanceIntent',
    types: refinanceIntentTypes,
    message: {
      borrower: intent.borrower,
      sourcePositionId: hashSourcePosition(intent.sourcePosition),
      allowedTargetsHash: hashAllowedTargets(intent.allowedTargets),
      feeAssetHash: hashTokenReference(intent.feeAsset),
      maxSourceDebt: BigInt(intent.maxSourceDebtUnits),
      minSourceCollateral: BigInt(intent.minSourceCollateralUnits),
      maxTotalFee: BigInt(intent.maxTotalFeeUnits),
      maxSlippageBps: intent.maxSlippageBps,
      minAprReductionBps: intent.minAprReductionBps,
      safetyPolicyHash: hashSafetyPolicy(intent.safetyPolicy),
      maxDurationSeconds: intent.maxDurationSeconds,
      expiration: BigInt(intent.expiration),
      nonce: BigInt(intent.nonce),
    },
  } as const;
}

export function hashRefinanceIntent(intent: RefinanceIntent, verifyingContract: Address): Hex {
  return hashTypedData(getRefinanceIntentTypedData(intent, verifyingContract));
}

export function computeMigrationId(intentHash: Hex, transportQuoteHash: Hex, nonce: bigint): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint256'), [
      intentHash,
      transportQuoteHash,
      nonce,
    ]),
  );
}

export function computeRouteHash(plan: ExecutionPlan): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, uint256, uint256, uint256, uint256, bytes32, bytes32, bytes32, address, address, address, address, bytes32, bytes32, address, uint256, uint256, bytes32, uint64',
      ),
      [
        plan.sourcePositionId,
        hashMarketReference(plan.sourceMarket),
        hashMarketReference(plan.targetMarket),
        hashTokenReference(plan.sourceDebtAsset),
        hashTokenReference(plan.sourceCollateralAsset),
        hashTokenReference(plan.destinationDebtAsset),
        hashTokenReference(plan.destinationCollateralAsset),
        BigInt(plan.sourceRepaymentMaxUnits),
        BigInt(plan.sourceCollateralMinUnits),
        BigInt(plan.targetDebtMaxUnits),
        BigInt(plan.minDestinationCollateralUnits),
        hashCanonicalText(plan.transportProvider),
        plan.transportQuoteHash,
        hashCanonicalText(plan.transportDepositAddress),
        plan.destinationReceiver,
        plan.transportRefundReceiver,
        plan.refundReceiver,
        plan.fundingProvider,
        plan.reservationHash,
        hashTokenReference(plan.payoutAsset),
        plan.payoutReceiver,
        BigInt(plan.principalMaxUnits),
        BigInt(plan.feeMaxUnits),
        hashExecutionFinancing(plan.financing),
        BigInt(plan.deadline),
      ],
    ),
  );
}

export function hashExecutionFinancing(financing: ExecutionFinancing): Hex {
  const amountsHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256',
      ),
      [
        BigInt(financing.sourceDebtPayoffAssetUnits),
        BigInt(financing.sourceDebtPayoffUnits),
        BigInt(financing.borrowerDebtPrepaymentAssetUnits),
        BigInt(financing.borrowerDebtPrepaymentUnits),
        BigInt(financing.solverAdvancedCostUnits),
        BigInt(financing.solverPrincipalUnits),
        BigInt(financing.solverFeeUnits),
        BigInt(financing.capitalizedCostUnits),
        BigInt(financing.separatelyPaidCostUnits),
        BigInt(financing.totalRequiredRepaymentAndFinancedCostUnits),
        BigInt(financing.confirmedExternalFundingUnits),
        BigInt(financing.protocolBorrowCapacityUnits),
        BigInt(financing.policyBorrowCapacityUnits),
        BigInt(financing.liquidityBorrowCapacityUnits),
        BigInt(financing.signedBorrowCapacityUnits),
        BigInt(financing.maximumSafeBorrowingCapacityUnits),
        BigInt(financing.requiredDestinationBorrowUnits),
        BigInt(financing.fundingShortfallUnits),
      ],
    ),
  );
  const componentHashes = financing.costs.map(hashExecutionFinancingComponent);
  const fundingHashes = financing.externalFunding.map(hashConfirmedExternalFunding);
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'uint8, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, bytes32, uint16, uint16, uint64',
      ),
      [
        financing.modelVersion,
        hashTokenReference(financing.settlementAsset),
        financing.sourceConversionQuoteHash ?? ZERO_BYTES32,
        financing.borrowerDebtPrepaymentEvidenceId ?? ZERO_BYTES32,
        amountsHash,
        keccak256(encodeAbiParameters(parseAbiParameters('bytes32[]'), [componentHashes])),
        keccak256(encodeAbiParameters(parseAbiParameters('bytes32[]'), [fundingHashes])),
        hashCanonicalText(financing.evaluatedAt),
        financing.capacityEvidenceHash,
        financing.liquidityBufferBps,
        financing.stressCollateralDropBps,
        BigInt(financing.validUntil),
      ],
    ),
  );
}

function hashExecutionFinancingComponent(component: ExecutionFinancingComponent): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, bytes32, bytes32, bytes32, uint256, uint256, bytes32'),
      [
        hashCanonicalText(component.componentId),
        hashCanonicalText(component.kind),
        hashCanonicalText(component.financingClass),
        hashTokenReference(component.asset),
        BigInt(component.amountUnits),
        BigInt(component.settlementAmountUnits),
        component.conversionQuoteHash ?? ZERO_BYTES32,
      ],
    ),
  );
}

function hashConfirmedExternalFunding(funding: ConfirmedExternalFunding): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32, bytes32, bytes32, uint256, address, address, bytes32, bytes32, uint64',
      ),
      [
        hashCanonicalText(funding.fundingId),
        funding.evidenceId,
        hashTokenReference(funding.asset),
        BigInt(funding.amountUnits),
        funding.escrow,
        funding.refundReceiver,
        hashCanonicalText(funding.authorizedUse),
        hashCanonicalText(funding.verificationState),
        BigInt(funding.expiresAt),
      ],
    ),
  );
}

export function getExecutionPlanTypedData(plan: ExecutionPlan, verifyingContract: Address) {
  return {
    domain: debtShiftDomain(plan.sourceMarket.chainId, verifyingContract),
    primaryType: 'ExecutionPlan',
    types: executionPlanTypes,
    message: {
      intentHash: plan.intentHash,
      migrationId: plan.migrationId,
      borrower: plan.borrower,
      sourcePositionId: plan.sourcePositionId,
      routeHash: plan.routeHash,
      transportQuoteHash: plan.transportQuoteHash,
      sourceRepaymentMax: BigInt(plan.sourceRepaymentMaxUnits),
      sourceCollateralMin: BigInt(plan.sourceCollateralMinUnits),
      targetDebtMax: BigInt(plan.targetDebtMaxUnits),
      minDestinationCollateral: BigInt(plan.minDestinationCollateralUnits),
      principalMax: BigInt(plan.principalMaxUnits),
      feeMax: BigInt(plan.feeMaxUnits),
      destinationReceiver: plan.destinationReceiver,
      transportRefundReceiver: plan.transportRefundReceiver,
      refundReceiver: plan.refundReceiver,
      payoutReceiver: plan.payoutReceiver,
      deadline: BigInt(plan.deadline),
      nonce: BigInt(plan.nonce),
    },
  } as const;
}

export function hashExecutionPlan(plan: ExecutionPlan, verifyingContract: Address): Hex {
  return hashTypedData(getExecutionPlanTypedData(plan, verifyingContract));
}

export function assertExecutionPlanIntegrity(plan: ExecutionPlan): void {
  const expectedMigrationId = computeMigrationId(
    plan.intentHash,
    plan.transportQuoteHash,
    BigInt(plan.nonce),
  );
  if (plan.migrationId !== expectedMigrationId) {
    throw new Error('Execution plan migration ID does not match its signed inputs.');
  }

  const expectedRouteHash = computeRouteHash(plan);
  if (plan.routeHash !== expectedRouteHash) {
    throw new Error('Execution plan route hash does not match its exact route fields.');
  }
}

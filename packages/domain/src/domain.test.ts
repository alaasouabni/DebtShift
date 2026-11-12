import { readFileSync } from 'node:fs';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { executionPlanSchema, refinanceIntentSchema } from './authorization.js';
import {
  assertExecutionPlanIntegrity,
  computeMigrationId,
  computeRouteHash,
  getExecutionPlanTypedData,
  getRefinanceIntentTypedData,
  hashCanonicalText,
  hashExecutionPlan,
  hashExecutionFinancing,
  hashRefinanceIntent,
  hashSourcePosition,
} from './hashing.js';
import type { Evidence } from './migration.js';
import {
  assertAllowedPhaseTransition,
  deriveMigrationPhase,
  phaseEvidenceFromRecords,
} from './phase.js';
import { baseUnitAmountSchema, evmAddressSchema } from './primitives.js';
import {
  verifyExecutionPlanEoaSignature,
  verifyRefinanceIntentEoaSignature,
} from './signatures.js';

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;
const QUOTE_HASH = `0x${'aa'.repeat(32)}` as const;
const RESERVATION_HASH = `0x${'bb'.repeat(32)}` as const;
const SOURCE_MARKET_ID = `0x${'11'.repeat(32)}` as const;
const TARGET_MARKET_ID = `0x${'22'.repeat(32)}` as const;
const TEST_PRIVATE_KEY = `0x${'7f'.repeat(32)}` as const;
const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const verifyingContract = evmAddressSchema.parse('0x9000000000000000000000000000000000000009');
const canonicalFixture = JSON.parse(
  readFileSync(new URL('../../../docs/fixtures/canonical-hashes-v1.json', import.meta.url), 'utf8'),
) as {
  outputs: {
    sourcePositionId: string;
    intentHash: string;
    migrationId: string;
    routeHash: string;
    executionPlanHash: string;
    financingHash: string;
  };
};

function buildIntent() {
  return refinanceIntentSchema.parse({
    borrower: account.address,
    accountType: 'EOA',
    sourcePosition: {
      market: {
        chainId: 31_337,
        protocol: 'LOCAL_AAVE_MOCK',
        deployment: '0x1000000000000000000000000000000000000001',
        marketId: SOURCE_MARKET_ID,
      },
      borrower: account.address,
      collateralAsset: {
        chainId: 31_337,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 18,
        symbol: 'dWETH',
      },
      debtAsset: {
        chainId: 31_337,
        address: '0x3000000000000000000000000000000000000003',
        decimals: 6,
        symbol: 'dUSDC',
      },
    },
    allowedTargets: [
      {
        chainId: 31_338,
        protocol: 'LOCAL_MORPHO_MOCK',
        deployment: '0x4000000000000000000000000000000000000004',
        marketId: TARGET_MARKET_ID,
      },
    ],
    feeAsset: {
      chainId: 31_338,
      address: '0x5000000000000000000000000000000000000005',
      decimals: 6,
      symbol: 'dUSDC',
    },
    maxSourceDebtUnits: '10000000000',
    minSourceCollateralUnits: '9900000000000000000',
    maxTotalFeeUnits: '100000000',
    maxSlippageBps: 50,
    minAprReductionBps: 150,
    safetyPolicy: {
      kind: 'MAX_LTV_BPS',
      maximumLtvBps: 7000,
      stressMaximumLtvBps: 6500,
    },
    maxDurationSeconds: 1800,
    expiration: '1794000000',
    nonce: '7',
  });
}

function buildPlan() {
  const intent = buildIntent();
  const intentHash = hashRefinanceIntent(intent, verifyingContract);
  const nonce = 9n;
  const migrationId = computeMigrationId(intentHash, QUOTE_HASH, nonce);
  const destinationDebtAsset = {
    chainId: 31_338,
    address: '0x5000000000000000000000000000000000000005',
    decimals: 6,
    symbol: 'dUSDC',
  };
  const rawPlan = executionPlanSchema.parse({
    intentHash,
    migrationId,
    borrower: intent.borrower,
    sourcePositionId: hashSourcePosition(intent.sourcePosition),
    sourceMarket: intent.sourcePosition.market,
    targetMarket: intent.allowedTargets[0],
    sourceDebtAsset: intent.sourcePosition.debtAsset,
    sourceCollateralAsset: intent.sourcePosition.collateralAsset,
    destinationDebtAsset,
    destinationCollateralAsset: {
      chainId: 31_338,
      address: '0x6000000000000000000000000000000000000006',
      decimals: 18,
      symbol: 'dWETH',
    },
    sourceRepaymentMaxUnits: '10000000000',
    sourceCollateralMinUnits: '9900000000000000000',
    targetDebtMaxUnits: '10050000000',
    minDestinationCollateralUnits: '9800000000000000000',
    transportProvider: 'DEBTSHIFT_SIMULATOR',
    transportQuoteHash: QUOTE_HASH,
    transportDepositAddress: 'simulator:deposit:migration-7',
    destinationReceiver: '0x7000000000000000000000000000000000000007',
    refundReceiver: account.address,
    fundingProvider: '0x8000000000000000000000000000000000000008',
    reservationHash: RESERVATION_HASH,
    payoutAsset: destinationDebtAsset,
    payoutReceiver: '0x8000000000000000000000000000000000000008',
    principalMaxUnits: '10000000000',
    feeMaxUnits: '50000000',
    financing: {
      modelVersion: 1,
      evaluatedAt: '2026-11-06T20:46:40.000Z',
      validUntil: '1793999000',
      capacityEvidenceHash: `0x${'dd'.repeat(32)}`,
      liquidityBufferBps: 1000,
      stressCollateralDropBps: 1000,
      settlementAsset: destinationDebtAsset,
      sourceDebtPayoffAssetUnits: '10000000000',
      sourceDebtPayoffUnits: '10000000000',
      sourceConversionQuoteHash: `0x${'cc'.repeat(32)}`,
      borrowerDebtPrepaymentAssetUnits: '0',
      borrowerDebtPrepaymentUnits: '0',
      costs: [
        {
          componentId: 'operator-execution-cost',
          kind: 'EXECUTION',
          financingClass: 'SEPARATELY_PAID',
          asset: destinationDebtAsset,
          amountUnits: '50000000',
          settlementAmountUnits: '50000000',
        },
      ],
      solverAdvancedCostUnits: '0',
      solverPrincipalUnits: '10000000000',
      solverFeeUnits: '50000000',
      capitalizedCostUnits: '0',
      separatelyPaidCostUnits: '50000000',
      totalRequiredRepaymentAndFinancedCostUnits: '10050000000',
      externalFunding: [],
      confirmedExternalFundingUnits: '0',
      protocolBorrowCapacityUnits: '12000000000',
      policyBorrowCapacityUnits: '11000000000',
      liquidityBorrowCapacityUnits: '15000000000',
      signedBorrowCapacityUnits: '10050000000',
      maximumSafeBorrowingCapacityUnits: '10050000000',
      requiredDestinationBorrowUnits: '10050000000',
      fundingShortfallUnits: '0',
    },
    routeHash: ZERO_BYTES32,
    deadline: '1793999000',
    nonce: nonce.toString(),
  });

  return executionPlanSchema.parse({ ...rawPlan, routeHash: computeRouteHash(rawPlan) });
}

function phaseEvidence(
  overrides: Partial<Parameters<typeof deriveMigrationPhase>[0]> = {},
): Parameters<typeof deriveMigrationPhase>[0] {
  return {
    sourceSnapshot: true,
    routeQuote: false,
    intentAuthorization: false,
    executionPlanAuthorization: false,
    financingFeasibility: false,
    financingRevalidation: false,
    supplementaryFunding: false,
    liquidityReservation: false,
    sourceClose: false,
    transportOrigin: false,
    transportDestination: false,
    targetPosition: false,
    liquiditySettlement: false,
    ledgerReconciliation: false,
    nearReceipt: false,
    expired: false,
    requoteRequired: false,
    recoveryOpened: false,
    recoveryCompleted: false,
    ...overrides,
  };
}

describe('financial primitives', () => {
  it('accepts canonical integer base units and rejects ambiguous amounts', () => {
    expect(baseUnitAmountSchema.parse('0')).toBe('0');
    expect(baseUnitAmountSchema.parse('1000000')).toBe('1000000');
    expect(() => baseUnitAmountSchema.parse('01')).toThrow();
    expect(() => baseUnitAmountSchema.parse('-1')).toThrow();
    expect(() => baseUnitAmountSchema.parse('1.5')).toThrow();
  });

  it('normalizes a valid EVM address and rejects a malformed one', () => {
    expect(evmAddressSchema.parse('0x9000000000000000000000000000000000000009')).toBe(
      verifyingContract,
    );
    expect(() => evmAddressSchema.parse('0x1234')).toThrow();
  });
});

describe('canonical authorization hashing', () => {
  it('matches the pinned cross-language hash fixture', () => {
    const intent = buildIntent();
    const plan = buildPlan();

    expect({
      sourcePositionId: hashSourcePosition(intent.sourcePosition),
      intentHash: hashRefinanceIntent(intent, verifyingContract),
      migrationId: plan.migrationId,
      routeHash: plan.routeHash,
      financingHash: hashExecutionFinancing(plan.financing),
      executionPlanHash: hashExecutionPlan(plan, verifyingContract),
    }).toEqual(canonicalFixture.outputs);
  });

  it('rejects a route mutation against the signed route hash', () => {
    const plan = buildPlan();
    assertExecutionPlanIntegrity(plan);

    const mutated = executionPlanSchema.parse({
      ...plan,
      destinationReceiver: '0x7100000000000000000000000000000000000007',
    });
    expect(() => assertExecutionPlanIntegrity(mutated)).toThrow('route hash');
  });

  it('verifies deterministic EOA signatures for both authorization layers', async () => {
    const intent = buildIntent();
    const plan = buildPlan();
    const intentSignature = await account.signTypedData(
      getRefinanceIntentTypedData(intent, verifyingContract),
    );
    const planSignature = await account.signTypedData(
      getExecutionPlanTypedData(plan, verifyingContract),
    );

    await expect(
      verifyRefinanceIntentEoaSignature(intent, verifyingContract, intentSignature),
    ).resolves.toBe(true);
    await expect(
      verifyExecutionPlanEoaSignature(plan, verifyingContract, planSignature),
    ).resolves.toBe(true);
  });
});

describe('evidence-derived migration phases', () => {
  it('advances only through a complete evidence prefix', () => {
    expect(deriveMigrationPhase(phaseEvidence())).toBe('DRAFT');
    expect(
      deriveMigrationPhase(
        phaseEvidence({
          routeQuote: true,
          intentAuthorization: true,
          executionPlanAuthorization: true,
          financingFeasibility: true,
          liquidityReservation: true,
          sourceClose: true,
          transportOrigin: true,
          transportDestination: true,
        }),
      ),
    ).toBe('DEST_FUNDED');
  });

  it('does not accept downstream evidence when an earlier predicate is missing', () => {
    expect(deriveMigrationPhase(phaseEvidence({ nearReceipt: true }))).toBe('DRAFT');
  });

  it('expires safely before source close and enters recovery after source close', () => {
    expect(deriveMigrationPhase(phaseEvidence({ expired: true }))).toBe('EXPIRED');
    expect(deriveMigrationPhase(phaseEvidence({ expired: true, sourceClose: true }))).toBe(
      'RECOVERY',
    );
  });

  it('requires a requote only while the source position remains open', () => {
    expect(deriveMigrationPhase(phaseEvidence({ requoteRequired: true }))).toBe('REQUOTE_REQUIRED');
    expect(() =>
      deriveMigrationPhase(phaseEvidence({ requoteRequired: true, sourceClose: true })),
    ).toThrow('cannot coexist');
    expect(() => assertAllowedPhaseTransition('RESERVED', 'REQUOTE_REQUIRED')).not.toThrow();
    expect(() => assertAllowedPhaseTransition('AUTHORIZED', 'REQUOTE_REQUIRED')).not.toThrow();
  });

  it('removes append-only retracted evidence from phase predicates', () => {
    const sourceClose: Evidence = {
      evidenceId: hashCanonicalText('source-close'),
      migrationId: hashCanonicalText('migration'),
      type: 'SOURCE_CLOSE',
      schemaVersion: 1,
      provider: 'test',
      network: 'eip155:31337',
      rawObservationHash: hashCanonicalText('source-close-observation'),
      normalizedPayload: {},
      observedAt: '2026-11-11T00:00:00.000Z',
      verificationState: 'FINALIZED',
      verificationMethod: 'RECEIPT_AND_STATE',
      verifierVersion: 'test-v1',
    };
    const retraction: Evidence = {
      ...sourceClose,
      evidenceId: hashCanonicalText('source-close-retraction'),
      rawObservationHash: hashCanonicalText('source-close-retraction-observation'),
      verificationState: 'RETRACTED',
      verificationMethod: 'CANONICAL_BLOCK_REVALIDATION',
      supersedesEvidenceId: sourceClose.evidenceId,
    };

    expect(phaseEvidenceFromRecords([sourceClose]).sourceClose).toBe(true);
    expect(phaseEvidenceFromRecords([sourceClose, retraction]).sourceClose).toBe(false);
  });

  it('rejects illegal backward or terminal transitions', () => {
    expect(() => assertAllowedPhaseTransition('QUOTED', 'AUTHORIZED')).not.toThrow();
    expect(() => assertAllowedPhaseTransition('SETTLED', 'SOURCE_CLOSED')).toThrow(
      'Illegal migration transition',
    );
    expect(() => assertAllowedPhaseTransition('COMPLETED', 'RECOVERY')).toThrow();
  });
});

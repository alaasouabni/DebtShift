import { describe, expect, it } from 'vitest';

import { evaluateRefinancingFeasibility } from './feasibility.js';

const EVALUATED_AT = '2026-11-09T12:00:00.000Z';
const EXPIRES_AT = '2026-11-09T12:10:00.000Z';
const MIGRATION_ID = `0x${'11'.repeat(32)}`;
const SOURCE_ASSET = {
  chainId: 8453,
  address: '0x1000000000000000000000000000000000000001',
  decimals: 6,
  symbol: 'USDC',
};
const SETTLEMENT_ASSET = {
  chainId: 42161,
  address: '0x2000000000000000000000000000000000000002',
  decimals: 6,
  symbol: 'USDC',
};

describe('refinancing financing feasibility', () => {
  it('accepts a fully reconciled route when every independently bounded capacity is sufficient', () => {
    const result = evaluateRefinancingFeasibility(baseInput());

    expect(result.eligible).toBe(true);
    expect(result).toMatchObject({
      sourceDebtPayoffUnits: '10000000000',
      solverPrincipalUnits: '10000000000',
      totalRequiredRepaymentAndFinancedCostUnits: '10000000000',
      maximumSafeBorrowingCapacityUnits: '11000000000',
      requiredDestinationBorrowUnits: '10000000000',
      fundingShortfallUnits: '0',
    });
  });

  it('rejects a 10,000 USDC payoff plus 100 USDC fee against only 10,000 USDC capacity', () => {
    const input = baseInput();
    input.solverFee.amountUnits = '100000000';
    input.capacities = equalCapacities('10000000000');

    const result = evaluateRefinancingFeasibility(input);

    expect(result.eligible).toBe(false);
    expect(result.requiredDestinationBorrowUnits).toBe('10100000000');
    expect(result.fundingShortfallUnits).toBe('100000000');
    expect(codes(result)).toEqual(
      expect.arrayContaining(['REQUIRED_BORROW_EXCEEDS_SAFE_CAPACITY', 'FUNDING_SHORTFALL']),
    );
  });

  it('accepts the same route when 100 USDC is finalized in migration-specific escrow', () => {
    const input = baseInput();
    input.migrationId = MIGRATION_ID;
    input.solverFee.amountUnits = '100000000';
    input.capacities = equalCapacities('10000000000');
    input.externalFunding = [externalFunding('100000000', 'FINALIZED')];

    const result = evaluateRefinancingFeasibility(input);

    expect(result.eligible).toBe(true);
    expect(result.confirmedExternalFundingUnits).toBe('100000000');
    expect(result.requiredDestinationBorrowUnits).toBe('10000000000');
    expect(result.fundingShortfallUnits).toBe('0');
  });

  it('accepts a capitalized solver fee only when capacity and signed debt cap cover 10,100 USDC', () => {
    const input = baseInput();
    input.solverFee.amountUnits = '100000000';
    input.capacities = equalCapacities('10100000000');

    const result = evaluateRefinancingFeasibility(input);

    expect(result.eligible).toBe(true);
    expect(result.solverFeeUnits).toBe('100000000');
    expect(result.requiredDestinationBorrowUnits).toBe('10100000000');
    expect(result.maximumSafeBorrowingCapacityUnits).toBe('10100000000');
  });

  it('reduces solver principal after finalized borrower debt prepayment without double-counting it', () => {
    const input = baseInput();
    input.solverFee.amountUnits = '100000000';
    input.capacities = equalCapacities('9600000000');
    input.borrowerDebtPrepayment = {
      asset: SOURCE_ASSET,
      amountUnits: '500000000',
      settlementAmountUnits: '500000000',
      conversion: conversion('500000000'),
      evidenceId: `0x${'55'.repeat(32)}`,
      verificationState: 'FINALIZED',
    };

    const result = evaluateRefinancingFeasibility(input);

    expect(result.eligible).toBe(true);
    expect(result.borrowerDebtPrepaymentUnits).toBe('500000000');
    expect(result.solverPrincipalUnits).toBe('9500000000');
    expect(result.confirmedExternalFundingUnits).toBe('0');
    expect(result.requiredDestinationBorrowUnits).toBe('9600000000');
  });

  it('uses reduced market liquidity as a hard capacity bound', () => {
    const input = baseInput();
    input.capacities.liquidityUnits = '9900000000';

    const result = evaluateRefinancingFeasibility(input);

    expect(result.maximumSafeBorrowingCapacityUnits).toBe('9900000000');
    expect(result.fundingShortfallUnits).toBe('100000000');
    expect(codes(result)).toContain('FUNDING_SHORTFALL');
  });

  it('rejects a solver fee above the borrower-signed fee cap even when borrowing capacity exists', () => {
    const input = baseInput();
    input.solverFee.amountUnits = '100000000';
    input.solverFee.signedCapUnits = '99999999';
    input.capacities = equalCapacities('10100000000');

    const result = evaluateRefinancingFeasibility(input);

    expect(result.eligible).toBe(false);
    expect(codes(result)).toContain('SOLVER_FEE_EXCEEDS_SIGNED_CAP');
    expect(result.fundingShortfallUnits).toBe('0');
  });

  it('does not count pending supplementary funding', () => {
    const input = baseInput();
    input.migrationId = MIGRATION_ID;
    input.solverFee.amountUnits = '100000000';
    input.capacities = equalCapacities('10000000000');
    input.externalFunding = [externalFunding('100000000', 'CONFIRMED')];

    const result = evaluateRefinancingFeasibility(input);

    expect(result.confirmedExternalFundingUnits).toBe('0');
    expect(result.externalFunding[0]).toMatchObject({
      counted: false,
      exclusionCodes: ['EXTERNAL_FUNDING_UNCONFIRMED'],
    });
    expect(result.fundingShortfallUnits).toBe('100000000');
    expect(codes(result)).toEqual(
      expect.arrayContaining(['EXTERNAL_FUNDING_UNCONFIRMED', 'FUNDING_SHORTFALL']),
    );
  });

  it('rejects duplicate cost identifiers and never counts the duplicate twice', () => {
    const input = baseInput();
    const cost = {
      componentId: 'solver-source-gas',
      kind: 'EXECUTION',
      financingClass: 'SOLVER_ADVANCED',
      asset: SETTLEMENT_ASSET,
      amountUnits: '50000000',
      settlementAmountUnits: '50000000',
    };
    input.costs = [cost, structuredClone(cost)];

    const result = evaluateRefinancingFeasibility(input);

    expect(result.eligible).toBe(false);
    expect(result.solverAdvancedCostUnits).toBe('50000000');
    expect(result.solverPrincipalUnits).toBe('10050000000');
    expect(result.components.map((component) => component.counted)).toEqual([true, false]);
    expect(codes(result)).toContain('DUPLICATE_FINANCING_COMPONENT');
  });

  it('takes the minimum of protocol, policy, liquidity, and signed capacity and reconciles cost classes', () => {
    const input = baseInput();
    input.capacities = {
      protocolUnits: '12000000000',
      policyUnits: '11000000000',
      liquidityUnits: '10500000000',
      signedUnits: '10750000000',
    };
    input.costs = [
      settlementCost('advanced', '10000000', 'SOLVER_ADVANCED'),
      settlementCost('capitalized', '20000000', 'CAPITALIZED'),
      settlementCost('separate', '30000000', 'SEPARATELY_PAID'),
    ];

    const result = evaluateRefinancingFeasibility(input);

    expect(result.eligible).toBe(true);
    expect(result.maximumSafeBorrowingCapacityUnits).toBe('10500000000');
    expect(result.solverAdvancedCostUnits).toBe('10000000');
    expect(result.capitalizedCostUnits).toBe('20000000');
    expect(result.separatelyPaidCostUnits).toBe('30000000');
    expect(result.totalRequiredRepaymentAndFinancedCostUnits).toBe('10030000000');
  });
});

function baseInput() {
  return {
    evaluatedAt: EVALUATED_AT,
    settlementAsset: SETTLEMENT_ASSET,
    sourcePayoff: {
      asset: SOURCE_ASSET,
      amountUnits: '10000000000',
      settlementAmountUnits: '10000000000',
      conversion: conversion('10000000000'),
    },
    costs: [] as Array<Record<string, unknown>>,
    solverFee: {
      asset: SETTLEMENT_ASSET,
      amountUnits: '0',
      signedCapUnits: '100000000',
    },
    externalFunding: [] as Array<Record<string, unknown>>,
    capacities: {
      protocolUnits: '12000000000',
      policyUnits: '11000000000',
      liquidityUnits: '13000000000',
      signedUnits: '14000000000',
    },
    migrationId: undefined as string | undefined,
    borrowerDebtPrepayment: undefined as Record<string, unknown> | undefined,
  };
}

function conversion(amountUnits: string) {
  return {
    quoteHash: `0x${'33'.repeat(32)}`,
    provider: 'deterministic-test-conversion',
    inputAsset: SOURCE_ASSET,
    outputAsset: SETTLEMENT_ASSET,
    amountInUnits: amountUnits,
    amountOutUnits: amountUnits,
    expiresAt: EXPIRES_AT,
  };
}

function externalFunding(amountUnits: string, verificationState: 'CONFIRMED' | 'FINALIZED') {
  return {
    fundingId: 'borrower-fee-escrow',
    migrationId: MIGRATION_ID,
    evidenceId: `0x${'44'.repeat(32)}`,
    asset: SETTLEMENT_ASSET,
    amountUnits,
    escrow: '0x3000000000000000000000000000000000000003',
    refundReceiver: '0x4000000000000000000000000000000000000004',
    authorizedUse: 'solver-settlement',
    verificationState,
    expiresAt: EXPIRES_AT,
  };
}

function equalCapacities(amountUnits: string) {
  return {
    protocolUnits: amountUnits,
    policyUnits: amountUnits,
    liquidityUnits: amountUnits,
    signedUnits: amountUnits,
  };
}

function settlementCost(
  componentId: string,
  amountUnits: string,
  financingClass: 'SOLVER_ADVANCED' | 'CAPITALIZED' | 'SEPARATELY_PAID',
) {
  return {
    componentId,
    kind: 'EXECUTION',
    financingClass,
    asset: SETTLEMENT_ASSET,
    amountUnits,
    settlementAmountUnits: amountUnits,
  };
}

function codes(result: ReturnType<typeof evaluateRefinancingFeasibility>) {
  return result.rejections.map((rejection) => rejection.code);
}

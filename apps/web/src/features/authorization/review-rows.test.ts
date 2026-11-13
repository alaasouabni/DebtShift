import { describe, expect, it } from 'vitest';

import type { PreparedMigration } from '../../lib/api/types';
import fixture from '../../lib/demo/recordings/prepare.json' with { type: 'json' };
import { allReviewRows, intentRows, planRows } from './review-rows';

/*
 * The fixture is a REAL `POST /v1/migrations/prepare` response, captured from
 * the local simulator stack. Not a hand-written mock: a hand-written mock would
 * only prove the code agrees with my idea of the contract, which is the thing
 * most likely to be wrong.
 *
 * `routeAnalysis` was removed from it because these rows do not consume it.
 */
const prepared = fixture as unknown as PreparedMigration;

/**
 * The fields the frontend contract requires on screen before signature 1.
 * Taken from `strategies-docs/13-frontend-handoff.md`, "Signing".
 */
const REQUIRED_INTENT_FIELDS = [
  'intent.borrower',
  'intent.accountType',
  'intent.sourcePosition',
  'intent.allowedTargets',
  'intent.feeAsset',
  'intent.maxSourceDebtUnits',
  'intent.minSourceCollateralUnits',
  'intent.maxTotalFeeUnits',
  'intent.maxSlippageBps',
  'intent.minAprReductionBps',
  'intent.safetyPolicy',
  'intent.maxDurationSeconds',
  'intent.expiration',
  'intent.nonce',
  'intentHash',
  'verifyingContract',
] as const;

/** The fields required before signature 2. */
const REQUIRED_PLAN_FIELDS = [
  'plan.intentHash',
  'plan.migrationId',
  'plan.routeHash',
  'plan.nonce',
  'plan.sourceMarket',
  'plan.targetMarket',
  'plan.sourceDebtAsset',
  'plan.sourceCollateralAsset',
  'plan.destinationDebtAsset',
  'plan.destinationCollateralAsset',
  'plan.sourceRepaymentMaxUnits',
  'plan.sourceCollateralMinUnits',
  'plan.targetDebtMaxUnits',
  'plan.minDestinationCollateralUnits',
  'plan.principalMaxUnits',
  'plan.feeMaxUnits',
  'plan.fundingProvider',
  'plan.payoutAsset',
  'plan.payoutReceiver',
  'plan.financing.solverPrincipalUnits',
  'plan.financing.solverFeeUnits',
  'plan.financing.capitalizedCostUnits',
  'plan.financing.separatelyPaidCostUnits',
  'plan.financing.borrowerDebtPrepaymentUnits',
  'plan.financing.totalRequiredRepaymentAndFinancedCostUnits',
  'plan.financing.requiredDestinationBorrowUnits',
  'plan.financing.maximumSafeBorrowingCapacityUnits',
  'plan.financing.fundingShortfallUnits',
  'plan.transportProvider',
  'plan.transportQuoteHash',
  'plan.transportDepositAddress',
  'quote.amountInUnits',
  'quote.expectedAmountOutUnits',
  'quote.minAmountOutUnits',
  'quote.fees',
  'quote.expiresAt',
  'plan.destinationReceiver',
  'plan.refundReceiver',
  'plan.reservationHash',
  'plan.deadline',
  'plan.financing.validUntil',
  'planHash',
] as const;

describe('the fixture is a real prepared migration', () => {
  it('is the sandbox, with its transport explicitly marked simulated', () => {
    expect(prepared.execution?.mode).toBe('sandbox');
    expect(prepared.execution?.transportProvider).toBe('DEBTSHIFT_SIMULATOR');
    expect(prepared.execution?.transportMode).toBe('SIMULATED');
    expect(prepared.execution?.simulatedTransport).toBe(true);
    expect(prepared.execution?.warning).toMatch(/simulated external transport provider/i);
  });

  it('needs no lending permission, as the sandbox markets ask for none', () => {
    expect(prepared.sourceAuthorization).toEqual({ kind: 'NONE' });
    expect(prepared.targetAuthorization).toEqual({ kind: 'NONE' });
  });

  it('carries a zero funding shortfall, as an executable plan must', () => {
    expect(prepared.plan.financing.fundingShortfallUnits).toBe('0');
  });

  it('has a stressed safety limit at least as tight as the normal one', () => {
    // The signing schema enforces this. A design that shows the stressed limit
    // as LOOSER is showing something the backend would reject.
    const policy = prepared.intent.safetyPolicy;
    if (policy.kind === 'MAX_LTV_BPS') {
      expect(policy.stressMaximumLtvBps).toBeLessThanOrEqual(policy.maximumLtvBps);
    } else {
      expect(BigInt(policy.stressMinimumWad)).toBeGreaterThanOrEqual(BigInt(policy.minimumWad));
    }
  });
});

describe('intent review coverage', () => {
  const rows = intentRows(prepared.intent, prepared.verifyingContract, prepared.intentHash);
  const keys = rows.map((row) => row.key);

  it.each(REQUIRED_INTENT_FIELDS)('shows %s before the first signature', (field) => {
    expect(keys).toContain(field);
  });

  it('shows every allowed target, never a truncated list', () => {
    const row = rows.find((entry) => entry.key === 'intent.allowedTargets');
    expect(row?.label).toContain(String(prepared.intent.allowedTargets.length));
    for (const target of prepared.intent.allowedTargets) {
      expect(row?.raw).toContain(target.marketId);
    }
  });

  it('gives every row a label and a value', () => {
    for (const row of rows) {
      expect(row.label, row.key).not.toBe('');
      expect(row.value, row.key).toBeDefined();
    }
  });

  it('prints the exact signed amount in the raw line, not only the formatted one', () => {
    const row = rows.find((entry) => entry.key === 'intent.maxSourceDebtUnits');
    expect(row?.raw).toContain(prepared.intent.maxSourceDebtUnits);
  });

  it('has no duplicate keys', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('plan review coverage', () => {
  const rows = planRows(prepared.plan, prepared.quote, prepared.planHash);
  const keys = rows.map((row) => row.key);

  it.each(REQUIRED_PLAN_FIELDS)('shows %s before the second signature', (field) => {
    expect(keys).toContain(field);
  });

  it('marks a zero funding shortfall as the success it is', () => {
    const row = rows.find((entry) => entry.key === 'plan.financing.fundingShortfallUnits');
    expect(row?.tone).toBe('success');
  });

  it('would mark a non-zero funding shortfall as a danger', () => {
    const broken = {
      ...prepared.plan,
      financing: { ...prepared.plan.financing, fundingShortfallUnits: '1' },
    };
    const row = planRows(broken, prepared.quote, prepared.planHash).find(
      (entry) => entry.key === 'plan.financing.fundingShortfallUnits',
    );
    expect(row?.tone).toBe('danger');
  });

  it('never calls the simulator a 1Click transaction', () => {
    const row = rows.find((entry) => entry.key === 'plan.transportProvider');
    expect(String(row?.value)).toContain('simulator');
    expect(String(row?.value)).not.toContain('1Click');
  });

  it('names the refund path in plain words', () => {
    // Signed since plan version 2: where the transport returns value if
    // the crossing fails.
    const row = rows.find((entry) => entry.key === 'plan.transportRefundReceiver');
    expect(row?.label.toLowerCase()).toContain('refund');
    expect(row?.label.toLowerCase()).toContain('fails');
    expect(row?.raw).toBe(`transportRefundReceiver ${prepared.plan.transportRefundReceiver}`);
  });

  it('keeps the two refund receivers apart', () => {
    const finalRow = rows.find((entry) => entry.key === 'plan.refundReceiver');
    expect(finalRow?.label).toBe('Final refund receiver');
    expect(finalRow?.raw).toBe(`refundReceiver ${prepared.plan.refundReceiver}`);
  });

  it('does not invent the transport refund row for a plan signed before it existed', () => {
    const { transportRefundReceiver: _newer, ...older } = prepared.plan;
    const olderRows = planRows(older, prepared.quote, prepared.planHash);
    expect(olderRows.some((entry) => entry.key === 'plan.transportRefundReceiver')).toBe(false);
    expect(olderRows).toHaveLength(rows.length - 1);
  });

  it('prints exact base-unit amounts in the raw lines', () => {
    const amounts: [string, string][] = [
      ['plan.targetDebtMaxUnits', prepared.plan.targetDebtMaxUnits],
      ['plan.sourceRepaymentMaxUnits', prepared.plan.sourceRepaymentMaxUnits],
      ['plan.financing.solverFeeUnits', prepared.plan.financing.solverFeeUnits],
    ];
    for (const [key, value] of amounts) {
      expect(rows.find((entry) => entry.key === key)?.raw, key).toContain(value);
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('allReviewRows', () => {
  it('returns both lists for a prepared migration', () => {
    const { intent, plan } = allReviewRows(prepared);
    expect(intent.length).toBeGreaterThanOrEqual(REQUIRED_INTENT_FIELDS.length);
    expect(plan.length).toBeGreaterThanOrEqual(REQUIRED_PLAN_FIELDS.length);
  });
});

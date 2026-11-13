import { describe, expect, it } from 'vitest';

import { recoveryOpeningPayloadSchema } from './migration.js';

const residualAssets = [
  {
    kind: 'SOLVER_RECEIVABLE',
    amountUnits: '100',
    disposition: 'UNSETTLED_EXPLICIT_CLAIM',
  },
];

describe('recovery opening policy', () => {
  it('accepts an executable automatic recovery with explicit responsibility', () => {
    expect(
      recoveryOpeningPayloadSchema.parse({
        reason: 'VERIFIED_REFUND',
        policy: 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
        requiresManualReview: false,
        nextPermittedAction: 'EXECUTE_SIGNED_RECOVERY',
        actionDeadline: '2026-11-13T08:00:00.000Z',
        escalationOwner: 'DEBTSHIFT_WORKER',
        escalationState: 'AUTOMATED_RECOVERY_PENDING',
        residualAssets,
        providerReference: 'quote-1',
      }),
    ).toMatchObject({ escalationState: 'AUTOMATED_RECOVERY_PENDING' });
  });

  it('accepts a manual reconciliation policy that cannot schedule financial execution', () => {
    expect(
      recoveryOpeningPayloadSchema.parse({
        reason: 'TRANSPORT_RETRY_BUDGET_EXHAUSTED',
        policy: 'MANUAL_CUSTODY_RECONCILIATION',
        requiresManualReview: true,
        nextPermittedAction: 'RECONCILE_TRANSPORT_CUSTODY',
        actionDeadline: '2026-11-13T08:00:00.000Z',
        escalationOwner: 'DEBTSHIFT_OPERATIONS',
        escalationState: 'MANUAL_REVIEW_REQUIRED',
        residualAssets,
      }),
    ).toMatchObject({ escalationState: 'MANUAL_REVIEW_REQUIRED' });
  });

  it('rejects contradictory review and execution states', () => {
    expect(() =>
      recoveryOpeningPayloadSchema.parse({
        reason: 'UNKNOWN_CUSTODY',
        policy: 'MANUAL_CUSTODY_RECONCILIATION',
        requiresManualReview: true,
        nextPermittedAction: 'EXECUTE_SIGNED_RECOVERY',
        actionDeadline: '2026-11-13T08:00:00.000Z',
        escalationOwner: 'DEBTSHIFT_OPERATIONS',
        escalationState: 'MANUAL_REVIEW_REQUIRED',
        residualAssets,
      }),
    ).toThrow('Only an automated recovery');
  });

  it('requires an explicit residual custody or receivable record', () => {
    expect(() =>
      recoveryOpeningPayloadSchema.parse({
        reason: 'UNKNOWN_CUSTODY',
        policy: 'MANUAL_CUSTODY_RECONCILIATION',
        requiresManualReview: true,
        nextPermittedAction: 'RECONCILE_TRANSPORT_CUSTODY',
        actionDeadline: '2026-11-13T08:00:00.000Z',
        escalationOwner: 'DEBTSHIFT_OPERATIONS',
        escalationState: 'MANUAL_REVIEW_REQUIRED',
        residualAssets: [],
      }),
    ).toThrow();
  });
});

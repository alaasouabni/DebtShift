import {
  commandStatusSchema,
  commandTypeSchema,
  evidenceTypeSchema,
  evidenceVerificationStateSchema,
  executionFinancingClassSchema,
  executionFinancingCostKindSchema,
  migrationPhaseSchema,
} from '@debtshift/domain';
import { describe, expect, it } from 'vitest';

import {
  allStale,
  anyStale,
  COMMAND_STATUS_LABELS,
  COMMAND_TYPE_LABELS,
  EVIDENCE_TYPE_LABELS,
  FINANCING_CLASS_LABELS,
  FINANCING_COST_KIND_LABELS,
  LEDGER_CATEGORY_LABELS,
  PHASE_LABELS,
  REJECTION_COPY,
  rejectionCopy,
  VERIFICATION_STATE_LABELS,
} from './index';

/*
 * These tests drive off the backend's own Zod enums, so adding a phase, an
 * evidence type or a command status on the backend fails the frontend build
 * until someone writes the copy. That is the point: a raw enum must never
 * reach a borrower's screen.
 */

describe('label coverage against the backend enums', () => {
  it('covers every migration phase', () => {
    expect(Object.keys(PHASE_LABELS).sort()).toEqual([...migrationPhaseSchema.options].sort());
  });

  it('covers every command type', () => {
    expect(Object.keys(COMMAND_TYPE_LABELS).sort()).toEqual([...commandTypeSchema.options].sort());
  });

  it('covers every command status', () => {
    expect(Object.keys(COMMAND_STATUS_LABELS).sort()).toEqual(
      [...commandStatusSchema.options].sort(),
    );
  });

  it('covers every evidence type', () => {
    expect(Object.keys(EVIDENCE_TYPE_LABELS).sort()).toEqual(
      [...evidenceTypeSchema.options].sort(),
    );
  });

  it('covers every evidence verification state', () => {
    expect(Object.keys(VERIFICATION_STATE_LABELS).sort()).toEqual(
      [...evidenceVerificationStateSchema.options].sort(),
    );
  });

  it('covers every financing class', () => {
    expect(Object.keys(FINANCING_CLASS_LABELS).sort()).toEqual(
      [...executionFinancingClassSchema.options].sort(),
    );
  });

  it('covers every financing cost kind', () => {
    expect(Object.keys(FINANCING_COST_KIND_LABELS).sort()).toEqual(
      [...executionFinancingCostKindSchema.options].sort(),
    );
  });

  it('covers every ledger category', () => {
    // Inline in `ledgerEntrySchema`, so the list is mirrored here on purpose.
    expect(Object.keys(LEDGER_CATEGORY_LABELS).sort()).toEqual(
      ['COLLATERAL', 'FEE', 'PRINCIPAL', 'REFUND', 'RESIDUAL', 'SHORTFALL'].sort(),
    );
  });

  it('covers all 28 rejection codes', () => {
    // 14 route-risk codes from packages/optimizer/src/models.ts plus 14
    // feasibility codes from packages/optimizer/src/feasibility.ts.
    const routeRisk = [
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
    ];
    const feasibility = [
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
    ];
    expect(routeRisk).toHaveLength(14);
    expect(feasibility).toHaveLength(14);
    expect(Object.keys(REJECTION_COPY).sort()).toEqual([...routeRisk, ...feasibility].sort());
  });

  it('gives every label non-empty copy', () => {
    for (const [phase, entry] of Object.entries(PHASE_LABELS)) {
      expect(entry.label, phase).not.toBe('');
      expect(entry.caption, phase).not.toBe('');
    }
    for (const [code, entry] of Object.entries(REJECTION_COPY)) {
      expect(entry.text, code).not.toBe('');
    }
  });
});

describe('phase copy that carries the product', () => {
  it('does not present SETTLED as finished', () => {
    expect(PHASE_LABELS.SETTLED.caption).toContain('not the end');
    expect(PHASE_LABELS.SETTLED.tone).not.toBe('success');
  });

  it('marks COMPLETED as the only success tone among terminal phases', () => {
    expect(PHASE_LABELS.COMPLETED.tone).toBe('success');
    expect(PHASE_LABELS.FAILED_SAFE.tone).not.toBe('success');
    expect(PHASE_LABELS.EXPIRED.tone).not.toBe('success');
  });

  it('states plainly that FAILED_SAFE does not mean the solver was repaid', () => {
    expect(PHASE_LABELS.FAILED_SAFE.caption).toContain('does not mean the solver was repaid');
  });

  it('does not present RECOVERY as finished', () => {
    expect(PHASE_LABELS.RECOVERY.caption).toContain('Not finished');
  });
});

describe('rejectionCopy', () => {
  it('returns the written copy for a known code', () => {
    expect(rejectionCopy('FUNDING_SHORTFALL').text).toBe(
      'Available funding does not cover the full amount required.',
    );
  });

  it('falls back to the backend message for an unknown code rather than hiding it', () => {
    const copy = rejectionCopy('SOME_NEW_BACKEND_CODE', 'The backend explained it like this.');
    expect(copy.text).toBe('The backend explained it like this.');
  });

  it('still says something when an unknown code arrives with no message', () => {
    expect(rejectionCopy('SOME_NEW_BACKEND_CODE').text).toContain('SOME_NEW_BACKEND_CODE');
  });
});

describe('staleness helpers', () => {
  it('recognises the live stack rejection set as entirely stale', () => {
    // What the API returns once Anvil has idled: a refresh fixes all three.
    expect(allStale(['SOURCE_POSITION_STALE', 'MARKET_SNAPSHOT_STALE', 'ORACLE_STALE'])).toBe(true);
  });

  it('does not call a capacity rejection stale', () => {
    // The real low-liquidity route rejection: refreshing changes nothing.
    const codes = [
      'REQUIRED_BORROW_EXCEEDS_SAFE_CAPACITY',
      'FUNDING_SHORTFALL',
      'INSUFFICIENT_BORROW_LIQUIDITY',
    ];
    expect(allStale(codes)).toBe(false);
    expect(anyStale(codes)).toBe(false);
  });

  it('reports a mixed set as partly stale but not entirely', () => {
    const codes = ['ORACLE_STALE', 'FUNDING_SHORTFALL'];
    expect(anyStale(codes)).toBe(true);
    expect(allStale(codes)).toBe(false);
  });

  it('treats an empty list as not stale', () => {
    expect(allStale([])).toBe(false);
  });
});

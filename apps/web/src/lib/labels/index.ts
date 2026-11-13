/*
 * User-facing copy for every backend enum.
 *
 * The rule: a backend code is never rendered raw as the primary text. It is
 * rendered next to its human sentence, in monospace, so the user reads English
 * and a developer can still grep the code. `labels.test.ts` fails if the
 * backend gains a value this file does not cover.
 */

import type {
  CommandStatus,
  CommandType,
  EvidenceType,
  EvidenceVerificationState,
  FinancingClass,
  FinancingCostKind,
  LedgerCategory,
  MigrationPhase,
} from '../api/types';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface PhaseLabel {
  readonly label: string;
  readonly caption: string;
  readonly tone: Tone;
}

/**
 * The thirteen phases.
 *
 * Two captions carry the whole product's honesty and must not be softened:
 * `SETTLED` is not completion, and `FAILED_SAFE` does not mean the solver was
 * repaid — it means custody and residual claims are known.
 */
export const PHASE_LABELS: Record<MigrationPhase, PhaseLabel> = {
  DRAFT: {
    label: 'Draft',
    caption: 'The migration record exists. Nothing is authorized yet.',
    tone: 'neutral',
  },
  QUOTED: {
    label: 'Quoted',
    caption: 'Exact terms and a transport quote are bound to this migration.',
    tone: 'neutral',
  },
  AUTHORIZED: {
    label: 'Authorized',
    caption: 'Both of your signatures are verified.',
    tone: 'accent',
  },
  RESERVED: {
    label: 'Liquidity reserved',
    caption: 'Destination borrowing capacity is held for this migration.',
    tone: 'accent',
  },
  SOURCE_CLOSED: {
    label: 'Old loan closed',
    caption: 'Your source debt is repaid and the collateral released.',
    tone: 'accent',
  },
  ROUTING: {
    label: 'Funds in transit',
    caption: 'Value is moving to the destination chain.',
    tone: 'accent',
  },
  DEST_FUNDED: {
    label: 'Funds arrived',
    caption: 'Arrival on the destination chain is verified.',
    tone: 'accent',
  },
  TARGET_OPEN: {
    label: 'New loan open',
    caption: 'Your new position exists on the destination market.',
    tone: 'accent',
  },
  SETTLED: {
    label: 'Solver repaid',
    caption:
      'The solver is repaid and the money side is final. The record on NEAR is still pending — this is not the end.',
    tone: 'warning',
  },
  COMPLETED: {
    label: 'Complete',
    caption: 'The refinance is finished, reconciled and recorded on NEAR.',
    tone: 'success',
  },
  RECOVERY: {
    label: 'Recovery in progress',
    caption:
      'Something went wrong. Funds are being returned along the signed refund path. Not finished.',
    tone: 'warning',
  },
  FAILED_SAFE: {
    label: 'Stopped safely',
    caption:
      'The migration did not complete. Custody and residual claims are known and recorded. This does not mean the solver was repaid.',
    tone: 'warning',
  },
  REQUOTE_REQUIRED: {
    label: 'New plan required',
    caption:
      'Market capacity changed before anything moved. The reservation was released and your source position is unchanged. Nothing entered recovery — review and sign a fresh plan.',
    tone: 'warning',
  },
  EXPIRED: {
    label: 'Expired',
    caption: 'The authorized window closed before completion.',
    tone: 'neutral',
  },
};

export const COMMAND_TYPE_LABELS: Record<CommandType, string> = {
  RESERVE_LIQUIDITY: 'Reserve destination liquidity',
  CLOSE_SOURCE: 'Close the source position',
  DISPATCH_TRANSPORT: 'Dispatch cross-chain transport',
  VERIFY_DESTINATION: 'Verify destination arrival',
  OPEN_TARGET: 'Open the destination position',
  SETTLE_LIQUIDITY: 'Settle with the solver',
  FINALIZE_NEAR_RECEIPT: 'Finalize the NEAR receipt',
  EXECUTE_RECOVERY: 'Execute recovery',
};

export interface StatusLabel {
  readonly label: string;
  readonly tone: Tone;
  readonly caption?: string;
}

export const COMMAND_STATUS_LABELS: Record<CommandStatus, StatusLabel> = {
  PENDING: { label: 'Pending', tone: 'neutral' },
  DISPATCHED: { label: 'Dispatched', tone: 'neutral' },
  RUNNING: { label: 'Running', tone: 'accent' },
  SUCCEEDED: { label: 'Succeeded', tone: 'success' },
  FAILED_RETRYABLE: {
    label: 'Retrying',
    tone: 'warning',
    caption: 'This attempt failed and the workflow owns the retry. No action from you.',
  },
  FAILED_TERMINAL: {
    label: 'Failed',
    tone: 'danger',
    caption: 'This command will not be retried.',
  },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  SOURCE_POSITION_SNAPSHOT: 'Source position observed',
  ROUTE_QUOTE: 'Transport quote bound',
  INTENT_AUTHORIZATION: 'Policy signature verified',
  EXECUTION_PLAN_AUTHORIZATION: 'Execution signature verified',
  SOURCE_LENDING_AUTHORIZATION: 'Source lending permission verified',
  FINANCING_FEASIBILITY: 'Financing feasibility proven',
  FINANCING_REVALIDATION: 'Financing revalidated before reservation',
  SUPPLEMENTARY_FUNDING: 'Supplementary funding confirmed',
  LIQUIDITY_RESERVATION: 'Destination liquidity reserved',
  SOURCE_CLOSE: 'Source position closed',
  TRANSPORT_ORIGIN: 'Transport sent from the source chain',
  TRANSPORT_DESTINATION: 'Transport arrived on the destination chain',
  TARGET_POSITION: 'Destination position opened',
  LIQUIDITY_SETTLEMENT: 'Solver settled',
  LEDGER_RECONCILIATION: 'Ledger reconciled',
  NEAR_RECEIPT: 'NEAR receipt finalized',
  MIGRATION_EXPIRED: 'Authorization window expired',
  REQUOTE_REQUIRED: 'Feasibility failed before source close — requote required',
  RECOVERY_OPENED: 'Recovery opened',
  RECOVERY_COMPLETED: 'Recovery completed',
};

export const VERIFICATION_STATE_LABELS: Record<EvidenceVerificationState, StatusLabel> = {
  PROVISIONAL: { label: 'Provisional', tone: 'neutral', caption: 'Seen, not yet confirmed.' },
  CONFIRMED: { label: 'Confirmed', tone: 'accent', caption: 'Confirmed on chain.' },
  FINALIZED: { label: 'Finalized', tone: 'success', caption: 'Final.' },
  RETRACTED: {
    label: 'Retracted',
    tone: 'warning',
    caption: 'Withdrawn — a reorg or a correction removed this observation.',
  },
  REJECTED: { label: 'Rejected', tone: 'danger', caption: 'Rejected by verification.' },
};

export const LEDGER_CATEGORY_LABELS: Record<LedgerCategory, string> = {
  PRINCIPAL: 'Principal',
  FEE: 'Fee',
  COST: 'Cost',
  COLLATERAL: 'Collateral',
  RESERVE: 'Reserve',
  REFUND: 'Refund',
  RESIDUAL: 'Residual',
  SHORTFALL: 'Shortfall',
};

/*
 * What a ledger entry is, in words. An unknown code is shown as the backend
 * sent it rather than dropped: a ledger line with no description would hide
 * where value went.
 */
export const LEDGER_COMPONENT_LABELS: Record<string, string> = {
  SOURCE_DEBT_PAYOFF: 'Old debt paid off',
  BORROWER_DEBT_PREPAYMENT: 'Your own prepayment',
  SEPARATELY_PAID_COST_CLASSIFICATION: 'Cost paid separately',
  RECOVERY_RESERVE_LOCKED: 'Recovery reserve locked',
  TRANSPORT_ORIGIN_COLLATERAL: 'Collateral sent into transport',
  TRANSPORT_DESTINATION_COLLATERAL: 'Collateral delivered by transport',
  TARGET_COLLATERAL_SUPPLY: 'Collateral supplied to the new market',
  DESTINATION_LOAN_PROCEEDS: 'New loan proceeds',
  SUPPLEMENTARY_SETTLEMENT_FUNDING: 'Supplementary funding',
  SOLVER_PRINCIPAL_PAYOUT: 'Solver principal repaid',
  SOLVER_FEE_PAYOUT: 'Solver fee paid',
  CAPITALIZED_COST_PAYOUT: 'Cost added to the new loan, paid out',
  RESIDUAL_RETURN: 'Residual returned',
  RECOVERY_RESERVE_PRINCIPAL_CONSUMED: 'Recovery reserve used for principal',
  RECOVERY_RESERVE_FEE_CONSUMED: 'Recovery reserve used for fee',
  RECOVERY_RESERVE_REFUND: 'Recovery reserve refunded',
};

export function ledgerComponentLabel(code: string | null | undefined): string | undefined {
  if (code === null || code === undefined || code === '') return undefined;
  return LEDGER_COMPONENT_LABELS[code] ?? code;
}

export const FINANCING_CLASS_LABELS: Record<FinancingClass, { label: string; caption: string }> = {
  SOLVER_ADVANCED: {
    label: 'Advanced by the solver',
    caption: 'Paid up front by the solver and repaid out of the new loan.',
  },
  CAPITALIZED: {
    label: 'Added to the new loan',
    caption: 'Rolled into the destination debt rather than paid now.',
  },
  SEPARATELY_PAID: {
    label: 'Paid separately',
    caption: 'Settled outside the financed amount.',
  },
};

export const FINANCING_COST_KIND_LABELS: Record<FinancingCostKind, string> = {
  TRANSPORT: 'Cross-chain transport',
  PROTOCOL: 'Protocol fee',
  EXECUTION: 'Execution',
  NETWORK: 'Network gas',
  SLIPPAGE: 'Slippage allowance',
  OTHER: 'Other',
};

/**
 * Rejection copy.
 *
 * Fourteen route-risk codes and fourteen financing-feasibility codes, taken
 * from `packages/optimizer`. `remedy` is the action the user can actually take;
 * `stale` marks the three codes that a data refresh fixes.
 */
export interface RejectionCopy {
  readonly text: string;
  readonly remedy?: string;
  readonly stale?: boolean;
}

export const REJECTION_COPY: Record<string, RejectionCopy> = {
  /* route risk */
  ADAPTER_VERSION_UNAPPROVED: {
    text: "This market's adapter version is not approved yet.",
  },
  APR_REDUCTION_BELOW_MINIMUM: {
    text: 'The rate saving is smaller than the policy minimum.',
  },
  COST_ABOVE_MAXIMUM: {
    text: 'Total cost is above the maximum the policy allows.',
  },
  INSUFFICIENT_BORROW_LIQUIDITY: {
    text: 'The destination market does not have enough borrowable liquidity.',
  },
  MARKET_RISK_LIMIT_MISSING: {
    text: 'This market does not publish the risk limit needed to size the position.',
  },
  MARKET_SNAPSHOT_STALE: {
    text: 'Destination market data is too old to act on.',
    remedy: 'Refresh the data and compare again.',
    stale: true,
  },
  NEGATIVE_NET_BENEFIT: {
    text: 'After all costs, this route would cost more than it saves.',
  },
  ORACLE_STALE: {
    text: 'The price oracle has not updated recently enough.',
    remedy: 'Refresh the data and compare again.',
    stale: true,
  },
  ROUTE_UNSUPPORTED: {
    text: 'This asset pair is not supported on this route.',
  },
  SOURCE_POSITION_STALE: {
    text: 'Your current position data is too old to act on.',
    remedy: 'Refresh the data and compare again.',
    stale: true,
  },
  TRANSPORT_MINIMUM_NOT_MET: {
    text: "The amount is below the transport provider's minimum.",
  },
  UNSAFE_POST_STATE: {
    text: 'The resulting position would breach the safety limit.',
  },
  UNSAFE_STRESS_STATE: {
    text: 'The position would breach the safety limit under the stress scenario.',
  },
  REQUESTED_BORROW_MISMATCH: {
    text: 'The requested borrow does not match the reconciled financing amount.',
  },

  /* financing feasibility */
  BORROWER_PREPAYMENT_ASSET_MISMATCH: {
    text: 'Your prepayment is in a different asset than the settlement asset.',
  },
  BORROWER_PREPAYMENT_EXCEEDS_SOURCE_DEBT: {
    text: 'The prepayment is larger than the debt being repaid.',
  },
  BORROWER_PREPAYMENT_UNCONFIRMED: {
    text: 'Your prepayment has no finalized on-chain evidence yet.',
  },
  COST_CONVERSION_INVALID: {
    text: 'A cost in another asset has no valid signed conversion.',
  },
  DUPLICATE_FINANCING_COMPONENT: {
    text: 'The same cost appears twice in the financing structure.',
  },
  EXTERNAL_FUNDING_ASSET_MISMATCH: {
    text: 'External funding is not in the settlement asset.',
  },
  EXTERNAL_FUNDING_EXPIRED: {
    text: 'External funding expires before the end of the authorized window.',
  },
  EXTERNAL_FUNDING_NOT_MIGRATION_BOUND: {
    text: 'External funding is not bound to this migration.',
  },
  EXTERNAL_FUNDING_UNCONFIRMED: {
    text: 'External funding is not finalized.',
  },
  FUNDING_SHORTFALL: {
    text: 'Available funding does not cover the full amount required.',
  },
  REQUIRED_BORROW_EXCEEDS_SAFE_CAPACITY: {
    text: 'The borrow needed exceeds the safe capacity of the destination market.',
  },
  SOLVER_FEE_ASSET_MISMATCH: {
    text: 'The solver fee is not in the settlement asset.',
  },
  SOLVER_FEE_EXCEEDS_SIGNED_CAP: {
    text: 'The solver fee is above the cap you signed.',
  },
  SOURCE_PAYOFF_CONVERSION_INVALID: {
    text: 'Repaying the source debt needs a signed conversion that is not valid.',
  },
};

/**
 * Copy for a rejection code.
 *
 * An unknown code falls back to the backend's own message rather than to
 * silence: hiding a rejection reason is one of the forbidden behaviours.
 */
export function rejectionCopy(code: string, backendMessage?: string): RejectionCopy {
  return (
    REJECTION_COPY[code] ?? {
      text: backendMessage?.trim() ?? `The backend rejected this route with code ${code}.`,
    }
  );
}

/** True when every rejection in the list is a freshness problem a refresh fixes. */
export function allStale(codes: readonly string[]): boolean {
  return codes.length > 0 && codes.every((code) => REJECTION_COPY[code]?.stale === true);
}

/** True when any rejection in the list is a freshness problem. */
export function anyStale(codes: readonly string[]): boolean {
  return codes.some((code) => REJECTION_COPY[code]?.stale === true);
}

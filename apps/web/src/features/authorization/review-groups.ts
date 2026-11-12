/*
 * How the signed fields are laid out for reading.
 *
 * A policy has 16 signed fields and an execution plan has 42. Shown as one
 * list, the ones a borrower most needs to check are lost among hashes. Here
 * they are sorted into named groups, and a handful are repeated at the top as
 * "at a glance".
 *
 * Two rules hold whatever this file says:
 *  - no row is ever dropped. A field this file does not know lands in a group
 *    of its own, so a new signed field cannot go unshown;
 *  - nothing is re-derived. Groups and the glance reuse the very row objects
 *    the full list shows, so the two cannot disagree.
 */

import type { ReviewRow } from './review-rows';

export interface ReviewGroup {
  readonly title: string;
  readonly rows: readonly ReviewRow[];
}

type GroupSpec = readonly [title: string, keys: readonly string[]];

export const UNGROUPED_TITLE = 'Other signed fields';

const POLICY_GROUPS: readonly GroupSpec[] = [
  [
    'Who and where',
    ['intent.borrower', 'intent.accountType', 'intent.sourcePosition', 'intent.allowedTargets'],
  ],
  [
    'Your limits',
    [
      'intent.maxSourceDebtUnits',
      'intent.minSourceCollateralUnits',
      'intent.maxTotalFeeUnits',
      'intent.feeAsset',
      'intent.maxSlippageBps',
      'intent.minAprReductionBps',
      'intent.safetyPolicy',
    ],
  ],
  ['Time and replay', ['intent.maxDurationSeconds', 'intent.expiration', 'intent.nonce']],
  ['What your wallet signs', ['intentHash', 'verifyingContract']],
];

const PLAN_GROUPS: readonly GroupSpec[] = [
  ['Tied to your policy', ['plan.intentHash', 'plan.migrationId', 'plan.routeHash', 'plan.nonce']],
  [
    'Markets and assets',
    [
      'plan.sourceMarket',
      'plan.targetMarket',
      'plan.sourceDebtAsset',
      'plan.sourceCollateralAsset',
      'plan.destinationDebtAsset',
      'plan.destinationCollateralAsset',
    ],
  ],
  [
    'Amount caps',
    [
      'plan.sourceRepaymentMaxUnits',
      'plan.sourceCollateralMinUnits',
      'plan.targetDebtMaxUnits',
      'plan.minDestinationCollateralUnits',
    ],
  ],
  [
    'Solver',
    [
      'plan.principalMaxUnits',
      'plan.feeMaxUnits',
      'plan.fundingProvider',
      'plan.payoutAsset',
      'plan.payoutReceiver',
    ],
  ],
  [
    'Financing',
    [
      'plan.financing.solverPrincipalUnits',
      'plan.financing.solverFeeUnits',
      'plan.financing.capitalizedCostUnits',
      'plan.financing.separatelyPaidCostUnits',
      'plan.financing.borrowerDebtPrepaymentUnits',
      'plan.financing.totalRequiredRepaymentAndFinancedCostUnits',
      'plan.financing.requiredDestinationBorrowUnits',
      'plan.financing.maximumSafeBorrowingCapacityUnits',
      'plan.financing.fundingShortfallUnits',
    ],
  ],
  [
    'Transport',
    [
      'plan.transportProvider',
      'plan.transportQuoteHash',
      'plan.transportDepositAddress',
      'quote.amountInUnits',
      'quote.expectedAmountOutUnits',
      'quote.minAmountOutUnits',
      'quote.fees',
      'quote.expiresAt',
    ],
  ],
  ['Receivers', ['plan.destinationReceiver', 'plan.refundReceiver', 'plan.reservationHash']],
  ['Deadlines', ['plan.deadline', 'plan.financing.validUntil']],
  ['What your wallet signs', ['planHash']],
];

/** The fields repeated at the top of each review. */
const POLICY_GLANCE = [
  'intent.maxSourceDebtUnits',
  'intent.maxTotalFeeUnits',
  'intent.minAprReductionBps',
  'intent.safetyPolicy',
] as const;

const PLAN_GLANCE = [
  'plan.targetMarket',
  'plan.targetDebtMaxUnits',
  'plan.feeMaxUnits',
  'plan.financing.fundingShortfallUnits',
] as const;

export type ReviewKind = 'policy' | 'plan';

function specFor(kind: ReviewKind): readonly GroupSpec[] {
  return kind === 'policy' ? POLICY_GROUPS : PLAN_GROUPS;
}

/**
 * Sorts rows into their groups, keeping the order they arrived in. Every row
 * given comes back exactly once.
 */
export function groupReviewRows(kind: ReviewKind, rows: readonly ReviewRow[]): ReviewGroup[] {
  const groupOf = new Map<string, string>();
  for (const [title, keys] of specFor(kind)) {
    for (const key of keys) groupOf.set(key, title);
  }

  const collected = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    const title = groupOf.get(row.key) ?? UNGROUPED_TITLE;
    const bucket = collected.get(title);
    if (bucket) bucket.push(row);
    else collected.set(title, [row]);
  }

  const ordered: ReviewGroup[] = [];
  for (const [title] of specFor(kind)) {
    const groupRows = collected.get(title);
    if (groupRows) ordered.push({ title, rows: groupRows });
  }
  const unknown = collected.get(UNGROUPED_TITLE);
  if (unknown) ordered.push({ title: UNGROUPED_TITLE, rows: unknown });
  return ordered;
}

/** The rows repeated at the top. A missing field is skipped, never invented. */
export function glanceRows(kind: ReviewKind, rows: readonly ReviewRow[]): ReviewRow[] {
  const keys: readonly string[] = kind === 'policy' ? POLICY_GLANCE : PLAN_GLANCE;
  return keys
    .map((key) => rows.find((row) => row.key === key))
    .filter((row): row is ReviewRow => row !== undefined);
}

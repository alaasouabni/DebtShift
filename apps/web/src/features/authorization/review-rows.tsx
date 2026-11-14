/*
 * The fields a borrower must see before each signature.
 *
 * These are built as DATA, not as JSX buried in a page, for one reason: the
 * contract says every material signed field must be on screen before the
 * button is enabled, and a list can be asserted. `review-rows.test.ts` fails if
 * a required field stops being produced, which is a stronger guarantee than a
 * reviewer reading a template.
 *
 * `key` is the field's path in the signed object. It is what the test checks
 * and what is rendered in monospace beside the human label, so a developer can
 * always tie a row back to the exact field the wallet hashed.
 */

import type { ReactNode } from 'react';

import type {
  PreparedMigration,
  RefinanceIntent,
  ExecutionPlan,
  ProviderQuote,
} from '../../lib/api/types';
import {
  formatAmount,
  formatBaseUnits,
  formatBps,
  formatDuration,
  formatTimestamp,
  formatUnixTimestamp,
  isZeroAmount,
} from '../../lib/formatting';

export interface ReviewRow {
  /** The signed field path, e.g. `intent.maxSourceDebtUnits`. */
  readonly key: string;
  readonly label: string;
  readonly value: ReactNode;
  /** The exact value as the backend sent it, shown in monospace. */
  readonly raw?: string;
  /** Draws attention: a zero shortfall is a requirement, not a detail. */
  readonly tone?: 'success' | 'danger';
}

function marketLabel(market: {
  chainId: number;
  protocol: string;
  deployment: string;
  marketId: string;
}): string {
  return `${market.protocol.replace(/_/gu, ' ')} · chain ${market.chainId}`;
}

function marketRaw(market: {
  chainId: number;
  protocol: string;
  deployment: string;
  marketId: string;
}): string {
  return `${market.protocol} ${market.chainId} · deployment ${market.deployment} · market ${market.marketId}`;
}

function tokenLabel(token: { symbol: string; chainId: number }): string {
  return `${token.symbol} on chain ${token.chainId}`;
}

function tokenRaw(token: {
  symbol: string;
  chainId: number;
  address: string;
  decimals: number;
}): string {
  return `${token.address} · ${token.decimals} decimals`;
}

/* ------------------------------------------------------- signature 1: intent */

export function intentRows(
  intent: RefinanceIntent,
  verifyingContract: string,
  intentHash: string,
): ReviewRow[] {
  const rows: ReviewRow[] = [
    {
      key: 'intent.borrower',
      label: 'Signing account',
      value: intent.borrower,
      raw: `accountType ${intent.accountType}`,
    },
    {
      key: 'intent.accountType',
      label: 'Account type',
      value: intent.accountType === 'EOA' ? 'Externally owned account' : 'Smart account (EIP-1271)',
      raw: intent.accountType,
    },
    {
      key: 'intent.sourcePosition',
      label: 'Source position',
      value: marketLabel(intent.sourcePosition.market),
      raw: marketRaw(intent.sourcePosition.market),
    },
    {
      key: 'intent.allowedTargets',
      label: `Destination markets allowed (${intent.allowedTargets.length})`,
      // Every target, never "and 3 more": the signature authorizes all of them.
      value: intent.allowedTargets.map((target) => marketLabel(target)).join(' · '),
      raw: intent.allowedTargets.map((target) => marketRaw(target)).join('\n'),
    },
    {
      key: 'intent.maxSourceDebtUnits',
      label: 'Repay at most',
      value: formatAmount(
        intent.maxSourceDebtUnits,
        intent.sourcePosition.debtAsset.decimals,
        intent.sourcePosition.debtAsset.symbol,
      ),
      raw: `maxSourceDebtUnits ${intent.maxSourceDebtUnits}`,
    },
    {
      key: 'intent.minSourceCollateralUnits',
      label: 'Keep at least',
      value: formatAmount(
        intent.minSourceCollateralUnits,
        intent.sourcePosition.collateralAsset.decimals,
        intent.sourcePosition.collateralAsset.symbol,
      ),
      raw: `minSourceCollateralUnits ${intent.minSourceCollateralUnits}`,
    },
    {
      key: 'intent.maxTotalFeeUnits',
      label: 'Pay in fees at most',
      value: formatAmount(
        intent.maxTotalFeeUnits,
        intent.feeAsset.decimals,
        intent.feeAsset.symbol,
      ),
      raw: `maxTotalFeeUnits ${intent.maxTotalFeeUnits}`,
    },
    {
      key: 'intent.feeAsset',
      label: 'Fee asset',
      value: tokenLabel(intent.feeAsset),
      raw: tokenRaw(intent.feeAsset),
    },
    {
      key: 'intent.maxSlippageBps',
      label: 'Lose to slippage at most',
      value: formatBps(intent.maxSlippageBps),
      raw: `maxSlippageBps ${intent.maxSlippageBps}`,
    },
    {
      key: 'intent.minAprReductionBps',
      label: 'Save at least',
      value: formatBps(intent.minAprReductionBps),
      raw: `minAprReductionBps ${intent.minAprReductionBps}`,
    },
    {
      key: 'intent.safetyPolicy',
      label: 'Safety limit',
      value:
        intent.safetyPolicy.kind === 'MAX_LTV_BPS'
          ? `${formatBps(intent.safetyPolicy.maximumLtvBps)} loan-to-value · ${formatBps(intent.safetyPolicy.stressMaximumLtvBps)} under stress`
          : `${formatBaseUnits(intent.safetyPolicy.minimumWad, 18, { fractionDigits: 2 })} health factor · ${formatBaseUnits(intent.safetyPolicy.stressMinimumWad, 18, { fractionDigits: 2 })} under stress`,
      raw:
        intent.safetyPolicy.kind === 'MAX_LTV_BPS'
          ? `MAX_LTV_BPS ${intent.safetyPolicy.maximumLtvBps} · stress ${intent.safetyPolicy.stressMaximumLtvBps}`
          : `MIN_HEALTH_FACTOR_WAD ${intent.safetyPolicy.minimumWad} · stress ${intent.safetyPolicy.stressMinimumWad}`,
    },
    {
      key: 'intent.maxDurationSeconds',
      label: 'Migration may take at most',
      value: formatDuration(intent.maxDurationSeconds),
      raw: `maxDurationSeconds ${intent.maxDurationSeconds}`,
    },
    {
      key: 'intent.expiration',
      label: 'This authorization expires',
      value: formatUnixTimestamp(intent.expiration),
      raw: `expiration ${intent.expiration}`,
    },
    {
      key: 'intent.nonce',
      label: 'Replay protection',
      value: 'Single use',
      raw: `nonce ${intent.nonce}`,
    },
    {
      key: 'intentHash',
      label: 'Hash your wallet signs',
      value: intentHash,
      raw: `verifyingContract ${verifyingContract}`,
    },
    {
      key: 'verifyingContract',
      label: 'Verifying contract',
      value: verifyingContract,
      raw: `EIP-712 domain · chain ${intent.sourcePosition.market.chainId}`,
    },
  ];
  return rows;
}

/* --------------------------------------------------------- signature 2: plan */

export function planRows(plan: ExecutionPlan, quote: ProviderQuote, planHash: string): ReviewRow[] {
  const settlement = plan.financing.settlementAsset;
  const financing = plan.financing;

  return [
    /* binding */
    {
      key: 'plan.intentHash',
      label: 'Binds to the policy you signed',
      value: plan.intentHash,
      raw: `intentHash ${plan.intentHash}`,
    },
    {
      key: 'plan.migrationId',
      label: 'Migration',
      value: plan.migrationId,
      raw: `migrationId ${plan.migrationId}`,
    },
    {
      key: 'plan.routeHash',
      label: 'Route',
      value: plan.routeHash,
      raw: `routeHash ${plan.routeHash}`,
    },
    {
      key: 'plan.nonce',
      label: 'Replay protection',
      value: 'Single use',
      raw: `nonce ${plan.nonce}`,
    },

    /* markets and assets */
    {
      key: 'plan.sourceMarket',
      label: 'From',
      value: marketLabel(plan.sourceMarket),
      raw: marketRaw(plan.sourceMarket),
    },
    {
      key: 'plan.targetMarket',
      label: 'To',
      value: marketLabel(plan.targetMarket),
      raw: marketRaw(plan.targetMarket),
    },
    {
      key: 'plan.sourceDebtAsset',
      label: 'Source debt asset',
      value: tokenLabel(plan.sourceDebtAsset),
      raw: tokenRaw(plan.sourceDebtAsset),
    },
    {
      key: 'plan.sourceCollateralAsset',
      label: 'Source collateral asset',
      value: tokenLabel(plan.sourceCollateralAsset),
      raw: tokenRaw(plan.sourceCollateralAsset),
    },
    {
      key: 'plan.destinationDebtAsset',
      label: 'Destination debt asset',
      value: tokenLabel(plan.destinationDebtAsset),
      raw: tokenRaw(plan.destinationDebtAsset),
    },
    {
      key: 'plan.destinationCollateralAsset',
      label: 'Destination collateral asset',
      value: tokenLabel(plan.destinationCollateralAsset),
      raw: tokenRaw(plan.destinationCollateralAsset),
    },

    /* amount caps */
    {
      key: 'plan.sourceRepaymentMaxUnits',
      label: 'Repay on the source at most',
      value: formatAmount(
        plan.sourceRepaymentMaxUnits,
        plan.sourceDebtAsset.decimals,
        plan.sourceDebtAsset.symbol,
      ),
      raw: `sourceRepaymentMaxUnits ${plan.sourceRepaymentMaxUnits}`,
    },
    {
      key: 'plan.sourceCollateralMinUnits',
      label: 'Release at least',
      value: formatAmount(
        plan.sourceCollateralMinUnits,
        plan.sourceCollateralAsset.decimals,
        plan.sourceCollateralAsset.symbol,
      ),
      raw: `sourceCollateralMinUnits ${plan.sourceCollateralMinUnits}`,
    },
    {
      key: 'plan.targetDebtMaxUnits',
      label: 'New debt at most',
      value: formatAmount(
        plan.targetDebtMaxUnits,
        plan.destinationDebtAsset.decimals,
        plan.destinationDebtAsset.symbol,
      ),
      raw: `targetDebtMaxUnits ${plan.targetDebtMaxUnits}`,
    },
    {
      key: 'plan.minDestinationCollateralUnits',
      label: 'Deliver at least',
      value: formatAmount(
        plan.minDestinationCollateralUnits,
        plan.destinationCollateralAsset.decimals,
        plan.destinationCollateralAsset.symbol,
      ),
      raw: `minDestinationCollateralUnits ${plan.minDestinationCollateralUnits}`,
    },

    /* solver */
    {
      key: 'plan.principalMaxUnits',
      label: 'Solver principal at most',
      value: formatAmount(plan.principalMaxUnits, settlement.decimals, settlement.symbol),
      raw: `principalMaxUnits ${plan.principalMaxUnits}`,
    },
    {
      key: 'plan.feeMaxUnits',
      label: 'Solver fee at most',
      value: formatAmount(plan.feeMaxUnits, settlement.decimals, settlement.symbol),
      raw: `feeMaxUnits ${plan.feeMaxUnits}`,
    },
    {
      key: 'plan.fundingProvider',
      label: 'Funding provider',
      value: plan.fundingProvider,
      raw: `fundingProvider ${plan.fundingProvider}`,
    },
    {
      key: 'plan.payoutAsset',
      label: 'Payout asset',
      value: tokenLabel(plan.payoutAsset),
      raw: tokenRaw(plan.payoutAsset),
    },
    {
      key: 'plan.payoutReceiver',
      label: 'Payout receiver',
      value: plan.payoutReceiver,
      raw: `payoutReceiver ${plan.payoutReceiver}`,
    },

    /* financing */
    {
      key: 'plan.financing.solverPrincipalUnits',
      label: 'Principal advanced',
      value: formatAmount(financing.solverPrincipalUnits, settlement.decimals, settlement.symbol),
      raw: `solverPrincipalUnits ${financing.solverPrincipalUnits}`,
    },
    {
      key: 'plan.financing.solverFeeUnits',
      label: 'Solver fee',
      value: formatAmount(financing.solverFeeUnits, settlement.decimals, settlement.symbol),
      raw: `solverFeeUnits ${financing.solverFeeUnits}`,
    },
    {
      key: 'plan.financing.capitalizedCostUnits',
      label: 'Costs added to the new loan',
      value: formatAmount(financing.capitalizedCostUnits, settlement.decimals, settlement.symbol),
      raw: `capitalizedCostUnits ${financing.capitalizedCostUnits}`,
    },
    {
      key: 'plan.financing.separatelyPaidCostUnits',
      label: 'Costs paid separately',
      value: formatAmount(
        financing.separatelyPaidCostUnits,
        settlement.decimals,
        settlement.symbol,
      ),
      raw: `separatelyPaidCostUnits ${financing.separatelyPaidCostUnits}`,
    },
    {
      key: 'plan.financing.borrowerDebtPrepaymentUnits',
      label: 'Your own prepayment',
      value: formatAmount(
        financing.borrowerDebtPrepaymentUnits,
        settlement.decimals,
        settlement.symbol,
      ),
      raw: `borrowerDebtPrepaymentUnits ${financing.borrowerDebtPrepaymentUnits}`,
    },
    {
      key: 'plan.financing.totalRequiredRepaymentAndFinancedCostUnits',
      label: 'Total to be covered',
      value: formatAmount(
        financing.totalRequiredRepaymentAndFinancedCostUnits,
        settlement.decimals,
        settlement.symbol,
      ),
      raw: `totalRequiredRepaymentAndFinancedCostUnits ${financing.totalRequiredRepaymentAndFinancedCostUnits}`,
    },
    {
      key: 'plan.financing.requiredDestinationBorrowUnits',
      label: 'Borrowed on the destination',
      value: formatAmount(
        financing.requiredDestinationBorrowUnits,
        settlement.decimals,
        settlement.symbol,
      ),
      raw: `requiredDestinationBorrowUnits ${financing.requiredDestinationBorrowUnits}`,
    },
    {
      key: 'plan.financing.maximumSafeBorrowingCapacityUnits',
      label: 'Safe capacity',
      value: formatAmount(
        financing.maximumSafeBorrowingCapacityUnits,
        settlement.decimals,
        settlement.symbol,
      ),
      raw: `maximumSafeBorrowingCapacityUnits ${financing.maximumSafeBorrowingCapacityUnits}`,
    },
    {
      key: 'plan.financing.fundingShortfallUnits',
      label: 'Funding shortfall',
      value: formatAmount(financing.fundingShortfallUnits, settlement.decimals, settlement.symbol),
      raw: `fundingShortfallUnits ${financing.fundingShortfallUnits}`,
      tone: isZeroAmount(financing.fundingShortfallUnits) ? 'success' : 'danger',
    },

    /* transport */
    {
      key: 'plan.transportProvider',
      label: 'Transport provider',
      value:
        plan.transportProvider === 'DEBTSHIFT_SIMULATOR'
          ? 'DebtShift simulator (test assets)'
          : 'NEAR Intents · 1Click',
      raw: `transportProvider ${plan.transportProvider} · quote mode ${quote.mode}`,
    },
    {
      key: 'plan.transportQuoteHash',
      label: 'Quote bound to this plan',
      value: plan.transportQuoteHash,
      raw: `transportQuoteHash ${plan.transportQuoteHash} · quoteId ${quote.quoteId}`,
    },
    {
      key: 'plan.transportDepositAddress',
      label: 'Transport deposit address',
      value: plan.transportDepositAddress,
      raw: `transportDepositAddress ${plan.transportDepositAddress}`,
    },
    // Present only when the transport provider requires one for the deposit.
    ...(quote.depositMemo === undefined
      ? []
      : [
          {
            key: 'quote.depositMemo',
            label: 'Transport deposit memo',
            value: quote.depositMemo,
            raw: `depositMemo ${quote.depositMemo}`,
          },
        ]),
    {
      key: 'quote.amountInUnits',
      label: 'Sent through transport',
      value: formatAmount(quote.amountInUnits, quote.inputAsset.decimals, quote.inputAsset.symbol),
      raw: `amountInUnits ${quote.amountInUnits}`,
    },
    {
      key: 'quote.expectedAmountOutUnits',
      label: 'Expected out',
      value: formatAmount(
        quote.expectedAmountOutUnits,
        quote.outputAsset.decimals,
        quote.outputAsset.symbol,
      ),
      raw: `expectedAmountOutUnits ${quote.expectedAmountOutUnits}`,
    },
    {
      key: 'quote.minAmountOutUnits',
      label: 'Minimum out, guaranteed',
      value: formatAmount(
        quote.minAmountOutUnits,
        quote.outputAsset.decimals,
        quote.outputAsset.symbol,
      ),
      raw: `minAmountOutUnits ${quote.minAmountOutUnits}`,
    },
    {
      key: 'quote.fees',
      label: `Transport fees (${quote.fees.length})`,
      value:
        quote.fees.length === 0
          ? 'None'
          : quote.fees
              .map(
                (fee) =>
                  `${fee.kind.toLowerCase()} ${formatAmount(fee.amountUnits, fee.asset.decimals, fee.asset.symbol)}`,
              )
              .join(' · '),
      raw: quote.fees
        .map((fee) => `${fee.kind} ${fee.amountUnits} ${fee.asset.address}`)
        .join('\n'),
    },
    {
      key: 'quote.expiresAt',
      label: 'Quote expires',
      value: formatTimestamp(quote.expiresAt),
      raw: `expiresAt ${quote.expiresAt} · quoteHash ${quote.quoteHash}`,
    },

    /* receivers */
    {
      key: 'plan.destinationReceiver',
      label: 'Destination receiver',
      value: plan.destinationReceiver,
      raw: `destinationReceiver ${plan.destinationReceiver}`,
    },
    /*
     * Signed since plan version 2. A payload recorded before it does not
     * carry the field, and a row is never invented for a value that was
     * not signed.
     */
    ...(plan.transportRefundReceiver === undefined
      ? []
      : [
          {
            key: 'plan.transportRefundReceiver',
            label: 'Refund receiver, if transport fails',
            value: plan.transportRefundReceiver,
            raw: `transportRefundReceiver ${plan.transportRefundReceiver}`,
          },
        ]),
    {
      key: 'plan.refundReceiver',
      label: 'Final refund receiver',
      value: plan.refundReceiver,
      raw: `refundReceiver ${plan.refundReceiver}`,
    },
    {
      key: 'plan.reservationHash',
      label: 'Liquidity reservation',
      value: plan.reservationHash,
      raw: `reservationHash ${plan.reservationHash}`,
    },

    /* window */
    {
      key: 'plan.deadline',
      label: 'Execution deadline',
      value: formatUnixTimestamp(plan.deadline),
      raw: `deadline ${plan.deadline}`,
    },
    {
      key: 'plan.financing.validUntil',
      label: 'Financing evidence valid until',
      value: formatUnixTimestamp(financing.validUntil),
      raw: `validUntil ${financing.validUntil}`,
    },
    {
      key: 'planHash',
      label: 'Hash your wallet signs',
      value: planHash,
      raw: `planHash ${planHash}`,
    },
  ];
}

/** Both lists, for a prepared migration. */
export function allReviewRows(prepared: PreparedMigration): {
  intent: ReviewRow[];
  plan: ReviewRow[];
} {
  return {
    intent: intentRows(prepared.intent, prepared.verifyingContract, prepared.intentHash),
    plan: planRows(prepared.plan, prepared.quote, prepared.planHash),
  };
}

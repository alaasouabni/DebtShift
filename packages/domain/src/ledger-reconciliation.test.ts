import { describe, expect, it } from 'vitest';

import { ledgerReconciliationSchema } from './migration.js';

const MIGRATION_ID = `0x${'11'.repeat(32)}`;
const EVIDENCE_ID = `0x${'22'.repeat(32)}`;
const SOURCE_TOKEN = `0x${'33'.repeat(20)}`;
const DESTINATION_TOKEN = `0x${'44'.repeat(20)}`;
const OBSERVED_AT = '2026-11-13T00:00:00.000Z';

describe('ledger reconciliation', () => {
  it('accepts exact destination settlement and recovery-reserve accounting', () => {
    const reconciliation = ledgerReconciliationSchema.parse(validReconciliation());

    expect(reconciliation.unexplainedImbalanceUnits).toBe('0');
    expect(reconciliation.entries).toHaveLength(12);
  });

  it('rejects a principal payout that does not reconcile', () => {
    const input = validReconciliation();
    const payout = input.entries.find((entry) => entry.componentCode === 'SOLVER_PRINCIPAL_PAYOUT');
    if (payout === undefined) throw new Error('Fixture is missing the principal payout.');
    payout.amountUnits = '99';

    expect(() => ledgerReconciliationSchema.parse(input)).toThrow(
      'Solver principal payout ledger total does not reconcile.',
    );
  });

  it('rejects a gap in the durable ledger sequence', () => {
    const input = validReconciliation();
    const last = input.entries.at(-1);
    if (last === undefined) throw new Error('Fixture has no ledger entries.');
    last.sequence = 20;

    expect(() => ledgerReconciliationSchema.parse(input)).toThrow(
      'Ledger sequences must be contiguous and start at one.',
    );
  });
});

function validReconciliation() {
  const entries = [
    entry('SOURCE_DEBT_PAYOFF', '100', 31_337, SOURCE_TOKEN, 'vault', 'source-market', 'PRINCIPAL'),
    entry(
      'RECOVERY_RESERVE_LOCKED',
      '108',
      31_337,
      SOURCE_TOKEN,
      'solver',
      'recovery-reserve',
      'RESERVE',
    ),
    entry(
      'SEPARATELY_PAID_COST_CLASSIFICATION',
      '7',
      31_338,
      DESTINATION_TOKEN,
      'borrower',
      'external-cost',
      'COST',
    ),
    entry(
      'TRANSPORT_ORIGIN_COLLATERAL',
      '10',
      31_337,
      SOURCE_TOKEN,
      'source-escrow',
      'provider-deposit',
      'COLLATERAL',
    ),
    entry(
      'TRANSPORT_DESTINATION_COLLATERAL',
      '9',
      31_338,
      DESTINATION_TOKEN,
      'transport-provider',
      'destination-escrow',
      'COLLATERAL',
    ),
    entry(
      'TARGET_COLLATERAL_SUPPLY',
      '9',
      31_338,
      DESTINATION_TOKEN,
      'destination-escrow',
      'target-market',
      'COLLATERAL',
    ),
    entry(
      'DESTINATION_LOAN_PROCEEDS',
      '105',
      31_338,
      DESTINATION_TOKEN,
      'target-market',
      'destination-escrow',
      'PRINCIPAL',
    ),
    entry(
      'SOLVER_PRINCIPAL_PAYOUT',
      '100',
      31_338,
      DESTINATION_TOKEN,
      'destination-escrow',
      'solver',
      'PRINCIPAL',
    ),
    entry(
      'SOLVER_FEE_PAYOUT',
      '5',
      31_338,
      DESTINATION_TOKEN,
      'destination-escrow',
      'solver',
      'FEE',
    ),
    entry(
      'RECOVERY_RESERVE_PRINCIPAL_CONSUMED',
      '100',
      31_337,
      SOURCE_TOKEN,
      'recovery-reserve',
      'vault',
      'PRINCIPAL',
    ),
    entry(
      'RECOVERY_RESERVE_FEE_CONSUMED',
      '5',
      31_337,
      SOURCE_TOKEN,
      'recovery-reserve',
      'vault',
      'FEE',
    ),
    entry(
      'RECOVERY_RESERVE_REFUND',
      '3',
      31_337,
      SOURCE_TOKEN,
      'recovery-reserve',
      'solver',
      'REFUND',
    ),
  ].map((value, index) => ({
    ...value,
    entryId: `0x${(index + 1).toString(16).padStart(64, '0')}`,
    sequence: index + 1,
  }));

  return {
    version: 1 as const,
    migrationId: MIGRATION_ID,
    sourceDebtPayoffUnits: '100',
    borrowerDebtPrepaymentUnits: '0',
    solverPrincipalUnits: '100',
    solverFeeUnits: '5',
    capitalizedCostUnits: '0',
    separatelyPaidCostUnits: '7',
    requiredDestinationBorrowUnits: '105',
    confirmedExternalFundingUnits: '0',
    recoveryReserveLockedUnits: '108',
    recoveryReserveConsumedUnits: '105',
    recoveryReserveRefundedUnits: '3',
    residualReturnUnits: '0',
    unexplainedImbalanceUnits: '0' as const,
    entries,
  };
}

function entry(
  componentCode: string,
  amountUnits: string,
  chainId: number,
  token: string,
  debitParty: string,
  creditParty: string,
  category: string,
) {
  return {
    entryId: `0x${'0'.repeat(64)}`,
    migrationId: MIGRATION_ID,
    sequence: 0,
    componentCode,
    componentId: componentCode.toLowerCase(),
    evidenceId: EVIDENCE_ID,
    basis:
      componentCode === 'SEPARATELY_PAID_COST_CLASSIFICATION'
        ? 'SIGNED_COST_CLASSIFICATION'
        : 'FINALIZED_MOVEMENT',
    chainId,
    token,
    amountUnits,
    debitParty,
    creditParty,
    category,
    createdAt: OBSERVED_AT,
  };
}

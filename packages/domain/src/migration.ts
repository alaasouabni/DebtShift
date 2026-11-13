import { z } from 'zod';

import { tokenReferenceSchema, transportProviderSchema } from './assets.js';
import {
  baseUnitAmountSchema,
  bytes32Schema,
  canonicalTextSchema,
  chainIdSchema,
  evmAddressSchema,
  isoTimestampSchema,
  positiveBaseUnitAmountSchema,
  uint64StringSchema,
} from './primitives.js';

export const migrationPhaseSchema = z.enum([
  'DRAFT',
  'QUOTED',
  'AUTHORIZED',
  'RESERVED',
  'SOURCE_CLOSED',
  'ROUTING',
  'DEST_FUNDED',
  'TARGET_OPEN',
  'SETTLED',
  'COMPLETED',
  'RECOVERY',
  'FAILED_SAFE',
  'REQUOTE_REQUIRED',
  'EXPIRED',
]);

export const evidenceTypeSchema = z.enum([
  'SOURCE_POSITION_SNAPSHOT',
  'ROUTE_QUOTE',
  'INTENT_AUTHORIZATION',
  'EXECUTION_PLAN_AUTHORIZATION',
  'SOURCE_LENDING_AUTHORIZATION',
  'FINANCING_FEASIBILITY',
  'FINANCING_REVALIDATION',
  'SUPPLEMENTARY_FUNDING',
  'LIQUIDITY_RESERVATION',
  'SOURCE_CLOSE',
  'TRANSPORT_ORIGIN',
  'TRANSPORT_DESTINATION',
  'TARGET_POSITION',
  'LIQUIDITY_SETTLEMENT',
  'LEDGER_RECONCILIATION',
  'NEAR_RECEIPT',
  'MIGRATION_EXPIRED',
  'REQUOTE_REQUIRED',
  'RECOVERY_OPENED',
  'RECOVERY_COMPLETED',
]);

export const evidenceVerificationStateSchema = z.enum([
  'PROVISIONAL',
  'CONFIRMED',
  'FINALIZED',
  'RETRACTED',
  'REJECTED',
]);

export const recoveryPolicySchema = z.enum([
  'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
  'RETURN_VERIFIED_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
  'MANUAL_CUSTODY_RECONCILIATION',
  'MANUAL_TARGET_AND_PAYOUT_RECONCILIATION',
  'MANUAL_SETTLEMENT_RECONCILIATION',
  'MANUAL_RECOVERY_EXECUTION_RECONCILIATION',
  'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION',
]);

export const recoveryNextPermittedActionSchema = z.enum([
  'EXECUTE_SIGNED_RECOVERY',
  'RECONCILE_TRANSPORT_CUSTODY',
  'RECONCILE_TARGET_AND_PAYOUT',
  'RECONCILE_SETTLEMENT',
  'RECONCILE_RECOVERY_EXECUTION',
  'RECONCILE_CANONICAL_STATE',
]);

export const recoveryEscalationStateSchema = z.enum([
  'AUTOMATED_RECOVERY_PENDING',
  'MANUAL_REVIEW_REQUIRED',
  'RESOLVED_FAILED_SAFE',
]);

export const recoveryCaseStatusSchema = z.enum(['OPEN', 'RESOLVED_FAILED_SAFE']);

export const recoveryOpeningPayloadSchema = z
  .object({
    reason: canonicalTextSchema,
    policy: recoveryPolicySchema,
    requiresManualReview: z.boolean(),
    nextPermittedAction: recoveryNextPermittedActionSchema,
    actionDeadline: isoTimestampSchema,
    escalationOwner: canonicalTextSchema,
    escalationState: z.enum(['AUTOMATED_RECOVERY_PENDING', 'MANUAL_REVIEW_REQUIRED']),
    residualAssets: z.array(z.record(z.string(), z.unknown())).min(1),
  })
  .catchall(z.unknown())
  .superRefine((payload, context) => {
    const manual = payload.escalationState === 'MANUAL_REVIEW_REQUIRED';
    if (payload.requiresManualReview !== manual) {
      context.addIssue({
        code: 'custom',
        path: ['requiresManualReview'],
        message: 'Manual-review flag and escalation state must agree.',
      });
    }
    if (manual === (payload.nextPermittedAction === 'EXECUTE_SIGNED_RECOVERY')) {
      context.addIssue({
        code: 'custom',
        path: ['nextPermittedAction'],
        message: 'Only an automated recovery may permit signed recovery execution.',
      });
    }
  });

export const evidenceSchema = z
  .object({
    evidenceId: bytes32Schema,
    migrationId: bytes32Schema,
    type: evidenceTypeSchema,
    schemaVersion: z.number().int().positive(),
    provider: canonicalTextSchema,
    network: canonicalTextSchema,
    chainId: chainIdSchema.optional(),
    blockNumber: uint64StringSchema.optional(),
    blockHash: bytes32Schema.optional(),
    transactionHash: bytes32Schema.optional(),
    logIndex: z.number().int().min(0).optional(),
    providerReference: canonicalTextSchema.optional(),
    rawObservationHash: bytes32Schema,
    normalizedPayload: z.record(z.string(), z.unknown()),
    observedAt: isoTimestampSchema,
    verificationState: evidenceVerificationStateSchema,
    verificationMethod: canonicalTextSchema,
    verifierVersion: canonicalTextSchema,
    supersedesEvidenceId: bytes32Schema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const blockFields = [evidence.blockNumber, evidence.blockHash];
    if (
      blockFields.some((value) => value !== undefined) &&
      blockFields.some((value) => value === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Block number and block hash must be recorded together.',
      });
    }

    if (evidence.logIndex !== undefined && evidence.transactionHash === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['logIndex'],
        message: 'A log index requires a transaction hash.',
      });
    }
  });

export const commandTypeSchema = z.enum([
  'RESERVE_LIQUIDITY',
  'CLOSE_SOURCE',
  'DISPATCH_TRANSPORT',
  'VERIFY_DESTINATION',
  'OPEN_TARGET',
  'SETTLE_LIQUIDITY',
  'FINALIZE_NEAR_RECEIPT',
  'EXECUTE_RECOVERY',
]);

export const commandStatusSchema = z.enum([
  'PENDING',
  'DISPATCHED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL',
  'CANCELLED',
]);

export const migrationSchema = z
  .object({
    migrationId: bytes32Schema,
    intentHash: bytes32Schema,
    executionPlanHash: bytes32Schema,
    quoteHash: bytes32Schema,
    borrower: evmAddressSchema,
    phase: migrationPhaseSchema,
    version: z.number().int().nonnegative(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const commandSchema = z
  .object({
    commandId: bytes32Schema,
    migrationId: bytes32Schema,
    type: commandTypeSchema,
    idempotencyKey: canonicalTextSchema,
    status: commandStatusSchema,
    logicalAttempt: z.number().int().nonnegative(),
    payloadHash: bytes32Schema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const transportLegSchema = z
  .object({
    migrationId: bytes32Schema,
    legIndex: z.number().int().nonnegative(),
    provider: transportProviderSchema,
    quoteHash: bytes32Schema,
    inputAsset: tokenReferenceSchema,
    outputAsset: tokenReferenceSchema,
    inputUnits: baseUnitAmountSchema,
    minimumOutputUnits: baseUnitAmountSchema,
    providerState: canonicalTextSchema,
    depositAddress: canonicalTextSchema.optional(),
    refundTransactionHash: bytes32Schema.optional(),
  })
  .strict();

export const ledgerCategorySchema = z.enum([
  'PRINCIPAL',
  'FEE',
  'COST',
  'COLLATERAL',
  'RESERVE',
  'REFUND',
  'RESIDUAL',
  'SHORTFALL',
]);

export const ledgerComponentCodeSchema = z.enum([
  'SOURCE_DEBT_PAYOFF',
  'BORROWER_DEBT_PREPAYMENT',
  'SEPARATELY_PAID_COST_CLASSIFICATION',
  'RECOVERY_RESERVE_LOCKED',
  'TRANSPORT_ORIGIN_COLLATERAL',
  'TRANSPORT_DESTINATION_COLLATERAL',
  'TARGET_COLLATERAL_SUPPLY',
  'DESTINATION_LOAN_PROCEEDS',
  'SUPPLEMENTARY_SETTLEMENT_FUNDING',
  'SOLVER_PRINCIPAL_PAYOUT',
  'SOLVER_FEE_PAYOUT',
  'CAPITALIZED_COST_PAYOUT',
  'RESIDUAL_RETURN',
  'RECOVERY_RESERVE_PRINCIPAL_CONSUMED',
  'RECOVERY_RESERVE_FEE_CONSUMED',
  'RECOVERY_RESERVE_REFUND',
]);

export const ledgerEntrySchema = z
  .object({
    entryId: bytes32Schema,
    migrationId: bytes32Schema,
    sequence: z.number().int().positive(),
    componentCode: ledgerComponentCodeSchema,
    componentId: canonicalTextSchema,
    evidenceId: bytes32Schema,
    basis: z.enum(['FINALIZED_MOVEMENT', 'SIGNED_COST_CLASSIFICATION']),
    chainId: chainIdSchema,
    token: evmAddressSchema,
    amountUnits: positiveBaseUnitAmountSchema,
    debitParty: canonicalTextSchema,
    creditParty: canonicalTextSchema,
    category: ledgerCategorySchema,
    transactionReference: canonicalTextSchema.optional(),
    createdAt: isoTimestampSchema,
  })
  .strict()
  .refine((entry) => entry.debitParty !== entry.creditParty, {
    message: 'A ledger entry must move value between distinct parties.',
  });

export const ledgerReconciliationSchema = z
  .object({
    version: z.literal(1),
    migrationId: bytes32Schema,
    sourceDebtPayoffUnits: positiveBaseUnitAmountSchema,
    borrowerDebtPrepaymentUnits: baseUnitAmountSchema,
    solverPrincipalUnits: positiveBaseUnitAmountSchema,
    solverFeeUnits: baseUnitAmountSchema,
    capitalizedCostUnits: baseUnitAmountSchema,
    separatelyPaidCostUnits: baseUnitAmountSchema,
    requiredDestinationBorrowUnits: positiveBaseUnitAmountSchema,
    confirmedExternalFundingUnits: baseUnitAmountSchema,
    recoveryReserveLockedUnits: positiveBaseUnitAmountSchema,
    recoveryReserveConsumedUnits: positiveBaseUnitAmountSchema,
    recoveryReserveRefundedUnits: baseUnitAmountSchema,
    residualReturnUnits: baseUnitAmountSchema,
    unexplainedImbalanceUnits: z.literal('0'),
    entries: z.array(ledgerEntrySchema).min(6).max(128),
  })
  .strict()
  .superRefine((reconciliation, context) => {
    const entryIds = new Set<string>();
    const componentIds = new Set<string>();
    const sequences = new Set<number>();
    for (const [index, entry] of reconciliation.entries.entries()) {
      if (entry.migrationId !== reconciliation.migrationId) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'migrationId'],
          message: 'Ledger entry belongs to another migration.',
        });
      }
      const expectedBasis =
        entry.componentCode === 'SEPARATELY_PAID_COST_CLASSIFICATION'
          ? 'SIGNED_COST_CLASSIFICATION'
          : 'FINALIZED_MOVEMENT';
      if (entry.basis !== expectedBasis) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'basis'],
          message: `${entry.componentCode} has an invalid ledger basis.`,
        });
      }
      if (entryIds.has(entry.entryId)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'entryId'],
          message: 'Duplicate ledger entryId.',
        });
      }
      if (componentIds.has(entry.componentId)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'componentId'],
          message: 'Duplicate ledger componentId.',
        });
      }
      if (sequences.has(entry.sequence)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'sequence'],
          message: 'Duplicate ledger sequence.',
        });
      }
      entryIds.add(entry.entryId);
      componentIds.add(entry.componentId);
      sequences.add(entry.sequence);
    }
    for (let sequence = 1; sequence <= reconciliation.entries.length; sequence += 1) {
      if (!sequences.has(sequence)) {
        context.addIssue({
          code: 'custom',
          path: ['entries'],
          message: 'Ledger sequences must be contiguous and start at one.',
        });
        break;
      }
    }

    const value = (amount: string) => BigInt(amount);
    const sum = (code: z.infer<typeof ledgerComponentCodeSchema>) =>
      reconciliation.entries
        .filter((entry) => entry.componentCode === code)
        .reduce((total, entry) => total + value(entry.amountUnits), 0n);
    const exact = (
      code: z.infer<typeof ledgerComponentCodeSchema>,
      expected: bigint,
      label: string,
    ) => {
      if (sum(code) !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['entries'],
          message: `${label} ledger total does not reconcile.`,
        });
      }
    };

    const principal = value(reconciliation.solverPrincipalUnits);
    const fee = value(reconciliation.solverFeeUnits);
    const capitalized = value(reconciliation.capitalizedCostUnits);
    const separatelyPaid = value(reconciliation.separatelyPaidCostUnits);
    const externalFunding = value(reconciliation.confirmedExternalFundingUnits);
    const requiredBorrow = value(reconciliation.requiredDestinationBorrowUnits);
    const recoveryReserveLocked = value(reconciliation.recoveryReserveLockedUnits);
    const recoveryReserveConsumed = value(reconciliation.recoveryReserveConsumedUnits);
    const recoveryReserveRefunded = value(reconciliation.recoveryReserveRefundedUnits);
    const residual = value(reconciliation.residualReturnUnits);
    const prepayment = value(reconciliation.borrowerDebtPrepaymentUnits);
    const sourcePayoff = value(reconciliation.sourceDebtPayoffUnits);
    const available = requiredBorrow + externalFunding;
    const obligation = principal + fee + capitalized;

    if (sourcePayoff !== principal + prepayment) {
      context.addIssue({
        code: 'custom',
        path: ['sourceDebtPayoffUnits'],
        message: 'Source payoff does not reconcile to solver principal plus borrower prepayment.',
      });
    }
    if (available !== obligation + residual) {
      context.addIssue({
        code: 'custom',
        path: ['residualReturnUnits'],
        message: 'Destination borrowing and confirmed funding do not reconcile to payouts.',
      });
    }
    if (recoveryReserveConsumed !== principal + fee) {
      context.addIssue({
        code: 'custom',
        path: ['recoveryReserveConsumedUnits'],
        message: 'Consumed recovery reserve does not reconcile to solver principal and fee.',
      });
    }
    if (recoveryReserveLocked !== recoveryReserveConsumed + recoveryReserveRefunded) {
      context.addIssue({
        code: 'custom',
        path: ['recoveryReserveRefundedUnits'],
        message: 'Locked recovery reserve does not reconcile to consumption and refund.',
      });
    }

    exact('SOURCE_DEBT_PAYOFF', principal, 'Source debt payoff');
    exact('BORROWER_DEBT_PREPAYMENT', prepayment, 'Borrower debt prepayment');
    exact(
      'SEPARATELY_PAID_COST_CLASSIFICATION',
      separatelyPaid,
      'Separately paid cost classification',
    );
    exact('RECOVERY_RESERVE_LOCKED', recoveryReserveLocked, 'Recovery reserve lock');
    exact('DESTINATION_LOAN_PROCEEDS', requiredBorrow, 'Destination loan proceeds');
    exact('SUPPLEMENTARY_SETTLEMENT_FUNDING', externalFunding, 'Supplementary funding');
    exact('SOLVER_PRINCIPAL_PAYOUT', principal, 'Solver principal payout');
    exact('SOLVER_FEE_PAYOUT', fee, 'Solver fee payout');
    exact('CAPITALIZED_COST_PAYOUT', capitalized, 'Capitalized cost payout');
    exact('RESIDUAL_RETURN', residual, 'Residual return');
    exact(
      'RECOVERY_RESERVE_PRINCIPAL_CONSUMED',
      principal,
      'Recovery reserve principal consumption',
    );
    exact('RECOVERY_RESERVE_FEE_CONSUMED', fee, 'Recovery reserve fee consumption');
    exact('RECOVERY_RESERVE_REFUND', recoveryReserveRefunded, 'Recovery reserve refund');

    for (const code of [
      'TRANSPORT_ORIGIN_COLLATERAL',
      'TRANSPORT_DESTINATION_COLLATERAL',
      'TARGET_COLLATERAL_SUPPLY',
    ] as const) {
      if (sum(code) === 0n) {
        context.addIssue({
          code: 'custom',
          path: ['entries'],
          message: `${code} is missing from the settlement ledger.`,
        });
      }
    }
  });

export const auditEventSchema = z
  .object({
    eventId: bytes32Schema,
    migrationId: bytes32Schema,
    sequence: z.number().int().positive(),
    type: canonicalTextSchema,
    phase: migrationPhaseSchema,
    payload: z.record(z.string(), z.unknown()),
    observedAt: isoTimestampSchema,
  })
  .strict();

export type MigrationPhase = z.infer<typeof migrationPhaseSchema>;
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type RecoveryPolicy = z.infer<typeof recoveryPolicySchema>;
export type RecoveryNextPermittedAction = z.infer<typeof recoveryNextPermittedActionSchema>;
export type RecoveryEscalationState = z.infer<typeof recoveryEscalationStateSchema>;
export type RecoveryCaseStatus = z.infer<typeof recoveryCaseStatusSchema>;
export type RecoveryOpeningPayload = z.infer<typeof recoveryOpeningPayloadSchema>;
export type Migration = z.infer<typeof migrationSchema>;
export type Command = z.infer<typeof commandSchema>;
export type LedgerCategory = z.infer<typeof ledgerCategorySchema>;
export type LedgerComponentCode = z.infer<typeof ledgerComponentCodeSchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type LedgerReconciliation = z.infer<typeof ledgerReconciliationSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;

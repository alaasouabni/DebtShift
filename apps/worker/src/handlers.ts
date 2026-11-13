import {
  getMigrationExecutionContext,
  listActiveFinalizedChainEvidence,
  updateTransportLegState,
  type DebtShiftDatabase,
  type DurableCommand,
  type MigrationExecutionContext,
  type TransportLegStateUpdate,
} from '@debtshift/database';
import {
  evidenceSchema,
  hashCanonicalText,
  ledgerEntrySchema,
  ledgerReconciliationSchema,
  recoveryOpeningPayloadSchema,
  type Evidence,
  type EvidenceType,
  type LedgerComponentCode,
  type LedgerEntry,
  type LedgerReconciliation,
  type RecoveryNextPermittedAction,
  type RecoveryPolicy,
  type TransportProvider,
} from '@debtshift/domain';
import {
  verifyTransportDelivery,
  verifyTransportRefund,
  type TransportObservation,
} from '@debtshift/intents';
import type { Hex } from 'viem';

import { RetryableCommandError, type CommandHandler } from './processor.js';

export interface FinalizedChainAction {
  readonly chainId: number;
  readonly transactionHash: Hex;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly payload: Record<string, unknown>;
}

type FinalizedTransactionEvidence = Evidence & { readonly transactionHash: Hex };

export interface ChainCanonicalityFailure {
  readonly evidence: Evidence;
  readonly reason: string;
  readonly observedAt: string;
  readonly requiredConfirmations: number;
  readonly observedTipBlockNumber: string;
  readonly observedBlockHash?: Hex;
  readonly observedReceiptBlockNumber?: string;
  readonly observedReceiptBlockHash?: Hex;
}

export class PostSourceCapacityDeteriorationError extends Error {
  override readonly name = 'PostSourceCapacityDeteriorationError';

  constructor(readonly action: FinalizedChainAction) {
    super('Destination capacity deteriorated after source closure.');
  }
}

export class PreSourceCapacityDeteriorationError extends Error {
  override readonly name = 'PreSourceCapacityDeteriorationError';

  constructor(readonly action: FinalizedChainAction) {
    super('Destination capacity deteriorated before source closure.');
  }
}

export class PreSourceCloseFailureError extends Error {
  override readonly name = 'PreSourceCloseFailureError';

  constructor(
    readonly action: FinalizedChainAction,
    cause?: unknown,
  ) {
    super('Source closure failed before changing the source position.', { cause });
  }
}

export interface MigrationExecutionPort {
  verifyCanonicalEvidence(
    records: readonly Evidence[],
  ): Promise<readonly ChainCanonicalityFailure[]>;
  reserve(context: MigrationExecutionContext): Promise<FinalizedChainAction>;
  cancelBeforeSourceClose(context: MigrationExecutionContext): Promise<FinalizedChainAction>;
  expireBeforeSourceClose(
    context: MigrationExecutionContext,
    reason: string,
  ): Promise<FinalizedChainAction>;
  closeSource(context: MigrationExecutionContext): Promise<FinalizedChainAction>;
  dispatchTransport(context: MigrationExecutionContext): Promise<FinalizedChainAction>;
  deliverDestination(
    context: MigrationExecutionContext,
    observation: TransportObservation,
  ): Promise<FinalizedChainAction>;
  openTarget(context: MigrationExecutionContext): Promise<FinalizedChainAction>;
  settleLiquidity(context: MigrationExecutionContext): Promise<FinalizedChainAction>;
  executeRecovery(
    context: MigrationExecutionContext,
    reason: string,
  ): Promise<FinalizedChainAction>;
}

export interface TransportExecutionPort {
  readonly provider: TransportProvider;
  bindOrigin(
    context: MigrationExecutionContext,
    originTransactionHash: Hex,
  ): Promise<{
    readonly providerReference: string;
    readonly observationCount: number;
  }>;
  observe(context: MigrationExecutionContext): Promise<{
    readonly observation: TransportObservation;
    readonly observationCount: number;
  }>;
}

export interface WorkflowEvidenceProviders {
  readonly financing: string;
  readonly liquidity: string;
  readonly source: string;
  readonly target: string;
  readonly ledger: string;
  readonly recovery: string;
}

export interface ReceiptRegistryPort {
  assertReady?(): Promise<void>;
  finalize(context: MigrationExecutionContext): Promise<Evidence>;
}

export class RetryableReceiptRegistryError extends Error {
  override readonly name = 'RetryableReceiptRegistryError';
}

export interface WorkflowContextStore {
  get(migrationId: string): Promise<MigrationExecutionContext>;
  listActiveFinalizedChainEvidence(migrationId: string): Promise<readonly Evidence[]>;
  updateTransport(migrationId: string, update: TransportLegStateUpdate): Promise<void>;
}

export class PostgresWorkflowContextStore implements WorkflowContextStore {
  constructor(private readonly database: DebtShiftDatabase) {}

  async get(migrationId: string): Promise<MigrationExecutionContext> {
    const context = await getMigrationExecutionContext(this.database, migrationId);
    if (context === undefined) throw new Error(`Migration context ${migrationId} was not found.`);
    return context;
  }

  listActiveFinalizedChainEvidence(migrationId: string): Promise<readonly Evidence[]> {
    return listActiveFinalizedChainEvidence(this.database, migrationId);
  }

  updateTransport(migrationId: string, update: TransportLegStateUpdate): Promise<void> {
    return updateTransportLegState(this.database, migrationId, update);
  }
}

export interface WorkflowHandlerDependencies {
  readonly store: WorkflowContextStore;
  readonly execution: MigrationExecutionPort;
  readonly transport: TransportExecutionPort;
  readonly registry: ReceiptRegistryPort;
  readonly evidenceProviders: WorkflowEvidenceProviders;
  readonly now?: () => number;
}

export function createWorkflowHandlers({
  store,
  execution,
  transport,
  registry,
  evidenceProviders,
  now = Date.now,
}: WorkflowHandlerDependencies): ReadonlyMap<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    [
      'RESERVE_LIQUIDITY',
      handler(store, execution, async (context) => {
        const expiration = preSourceExpiration(context, now());
        if (expiration !== undefined) {
          return [preReservationExpirationEvidence(context, expiration)];
        }
        const action = await execution.reserve(context);
        return [
          chainEvidence(
            context.migration.migrationId,
            'FINANCING_REVALIDATION',
            evidenceProviders.financing,
            action,
          ),
          chainEvidence(
            context.migration.migrationId,
            'LIQUIDITY_RESERVATION',
            evidenceProviders.liquidity,
            action,
          ),
        ];
      }),
    ],
    [
      'CANCEL_MIGRATION',
      handler(store, execution, async (context) => [
        chainEvidence(
          context.migration.migrationId,
          'MIGRATION_CANCELLED',
          evidenceProviders.liquidity,
          await execution.cancelBeforeSourceClose(context),
        ),
      ]),
    ],
    [
      'CLOSE_SOURCE',
      handler(store, execution, async (context) => {
        const expiration = preSourceExpiration(context, now());
        if (expiration !== undefined) {
          return [
            chainEvidence(
              context.migration.migrationId,
              'MIGRATION_EXPIRED',
              evidenceProviders.liquidity,
              await execution.expireBeforeSourceClose(context, expiration.reason),
            ),
          ];
        }
        let action: FinalizedChainAction;
        try {
          action = await execution.closeSource(context);
        } catch (error) {
          if (
            !(error instanceof PreSourceCapacityDeteriorationError) &&
            !(error instanceof PreSourceCloseFailureError)
          ) {
            throw error;
          }
          return [
            chainEvidence(
              context.migration.migrationId,
              'FINANCING_REVALIDATION',
              evidenceProviders.financing,
              error.action,
            ),
            chainEvidence(
              context.migration.migrationId,
              'REQUOTE_REQUIRED',
              evidenceProviders.liquidity,
              error.action,
            ),
          ];
        }
        return [
          chainEvidence(
            context.migration.migrationId,
            'FINANCING_REVALIDATION',
            evidenceProviders.financing,
            action,
          ),
          chainEvidence(
            context.migration.migrationId,
            'SOURCE_CLOSE',
            evidenceProviders.source,
            action,
          ),
        ];
      }),
    ],
    [
      'DISPATCH_TRANSPORT',
      handler(
        store,
        execution,
        async (context) => {
          try {
            const action = await execution.dispatchTransport(context);
            const binding = await transport.bindOrigin(context, action.transactionHash);
            await store.updateTransport(context.migration.migrationId, {
              providerState: 'PROCESSING',
              providerReference: binding.providerReference,
              originTransactionHash: action.transactionHash,
              observationCount: binding.observationCount,
            });
            return [
              chainEvidence(
                context.migration.migrationId,
                'TRANSPORT_ORIGIN',
                transport.provider,
                action,
              ),
            ];
          } catch (error) {
            if (error instanceof RetryableCommandError) throw error;
            throw new RetryableCommandError(
              'Transport dispatch or provider binding did not finalize; source custody must be rechecked.',
            );
          }
        },
        true,
        async (context) => {
          const activeEvidence = await store.listActiveFinalizedChainEvidence(
            context.migration.migrationId,
          );
          return [
            transportDispatchRetryBudgetRecoveryEvidence(
              context,
              evidenceProviders.recovery,
              activeEvidence,
            ),
          ];
        },
      ),
    ],
    [
      'VERIFY_DESTINATION',
      handler(
        store,
        execution,
        async (context) => {
          const { observation, observationCount } = await transport.observe(context);
          await store.updateTransport(context.migration.migrationId, {
            providerState: observation.status,
            providerReference: observation.providerReference,
            observationCount,
            ...(observation.destinationTransactionHash === undefined
              ? {}
              : { destinationTransactionHash: observation.destinationTransactionHash }),
            ...(observation.refundTransactionHash === undefined
              ? {}
              : { refundTransactionHash: observation.refundTransactionHash }),
            observedOutputUnits: observation.observedAmountOutUnits,
          });

          if (observation.status === 'AWAITING_DEPOSIT' || observation.status === 'PROCESSING') {
            if (isPastExecutionDeadline(context, observation.observedAt)) {
              const activeEvidence = await store.listActiveFinalizedChainEvidence(
                context.migration.migrationId,
              );
              return [
                expirationEvidence(context, observation, 'TRANSPORT_DEADLINE_EXCEEDED'),
                recoveryEvidence(
                  context,
                  observation,
                  'TRANSPORT_DEADLINE_EXCEEDED',
                  activeEvidence,
                ),
              ];
            }
            throw new RetryableCommandError(`Transport remains ${observation.status}.`);
          }
          if (observation.status === 'SUCCESS') {
            const verification = verifyTransportDelivery(context.quote, observation);
            if (!verification.valid) {
              return [
                recoveryEvidence(
                  context,
                  observation,
                  verification.failures.join(','),
                  await store.listActiveFinalizedChainEvidence(context.migration.migrationId),
                ),
              ];
            }
            const action = await execution.deliverDestination(context, observation);
            return [
              chainEvidence(
                context.migration.migrationId,
                'TRANSPORT_DESTINATION',
                observation.provider,
                action,
                observation,
              ),
            ];
          }
          if (observation.status === 'REFUNDED') {
            const verification = verifyTransportRefund(context.quote, observation);
            if (!verification.valid) {
              throw new RetryableCommandError(
                `Refund evidence is not independently valid: ${verification.failures.join(',')}`,
              );
            }
            return [
              recoveryEvidence(
                context,
                observation,
                'TRANSPORT_REFUNDED',
                await store.listActiveFinalizedChainEvidence(context.migration.migrationId),
              ),
            ];
          }
          if (
            observation.status === 'INCOMPLETE_DEPOSIT' ||
            observation.status === 'FAILED_KNOWN_CUSTODY'
          ) {
            return [
              recoveryEvidence(
                context,
                observation,
                observation.status,
                await store.listActiveFinalizedChainEvidence(context.migration.migrationId),
              ),
            ];
          }
          if (isPastExecutionDeadline(context, observation.observedAt)) {
            const activeEvidence = await store.listActiveFinalizedChainEvidence(
              context.migration.migrationId,
            );
            return [
              expirationEvidence(context, observation, 'AMBIGUOUS_CUSTODY_DEADLINE_EXCEEDED'),
              recoveryEvidence(
                context,
                observation,
                'AMBIGUOUS_CUSTODY_DEADLINE_EXCEEDED',
                activeEvidence,
              ),
            ];
          }
          throw new RetryableCommandError(`Transport custody is ambiguous: ${observation.status}.`);
        },
        true,
        async (context) => {
          const activeEvidence = await store.listActiveFinalizedChainEvidence(
            context.migration.migrationId,
          );
          return [
            transportObservationRetryBudgetRecoveryEvidence(
              context,
              evidenceProviders.recovery,
              activeEvidence,
            ),
          ];
        },
      ),
    ],
    [
      'OPEN_TARGET',
      handler(
        store,
        execution,
        async (context) => {
          try {
            const action = await execution.openTarget(context);
            return [
              chainEvidence(
                context.migration.migrationId,
                'FINANCING_REVALIDATION',
                evidenceProviders.financing,
                action,
              ),
              chainEvidence(
                context.migration.migrationId,
                'TARGET_POSITION',
                evidenceProviders.target,
                action,
              ),
            ];
          } catch (error) {
            if (error instanceof PostSourceCapacityDeteriorationError) {
              return [
                chainEvidence(
                  context.migration.migrationId,
                  'FINANCING_REVALIDATION',
                  evidenceProviders.financing,
                  error.action,
                ),
                capacityDeteriorationRecoveryEvidence(context, error.action),
              ];
            }
            throw new RetryableCommandError(
              'Target opening or its atomic solver payout did not finalize; custody must be rechecked.',
            );
          }
        },
        true,
        async (context) => {
          const activeEvidence = await store.listActiveFinalizedChainEvidence(
            context.migration.migrationId,
          );
          return [
            targetOpenRetryBudgetRecoveryEvidence(
              context,
              evidenceProviders.recovery,
              activeEvidence,
            ),
          ];
        },
      ),
    ],
    [
      'SETTLE_LIQUIDITY',
      handler(
        store,
        execution,
        async (context) => {
          try {
            const action = await execution.settleLiquidity(context);
            const activeEvidence = await store.listActiveFinalizedChainEvidence(
              context.migration.migrationId,
            );
            const ledger = buildSettlementLedger(context, action, activeEvidence);
            return [
              chainEvidence(
                context.migration.migrationId,
                'FINANCING_REVALIDATION',
                evidenceProviders.financing,
                action,
              ),
              chainEvidence(
                context.migration.migrationId,
                'LIQUIDITY_SETTLEMENT',
                evidenceProviders.liquidity,
                action,
              ),
              ledgerEvidence(
                context.migration.migrationId,
                evidenceProviders.ledger,
                action,
                ledger,
              ),
            ];
          } catch (error) {
            if (error instanceof RetryableCommandError) throw error;
            throw new RetryableCommandError(
              'Solver settlement did not finalize; the exact receivable must be reconciled before completion.',
            );
          }
        },
        true,
        async (context) => {
          const activeEvidence = await store.listActiveFinalizedChainEvidence(
            context.migration.migrationId,
          );
          return [
            settlementRetryBudgetRecoveryEvidence(
              context,
              evidenceProviders.recovery,
              activeEvidence,
            ),
          ];
        },
      ),
    ],
    [
      'FINALIZE_NEAR_RECEIPT',
      handler(store, execution, async (context) => {
        try {
          return [await registry.finalize(context)];
        } catch (error) {
          if (error instanceof RetryableReceiptRegistryError) {
            throw new RetryableCommandError(
              'Receipt registry RPC is unavailable or a write outcome is uncertain; final state must be reconciled before retry.',
            );
          }
          throw error;
        }
      }),
    ],
    [
      'EXECUTE_RECOVERY',
      handler(
        store,
        execution,
        async (context) => {
          try {
            return [
              chainEvidence(
                context.migration.migrationId,
                'RECOVERY_COMPLETED',
                evidenceProviders.recovery,
                await execution.executeRecovery(context, 'POLICY_SELECTED_RECOVERY'),
              ),
            ];
          } catch (error) {
            if (error instanceof RetryableCommandError) throw error;
            throw new RetryableCommandError(
              'Automated recovery did not finalize; custody and receivables require reconciliation.',
            );
          }
        },
        false,
        async (context) => {
          const activeEvidence = await store.listActiveFinalizedChainEvidence(
            context.migration.migrationId,
          );
          return [
            recoveryExecutionRetryBudgetEscalationEvidence(
              context,
              evidenceProviders.recovery,
              activeEvidence,
            ),
          ];
        },
      ),
    ],
  ]);
}

function handler(
  store: WorkflowContextStore,
  execution: MigrationExecutionPort,
  execute: (context: MigrationExecutionContext) => Promise<readonly Evidence[]>,
  checkCanonicality = true,
  onRetryExhausted?: (
    context: MigrationExecutionContext,
    error: RetryableCommandError,
  ) => Promise<readonly Evidence[]>,
): CommandHandler {
  return {
    execute: async (command: DurableCommand) => {
      const context = await store.get(command.migrationId);
      if (checkCanonicality) {
        const activeChainEvidence = await store.listActiveFinalizedChainEvidence(
          command.migrationId,
        );
        const failures = await execution.verifyCanonicalEvidence(activeChainEvidence);
        if (failures.length !== 0) return canonicalityFailureEvidence(context, failures);
      }
      return execute(context);
    },
    ...(onRetryExhausted === undefined
      ? {}
      : {
          onRetryExhausted: async (command: DurableCommand, error: RetryableCommandError) =>
            onRetryExhausted(await store.get(command.migrationId), error),
        }),
  };
}

function canonicalityFailureEvidence(
  context: MigrationExecutionContext,
  failures: readonly ChainCanonicalityFailure[],
): readonly Evidence[] {
  const outcomeType: EvidenceType =
    context.migration.phase === 'DRAFT' ||
    context.migration.phase === 'QUOTED' ||
    context.migration.phase === 'AUTHORIZED'
      ? 'REQUOTE_REQUIRED'
      : 'RECOVERY_OPENED';
  const affectedEvidenceIds = [
    ...new Set(failures.map(({ evidence }) => evidence.evidenceId)),
  ].sort();
  const normalizedFailures = failures.map((failure) => ({
    evidenceId: failure.evidence.evidenceId,
    evidenceType: failure.evidence.type,
    chainId: failure.evidence.chainId,
    expectedBlockNumber: failure.evidence.blockNumber,
    expectedBlockHash: failure.evidence.blockHash,
    transactionHash: failure.evidence.transactionHash,
    reason: failure.reason,
    requiredConfirmations: failure.requiredConfirmations,
    observedTipBlockNumber: failure.observedTipBlockNumber,
    observedBlockHash: failure.observedBlockHash,
    observedReceiptBlockNumber: failure.observedReceiptBlockNumber,
    observedReceiptBlockHash: failure.observedReceiptBlockHash,
  }));
  const observedAt = failures[0]?.observedAt ?? new Date().toISOString();
  const incidentKey = affectedEvidenceIds.join(':');
  const incidentPayload = {
    reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
    affectedEvidenceIds,
    failures: normalizedFailures,
    residualAssets: [
      {
        kind: 'CANONICALITY_INCIDENT',
        disposition: 'REQUIRES_DIRECT_CHAIN_RECONCILIATION',
        affectedEvidenceIds,
      },
    ],
  };
  const outcomePayload =
    outcomeType === 'RECOVERY_OPENED'
      ? recoveryOpeningPayloadSchema.parse({
          ...incidentPayload,
          policy: 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION',
          ...recoveryControl(context, 'RECONCILE_CANONICAL_STATE'),
        })
      : {
          ...incidentPayload,
          policy: 'DISCARD_ORPHANED_PLAN_AND_REQUOTE',
          requiresManualReview: false,
        };
  const outcomeEvidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${context.migration.migrationId}:${outcomeType}:CHAIN_REORG:${incidentKey}`,
  );
  const outcome = evidenceSchema.parse({
    evidenceId: outcomeEvidenceId,
    migrationId: context.migration.migrationId,
    type: outcomeType,
    schemaVersion: 1,
    provider: 'DEBTSHIFT_CANONICALITY_WATCHER',
    network: 'debtshift:workflow',
    providerReference: outcomeEvidenceId,
    rawObservationHash: hashCanonicalText(canonicalJson(outcomePayload)),
    normalizedPayload: outcomePayload,
    observedAt,
    verificationState: 'FINALIZED',
    verificationMethod: 'CANONICAL_BLOCK_AND_RECEIPT_REVALIDATION',
    verifierVersion: 'debtshift-worker-v1',
  });
  const retractions = failures.map((failure) => {
    const payload = {
      reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
      originalEvidenceId: failure.evidence.evidenceId,
      originalBlockNumber: failure.evidence.blockNumber,
      originalBlockHash: failure.evidence.blockHash,
      originalTransactionHash: failure.evidence.transactionHash,
      canonicalityFailure: normalizedFailures.find(
        ({ evidenceId }) => evidenceId === failure.evidence.evidenceId,
      ),
    };
    const evidenceId = hashCanonicalText(
      `debtshift.evidence.v1:${context.migration.migrationId}:${failure.evidence.type}:RETRACTION:${failure.evidence.evidenceId}`,
    );
    return evidenceSchema.parse({
      evidenceId,
      migrationId: context.migration.migrationId,
      type: failure.evidence.type,
      schemaVersion: 1,
      provider: 'DEBTSHIFT_CANONICALITY_WATCHER',
      network: failure.evidence.network,
      chainId: failure.evidence.chainId,
      providerReference: evidenceId,
      rawObservationHash: hashCanonicalText(canonicalJson(payload)),
      normalizedPayload: payload,
      observedAt: failure.observedAt,
      verificationState: 'RETRACTED',
      verificationMethod: 'CANONICAL_BLOCK_AND_RECEIPT_REVALIDATION',
      verifierVersion: 'debtshift-worker-v1',
      supersedesEvidenceId: failure.evidence.evidenceId,
    });
  });
  return [outcome, ...retractions];
}

function chainEvidence(
  migrationId: string,
  type: EvidenceType,
  provider: string,
  action: FinalizedChainAction,
  extraPayload: unknown = {},
): Evidence {
  const payload = { ...action.payload, observation: extraPayload };
  const evidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${migrationId}:${type}:${action.transactionHash}`,
  );
  return evidenceSchema.parse({
    evidenceId,
    migrationId,
    type,
    schemaVersion: 1,
    provider,
    network: `eip155:${action.chainId.toString()}`,
    chainId: action.chainId,
    blockNumber: action.blockNumber,
    blockHash: action.blockHash,
    transactionHash: action.transactionHash,
    providerReference: evidenceId,
    rawObservationHash: hashCanonicalText(canonicalJson(payload)),
    normalizedPayload: payload,
    observedAt: new Date().toISOString(),
    verificationState: 'FINALIZED',
    verificationMethod: 'RECEIPT_AND_STATE',
    verifierVersion: 'debtshift-worker-v1',
  });
}

function ledgerEvidence(
  migrationId: string,
  provider: string,
  action: FinalizedChainAction,
  ledger: LedgerReconciliation,
): Evidence {
  const observedAt = ledger.entries[0]?.createdAt ?? new Date().toISOString();
  const payload = { ...action.payload, observation: {}, ledger };
  const evidenceId = actionEvidenceId(migrationId, 'LEDGER_RECONCILIATION', action);
  return evidenceSchema.parse({
    evidenceId,
    migrationId,
    type: 'LEDGER_RECONCILIATION',
    schemaVersion: 1,
    provider,
    network: `eip155:${action.chainId.toString()}`,
    chainId: action.chainId,
    blockNumber: action.blockNumber,
    blockHash: action.blockHash,
    transactionHash: action.transactionHash,
    providerReference: evidenceId,
    rawObservationHash: hashCanonicalText(canonicalJson(payload)),
    normalizedPayload: payload,
    observedAt,
    verificationState: 'FINALIZED',
    verificationMethod: 'RECEIPT_STATE_AND_BALANCED_LEDGER',
    verifierVersion: 'debtshift-worker-v1',
  });
}

function buildSettlementLedger(
  context: MigrationExecutionContext,
  settlement: FinalizedChainAction,
  records: readonly Evidence[],
): LedgerReconciliation {
  const plan = context.signedPlan.plan;
  const migrationId = context.migration.migrationId;
  const reservation = requiredEvidence(records, 'LIQUIDITY_RESERVATION');
  const sourceClose = requiredEvidence(records, 'SOURCE_CLOSE');
  const transportOrigin = requiredEvidence(records, 'TRANSPORT_ORIGIN');
  const transportDestination = requiredEvidence(records, 'TRANSPORT_DESTINATION');
  const targetPosition = requiredEvidence(records, 'TARGET_POSITION');
  const settlementRevalidation = requiredRecord(
    settlement.payload.financingRevalidation,
    'settlement financing revalidation',
  );
  const principal = unsignedPayloadBigInt(settlementRevalidation, 'solverPrincipalUnits', true);
  const fee = unsignedPayloadBigInt(settlementRevalidation, 'solverFeeUnits');
  const capitalized = unsignedPayloadBigInt(settlementRevalidation, 'capitalizedCostUnits');
  const solverAdvanced = BigInt(plan.financing.solverAdvancedCostUnits);
  const separatelyPaid = BigInt(plan.financing.separatelyPaidCostUnits);
  if (solverAdvanced !== 0n || capitalized !== 0n) {
    throw new Error(
      'The P0 route cannot settle cost components without signed, receipt-verifiable recipients.',
    );
  }
  const requiredBorrow = unsignedPayloadBigInt(
    settlementRevalidation,
    'requiredDestinationBorrowUnits',
    true,
  );
  const externalFunding = unsignedPayloadBigInt(
    settlementRevalidation,
    'confirmedExternalFundingUnits',
  );
  const prepayment = BigInt(plan.financing.borrowerDebtPrepaymentUnits);
  if (prepayment > 0n && plan.financing.borrowerDebtPrepaymentEvidenceId === undefined) {
    throw new Error('Borrower debt prepayment is missing finalized evidence.');
  }
  if (externalFunding !== BigInt(plan.financing.confirmedExternalFundingUnits)) {
    throw new Error('Finalized supplementary funding differs from the signed financing structure.');
  }
  const available = requiredBorrow + externalFunding;
  const obligation = principal + fee + capitalized;
  if (available < obligation) {
    throw new Error('Finalized settlement has an unexplained funding shortfall.');
  }
  const residual = available - obligation;
  const originCollateral = unsignedPayloadBigInt(
    transportOrigin.normalizedPayload,
    'amountInUnits',
    true,
  );
  const destinationCollateral = unsignedPayloadBigInt(
    transportDestination.normalizedPayload,
    'amountOutUnits',
    true,
  );
  const suppliedCollateral = unsignedPayloadBigInt(
    targetPosition.normalizedPayload,
    'collateralUnits',
    true,
  );
  if (suppliedCollateral !== destinationCollateral) {
    throw new Error('Target collateral supply does not equal verified destination custody.');
  }

  const reservationProvider = requiredPayloadText(
    reservation.normalizedPayload,
    'recoveryReserveProvider',
  );
  const settlementProvider = requiredPayloadText(settlement.payload, 'recoveryReserveProvider');
  if (reservationProvider.toLowerCase() !== settlementProvider.toLowerCase()) {
    throw new Error('Recovery reserve provider changed before settlement.');
  }
  const recoveryReserveLocked = unsignedPayloadBigInt(
    reservation.normalizedPayload,
    'recoveryReserveUnits',
    true,
  );
  const settlementReserveMaximum = unsignedPayloadBigInt(
    settlement.payload,
    'recoveryReserveMaximumUnits',
    true,
  );
  if (recoveryReserveLocked !== settlementReserveMaximum) {
    throw new Error('Settled recovery reserve differs from the finalized reservation.');
  }
  const recoveryReserveConsumed = principal + fee;
  if (recoveryReserveConsumed > recoveryReserveLocked) {
    throw new Error('Settlement exceeds the isolated recovery reserve.');
  }
  const repayment = unsignedPayloadBigInt(settlement.payload, 'repaymentUnits', true);
  if (repayment !== recoveryReserveConsumed) {
    throw new Error('Settlement receipt does not match the finalized principal and fee.');
  }
  const recoveryReserveRefunded = recoveryReserveLocked - recoveryReserveConsumed;
  const observedAt = requiredPayloadText(settlementRevalidation, 'observedAt');
  const settlementEvidenceId = actionEvidenceId(migrationId, 'LIQUIDITY_SETTLEMENT', settlement);
  const financingEvidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${migrationId}:FINANCING_FEASIBILITY`,
  );
  const reserveAccount = `recovery-reserve:${plan.fundingProvider}:${migrationId}`;
  const entries: LedgerEntry[] = [];
  const append = (input: {
    readonly componentCode: LedgerComponentCode;
    readonly componentId: string;
    readonly evidenceId: Hex;
    readonly basis?: LedgerEntry['basis'];
    readonly chainId: number;
    readonly token: string;
    readonly amountUnits: bigint;
    readonly debitParty: string;
    readonly creditParty: string;
    readonly category: LedgerEntry['category'];
    readonly transactionReference?: string;
  }): void => {
    if (input.amountUnits === 0n) return;
    const sequence = entries.length + 1;
    entries.push(
      ledgerEntrySchema.parse({
        entryId: hashCanonicalText(
          `debtshift.ledger.v1:${migrationId}:${sequence.toString()}:${input.componentId}`,
        ),
        migrationId,
        sequence,
        componentCode: input.componentCode,
        componentId: input.componentId,
        evidenceId: input.evidenceId,
        basis: input.basis ?? 'FINALIZED_MOVEMENT',
        chainId: input.chainId,
        token: input.token,
        amountUnits: input.amountUnits.toString(),
        debitParty: input.debitParty,
        creditParty: input.creditParty,
        category: input.category,
        ...(input.transactionReference === undefined
          ? {}
          : { transactionReference: input.transactionReference }),
        createdAt: observedAt,
      }),
    );
  };

  append({
    componentCode: 'SOURCE_DEBT_PAYOFF',
    componentId: 'source-debt-payoff',
    evidenceId: sourceClose.evidenceId,
    chainId: plan.sourceDebtAsset.chainId,
    token: plan.sourceDebtAsset.address,
    amountUnits: principal,
    debitParty: plan.fundingProvider,
    creditParty: plan.sourceMarket.deployment,
    category: 'PRINCIPAL',
    transactionReference: sourceClose.transactionHash,
  });
  append({
    componentCode: 'BORROWER_DEBT_PREPAYMENT',
    componentId: 'borrower-debt-prepayment',
    evidenceId: plan.financing.borrowerDebtPrepaymentEvidenceId ?? sourceClose.evidenceId,
    chainId: plan.sourceDebtAsset.chainId,
    token: plan.sourceDebtAsset.address,
    amountUnits: prepayment,
    debitParty: plan.borrower,
    creditParty: plan.sourceMarket.deployment,
    category: 'PRINCIPAL',
  });
  for (const cost of plan.financing.costs.filter(
    (component) => component.financingClass === 'SEPARATELY_PAID',
  )) {
    append({
      componentCode: 'SEPARATELY_PAID_COST_CLASSIFICATION',
      componentId: `separately-paid-cost:${cost.componentId}`,
      evidenceId: financingEvidenceId,
      basis: 'SIGNED_COST_CLASSIFICATION',
      chainId: plan.financing.settlementAsset.chainId,
      token: plan.financing.settlementAsset.address,
      amountUnits: BigInt(cost.settlementAmountUnits),
      debitParty: plan.borrower,
      creditParty: `external-cost:${cost.kind}:${cost.componentId}`,
      category: 'COST',
    });
  }
  append({
    componentCode: 'RECOVERY_RESERVE_LOCKED',
    componentId: 'recovery-reserve-locked',
    evidenceId: reservation.evidenceId,
    chainId: plan.sourceDebtAsset.chainId,
    token: plan.sourceDebtAsset.address,
    amountUnits: recoveryReserveLocked,
    debitParty: reservationProvider,
    creditParty: reserveAccount,
    category: 'RESERVE',
    transactionReference: reservation.transactionHash,
  });
  append({
    componentCode: 'TRANSPORT_ORIGIN_COLLATERAL',
    componentId: 'transport-origin-collateral',
    evidenceId: transportOrigin.evidenceId,
    chainId: plan.sourceCollateralAsset.chainId,
    token: plan.sourceCollateralAsset.address,
    amountUnits: originCollateral,
    debitParty: plan.transportRefundReceiver,
    creditParty: plan.transportDepositAddress,
    category: 'COLLATERAL',
    transactionReference: transportOrigin.transactionHash,
  });
  append({
    componentCode: 'TRANSPORT_DESTINATION_COLLATERAL',
    componentId: 'transport-destination-collateral',
    evidenceId: transportDestination.evidenceId,
    chainId: plan.destinationCollateralAsset.chainId,
    token: plan.destinationCollateralAsset.address,
    amountUnits: destinationCollateral,
    debitParty: `transport:${plan.transportProvider}:${transportDestination.providerReference ?? transportDestination.evidenceId}`,
    creditParty: plan.destinationReceiver,
    category: 'COLLATERAL',
    transactionReference: transportDestination.transactionHash,
  });
  append({
    componentCode: 'TARGET_COLLATERAL_SUPPLY',
    componentId: 'target-collateral-supply',
    evidenceId: targetPosition.evidenceId,
    chainId: plan.destinationCollateralAsset.chainId,
    token: plan.destinationCollateralAsset.address,
    amountUnits: suppliedCollateral,
    debitParty: plan.destinationReceiver,
    creditParty: plan.targetMarket.deployment,
    category: 'COLLATERAL',
    transactionReference: targetPosition.transactionHash,
  });
  append({
    componentCode: 'DESTINATION_LOAN_PROCEEDS',
    componentId: 'destination-loan-proceeds',
    evidenceId: targetPosition.evidenceId,
    chainId: plan.payoutAsset.chainId,
    token: plan.payoutAsset.address,
    amountUnits: requiredBorrow,
    debitParty: plan.targetMarket.deployment,
    creditParty: plan.destinationReceiver,
    category: 'PRINCIPAL',
    transactionReference: targetPosition.transactionHash,
  });
  for (const funding of plan.financing.externalFunding) {
    if (funding.escrow.toLowerCase() !== plan.destinationReceiver.toLowerCase()) {
      throw new Error('Supplementary funding is not held by the signed destination escrow.');
    }
    append({
      componentCode: 'SUPPLEMENTARY_SETTLEMENT_FUNDING',
      componentId: `supplementary-funding:${funding.fundingId}`,
      evidenceId: funding.evidenceId,
      chainId: funding.asset.chainId,
      token: funding.asset.address,
      amountUnits: BigInt(funding.amountUnits),
      debitParty: `supplementary-funder:${funding.fundingId}`,
      creditParty: plan.destinationReceiver,
      category: 'PRINCIPAL',
    });
  }
  append({
    componentCode: 'SOLVER_PRINCIPAL_PAYOUT',
    componentId: 'solver-principal-payout',
    evidenceId: targetPosition.evidenceId,
    chainId: plan.payoutAsset.chainId,
    token: plan.payoutAsset.address,
    amountUnits: principal,
    debitParty: plan.destinationReceiver,
    creditParty: plan.payoutReceiver,
    category: 'PRINCIPAL',
    transactionReference: targetPosition.transactionHash,
  });
  append({
    componentCode: 'SOLVER_FEE_PAYOUT',
    componentId: 'solver-fee-payout',
    evidenceId: targetPosition.evidenceId,
    chainId: plan.payoutAsset.chainId,
    token: plan.payoutAsset.address,
    amountUnits: fee,
    debitParty: plan.destinationReceiver,
    creditParty: plan.payoutReceiver,
    category: 'FEE',
    transactionReference: targetPosition.transactionHash,
  });
  append({
    componentCode: 'RESIDUAL_RETURN',
    componentId: 'residual-return',
    evidenceId: targetPosition.evidenceId,
    chainId: plan.payoutAsset.chainId,
    token: plan.payoutAsset.address,
    amountUnits: residual,
    debitParty: plan.destinationReceiver,
    creditParty: plan.refundReceiver,
    category: 'RESIDUAL',
    transactionReference: targetPosition.transactionHash,
  });
  append({
    componentCode: 'RECOVERY_RESERVE_PRINCIPAL_CONSUMED',
    componentId: 'recovery-reserve-principal-consumed',
    evidenceId: settlementEvidenceId,
    chainId: plan.sourceDebtAsset.chainId,
    token: plan.sourceDebtAsset.address,
    amountUnits: principal,
    debitParty: reserveAccount,
    creditParty: plan.fundingProvider,
    category: 'PRINCIPAL',
    transactionReference: settlement.transactionHash,
  });
  append({
    componentCode: 'RECOVERY_RESERVE_FEE_CONSUMED',
    componentId: 'recovery-reserve-fee-consumed',
    evidenceId: settlementEvidenceId,
    chainId: plan.sourceDebtAsset.chainId,
    token: plan.sourceDebtAsset.address,
    amountUnits: fee,
    debitParty: reserveAccount,
    creditParty: plan.fundingProvider,
    category: 'FEE',
    transactionReference: settlement.transactionHash,
  });
  append({
    componentCode: 'RECOVERY_RESERVE_REFUND',
    componentId: 'recovery-reserve-refund',
    evidenceId: settlementEvidenceId,
    chainId: plan.sourceDebtAsset.chainId,
    token: plan.sourceDebtAsset.address,
    amountUnits: recoveryReserveRefunded,
    debitParty: reserveAccount,
    creditParty: settlementProvider,
    category: 'REFUND',
    transactionReference: settlement.transactionHash,
  });

  return ledgerReconciliationSchema.parse({
    version: 1,
    migrationId,
    sourceDebtPayoffUnits: (principal + prepayment).toString(),
    borrowerDebtPrepaymentUnits: prepayment.toString(),
    solverPrincipalUnits: principal.toString(),
    solverFeeUnits: fee.toString(),
    capitalizedCostUnits: capitalized.toString(),
    separatelyPaidCostUnits: separatelyPaid.toString(),
    requiredDestinationBorrowUnits: requiredBorrow.toString(),
    confirmedExternalFundingUnits: externalFunding.toString(),
    recoveryReserveLockedUnits: recoveryReserveLocked.toString(),
    recoveryReserveConsumedUnits: recoveryReserveConsumed.toString(),
    recoveryReserveRefundedUnits: recoveryReserveRefunded.toString(),
    residualReturnUnits: residual.toString(),
    unexplainedImbalanceUnits: '0',
    entries,
  });
}

function actionEvidenceId(
  migrationId: string,
  type: EvidenceType,
  action: FinalizedChainAction,
): Hex {
  return hashCanonicalText(
    `debtshift.evidence.v1:${migrationId}:${type}:${action.transactionHash}`,
  );
}

function requiredEvidence(
  records: readonly Evidence[],
  type: EvidenceType,
): FinalizedTransactionEvidence {
  const record = records.findLast(
    (candidate) => candidate.type === type && candidate.verificationState === 'FINALIZED',
  );
  if (record === undefined)
    throw new Error(`Finalized ${type} evidence is required for the ledger.`);
  if (record.transactionHash === undefined) {
    throw new Error(`${type} evidence is missing its transaction reference.`);
  }
  return record as FinalizedTransactionEvidence;
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is missing.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function unsignedPayloadBigInt(
  payload: Readonly<Record<string, unknown>>,
  field: string,
  positive = false,
): bigint {
  const value = payload[field];
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} is not an unsigned base-unit amount.`);
  }
  const amount = BigInt(value);
  if (positive && amount === 0n) throw new Error(`${field} must be positive.`);
  return amount;
}

function requiredPayloadText(payload: Readonly<Record<string, unknown>>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is not a canonical text value.`);
  }
  return value;
}

function recoveryEvidence(
  context: MigrationExecutionContext,
  observation: TransportObservation,
  reason: string,
  records: readonly Evidence[],
): Evidence {
  const manualReview = reason === 'AMBIGUOUS_CUSTODY_DEADLINE_EXCEEDED';
  const exposure = sourceExposureState(records);
  const payload = recoveryOpeningPayloadSchema.parse({
    reason,
    policy: manualReview
      ? 'MANUAL_CUSTODY_RECONCILIATION'
      : 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
    ...recoveryControl(
      context,
      manualReview ? 'RECONCILE_TRANSPORT_CUSTODY' : 'EXECUTE_SIGNED_RECOVERY',
    ),
    observation,
    residualAssets: [
      {
        kind: 'TRANSPORT_CUSTODY',
        provider: observation.provider,
        providerState: observation.status,
        providerReference: observation.providerReference,
        inputUnits: context.quote.amountInUnits,
        observedOutputUnits: observation.observedAmountOutUnits,
        destinationTransactionHash: observation.destinationTransactionHash,
        refundTransactionHash: observation.refundTransactionHash,
        disposition: manualReview
          ? 'DIRECT_PROVIDER_AND_CHAIN_RECONCILIATION_REQUIRED'
          : 'VERIFIED_CUSTODY_ELIGIBLE_FOR_SIGNED_RECOVERY',
      },
      ...sourceExposureResidualAssets(context, exposure),
    ],
  });
  const evidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${context.migration.migrationId}:RECOVERY_OPENED:${reason}`,
  );
  return evidenceSchema.parse({
    evidenceId,
    migrationId: context.migration.migrationId,
    type: 'RECOVERY_OPENED',
    schemaVersion: 1,
    provider: 'DEBTSHIFT_POLICY_ENGINE',
    network: 'debtshift:workflow',
    providerReference: evidenceId,
    rawObservationHash: observation.rawObservationHash,
    normalizedPayload: payload,
    observedAt: observation.observedAt,
    verificationState: 'FINALIZED',
    verificationMethod: 'DETERMINISTIC_RECOVERY_POLICY',
    verifierVersion: 'debtshift-worker-v1',
  });
}

function capacityDeteriorationRecoveryEvidence(
  context: MigrationExecutionContext,
  action: FinalizedChainAction,
): Evidence {
  const reason = 'DESTINATION_CAPACITY_DETERIORATED_AFTER_SOURCE_CLOSE';
  const payload = recoveryOpeningPayloadSchema.parse({
    ...action.payload,
    reason,
    ...recoveryControl(context, 'EXECUTE_SIGNED_RECOVERY'),
  });
  const evidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${context.migration.migrationId}:RECOVERY_OPENED:${reason}:${action.transactionHash}`,
  );
  return evidenceSchema.parse({
    evidenceId,
    migrationId: context.migration.migrationId,
    type: 'RECOVERY_OPENED',
    schemaVersion: 1,
    provider: 'DEBTSHIFT_POLICY_ENGINE',
    network: `eip155:${action.chainId.toString()}`,
    chainId: action.chainId,
    blockNumber: action.blockNumber,
    blockHash: action.blockHash,
    transactionHash: action.transactionHash,
    providerReference: evidenceId,
    rawObservationHash: hashCanonicalText(canonicalJson(payload)),
    normalizedPayload: payload,
    observedAt: new Date().toISOString(),
    verificationState: 'FINALIZED',
    verificationMethod: 'FAILED_FEASIBILITY_RECEIPT_AND_RECOVERY_POLICY',
    verifierVersion: 'debtshift-worker-v1',
  });
}

interface SourceExposureState {
  readonly reservation: FinalizedTransactionEvidence;
  readonly sourceClose: FinalizedTransactionEvidence;
  readonly principal: bigint;
  readonly fee: bigint;
  readonly reserveUnits: bigint;
  readonly reserveProvider: string;
}

function sourceExposureState(records: readonly Evidence[]): SourceExposureState {
  const reservation = requiredEvidence(records, 'LIQUIDITY_RESERVATION');
  const sourceClose = requiredEvidence(records, 'SOURCE_CLOSE');
  const financing = requiredRecord(
    sourceClose.normalizedPayload.financingRevalidation,
    'source-close financing revalidation',
  );
  return {
    reservation,
    sourceClose,
    principal: unsignedPayloadBigInt(financing, 'solverPrincipalUnits', true),
    fee: unsignedPayloadBigInt(financing, 'solverFeeUnits'),
    reserveUnits: unsignedPayloadBigInt(
      reservation.normalizedPayload,
      'recoveryReserveUnits',
      true,
    ),
    reserveProvider: requiredPayloadText(reservation.normalizedPayload, 'recoveryReserveProvider'),
  };
}

function sourceExposureResidualAssets(
  context: MigrationExecutionContext,
  exposure: SourceExposureState,
): readonly Record<string, unknown>[] {
  return [
    {
      kind: 'SOLVER_RECEIVABLE',
      chainId: context.signedPlan.plan.sourceDebtAsset.chainId,
      token: context.signedPlan.plan.sourceDebtAsset.address,
      principalUnits: exposure.principal.toString(),
      feeUnits: exposure.fee.toString(),
      totalClaimUnits: (exposure.principal + exposure.fee).toString(),
      disposition: 'UNSETTLED_EXPLICIT_CLAIM',
    },
    {
      kind: 'RECOVERY_RESERVE',
      chainId: context.signedPlan.plan.sourceDebtAsset.chainId,
      token: context.signedPlan.plan.sourceDebtAsset.address,
      provider: exposure.reserveProvider,
      lockedUnits: exposure.reserveUnits.toString(),
      disposition: 'LOCKED_PENDING_MANUAL_RECONCILIATION',
    },
  ];
}

function transportDispatchRetryBudgetRecoveryEvidence(
  context: MigrationExecutionContext,
  provider: string,
  records: readonly Evidence[],
): Evidence {
  const exposure = sourceExposureState(records);
  return retryBudgetRecoveryEvidence(
    context,
    provider,
    'TRANSPORT_DISPATCH_RETRY_BUDGET_EXHAUSTED',
    'MANUAL_CUSTODY_RECONCILIATION',
    'RECONCILE_TRANSPORT_CUSTODY',
    [
      {
        kind: 'TRANSPORT_COLLATERAL',
        chainId: context.quote.inputAsset.chainId,
        token: context.quote.inputAsset.address,
        amountUnits: context.quote.amountInUnits,
        intendedDepositAddress: context.quote.depositAddress,
        refundReceiver: context.quote.refundReceiver,
        custodyState: 'ORIGIN_DISPATCH_UNCONFIRMED',
        disposition: 'DIRECT_PROVIDER_AND_CHAIN_RECONCILIATION_REQUIRED',
      },
      ...sourceExposureResidualAssets(context, exposure),
    ],
    [exposure.reservation.evidenceId, exposure.sourceClose.evidenceId],
    {
      transportProvider: context.quote.provider,
      transportQuoteHash: context.quote.quoteHash,
    },
  );
}

function transportObservationRetryBudgetRecoveryEvidence(
  context: MigrationExecutionContext,
  provider: string,
  records: readonly Evidence[],
): Evidence {
  const exposure = sourceExposureState(records);
  const origin = requiredEvidence(records, 'TRANSPORT_ORIGIN');
  return retryBudgetRecoveryEvidence(
    context,
    provider,
    'TRANSPORT_RETRY_BUDGET_EXHAUSTED',
    'MANUAL_CUSTODY_RECONCILIATION',
    'RECONCILE_TRANSPORT_CUSTODY',
    [
      {
        kind: 'TRANSPORT_CUSTODY',
        provider: context.transportLeg.provider,
        providerState: context.transportLeg.providerState,
        providerReference: context.transportLeg.providerReference,
        inputUnits: context.transportLeg.inputUnits,
        observedOutputUnits: context.transportLeg.observedOutputUnits,
        originTransactionHash: context.transportLeg.originTransactionHash,
        disposition: 'DIRECT_PROVIDER_AND_CHAIN_RECONCILIATION_REQUIRED',
      },
      ...sourceExposureResidualAssets(context, exposure),
    ],
    [exposure.reservation.evidenceId, exposure.sourceClose.evidenceId, origin.evidenceId],
  );
}

function targetOpenRetryBudgetRecoveryEvidence(
  context: MigrationExecutionContext,
  provider: string,
  records: readonly Evidence[],
): Evidence {
  const exposure = sourceExposureState(records);
  const destination = requiredEvidence(records, 'TRANSPORT_DESTINATION');
  const collateral = unsignedPayloadBigInt(destination.normalizedPayload, 'amountOutUnits', true);
  return retryBudgetRecoveryEvidence(
    context,
    provider,
    'TARGET_OPEN_RETRY_BUDGET_EXHAUSTED',
    'MANUAL_TARGET_AND_PAYOUT_RECONCILIATION',
    'RECONCILE_TARGET_AND_PAYOUT',
    [
      {
        kind: 'DESTINATION_COLLATERAL',
        chainId: context.signedPlan.plan.destinationCollateralAsset.chainId,
        token: context.signedPlan.plan.destinationCollateralAsset.address,
        amountUnits: collateral.toString(),
        lastVerifiedCustody: context.signedPlan.plan.destinationReceiver,
        disposition: 'DIRECT_CHAIN_RECONCILIATION_REQUIRED',
      },
      ...sourceExposureResidualAssets(context, exposure),
    ],
    [exposure.reservation.evidenceId, exposure.sourceClose.evidenceId, destination.evidenceId],
    {
      targetAndPayoutState: 'UNCONFIRMED',
      atomicityRule:
        'TARGET_OPEN_AND_SOLVER_PAYOUT_SHARE_ONE_DESTINATION_TRANSACTION_OR_REVERT_TOGETHER',
    },
  );
}

function settlementRetryBudgetRecoveryEvidence(
  context: MigrationExecutionContext,
  provider: string,
  records: readonly Evidence[],
): Evidence {
  const exposure = sourceExposureState(records);
  const target = requiredEvidence(records, 'TARGET_POSITION');
  const financing = requiredRecord(
    target.normalizedPayload.financingRevalidation,
    'target financing revalidation',
  );
  const principal = unsignedPayloadBigInt(financing, 'solverPrincipalUnits', true);
  const fee = unsignedPayloadBigInt(financing, 'solverFeeUnits');
  if (principal !== exposure.principal || fee !== exposure.fee) {
    throw new Error('Finalized target payout differs from the source solver receivable.');
  }
  const destinationBorrow = unsignedPayloadBigInt(
    financing,
    'requiredDestinationBorrowUnits',
    true,
  );
  const targetCollateral = unsignedPayloadBigInt(target.normalizedPayload, 'collateralUnits', true);
  return retryBudgetRecoveryEvidence(
    context,
    provider,
    'SETTLEMENT_RETRY_BUDGET_EXHAUSTED',
    'MANUAL_SETTLEMENT_RECONCILIATION',
    'RECONCILE_SETTLEMENT',
    [
      ...sourceExposureResidualAssets(context, exposure).map((asset) =>
        asset.kind === 'SOLVER_RECEIVABLE' ? { ...asset, kind: 'SOURCE_VAULT_RECEIVABLE' } : asset,
      ),
      {
        kind: 'TARGET_POSITION',
        chainId: context.signedPlan.plan.targetMarket.chainId,
        market: context.signedPlan.plan.targetMarket.deployment,
        collateralUnits: targetCollateral.toString(),
        debtUnits: destinationBorrow.toString(),
        solverPayoutUnits: (principal + fee).toString(),
        disposition: 'FINALIZED_ATOMIC_TARGET_AND_PAYOUT_RECEIPT',
      },
    ],
    [exposure.reservation.evidenceId, exposure.sourceClose.evidenceId, target.evidenceId],
    {
      payoutReceiver: context.signedPlan.plan.payoutReceiver,
      payoutAsset: context.signedPlan.plan.payoutAsset,
      targetTransactionHash: target.transactionHash,
    },
  );
}

function retryBudgetRecoveryEvidence(
  context: MigrationExecutionContext,
  provider: string,
  reason: string,
  policy: RecoveryPolicy,
  nextPermittedAction: Exclude<RecoveryNextPermittedAction, 'EXECUTE_SIGNED_RECOVERY'>,
  residualAssets: readonly Record<string, unknown>[],
  supportingEvidenceIds: readonly string[],
  details: Record<string, unknown> = {},
): Evidence {
  const payload = recoveryOpeningPayloadSchema.parse({
    reason,
    policy,
    ...recoveryControl(context, nextPermittedAction),
    failedCommandRetryBudget: 'EXHAUSTED',
    supportingEvidenceIds: [...supportingEvidenceIds].sort(),
    residualAssets,
    ...details,
  });
  const evidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${context.migration.migrationId}:RECOVERY_OPENED:${reason}`,
  );
  return evidenceSchema.parse({
    evidenceId,
    migrationId: context.migration.migrationId,
    type: 'RECOVERY_OPENED',
    schemaVersion: 1,
    provider,
    network: 'debtshift:workflow',
    providerReference: evidenceId,
    rawObservationHash: hashCanonicalText(canonicalJson(payload)),
    normalizedPayload: payload,
    observedAt: new Date().toISOString(),
    verificationState: 'FINALIZED',
    verificationMethod: 'RETRY_BUDGET_AND_DURABLE_STATE_RECONCILIATION',
    verifierVersion: 'debtshift-worker-v1',
  });
}

function recoveryExecutionRetryBudgetEscalationEvidence(
  context: MigrationExecutionContext,
  provider: string,
  records: readonly Evidence[],
): Evidence {
  const exposure = sourceExposureState(records);
  const destination = records.find(({ type }) => type === 'TRANSPORT_DESTINATION');
  const residualAssets: Record<string, unknown>[] = [
    ...sourceExposureResidualAssets(context, exposure),
  ];
  if (destination !== undefined) {
    residualAssets.unshift({
      kind: 'DESTINATION_COLLATERAL',
      chainId: context.signedPlan.plan.destinationCollateralAsset.chainId,
      token: context.signedPlan.plan.destinationCollateralAsset.address,
      amountUnits: requiredPayloadText(destination.normalizedPayload, 'amountOutUnits'),
      lastVerifiedCustody: context.signedPlan.plan.destinationReceiver,
      disposition: 'DIRECT_CHAIN_RECONCILIATION_REQUIRED',
    });
  }
  return retryBudgetRecoveryEvidence(
    context,
    provider,
    'AUTOMATED_RECOVERY_RETRY_BUDGET_EXHAUSTED',
    'MANUAL_RECOVERY_EXECUTION_RECONCILIATION',
    'RECONCILE_RECOVERY_EXECUTION',
    residualAssets,
    records.map(({ evidenceId }) => evidenceId),
  );
}

function recoveryControl(
  context: MigrationExecutionContext,
  nextPermittedAction: RecoveryNextPermittedAction,
): {
  readonly requiresManualReview: boolean;
  readonly nextPermittedAction: RecoveryNextPermittedAction;
  readonly actionDeadline: string;
  readonly escalationOwner: string;
  readonly escalationState: 'AUTOMATED_RECOVERY_PENDING' | 'MANUAL_REVIEW_REQUIRED';
} {
  const automatic = nextPermittedAction === 'EXECUTE_SIGNED_RECOVERY';
  const deadlineMilliseconds = Number(BigInt(context.signedPlan.plan.deadline) * 1_000n);
  const actionDeadline = new Date(deadlineMilliseconds);
  if (Number.isNaN(actionDeadline.valueOf())) {
    throw new Error('Signed recovery deadline cannot be represented as a timestamp.');
  }
  return {
    requiresManualReview: !automatic,
    nextPermittedAction,
    actionDeadline: actionDeadline.toISOString(),
    escalationOwner: automatic ? 'DEBTSHIFT_WORKER' : 'DEBTSHIFT_OPERATIONS',
    escalationState: automatic ? 'AUTOMATED_RECOVERY_PENDING' : 'MANUAL_REVIEW_REQUIRED',
  };
}

function expirationEvidence(
  context: MigrationExecutionContext,
  observation: TransportObservation,
  reason: string,
): Evidence {
  const evidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${context.migration.migrationId}:MIGRATION_EXPIRED:${reason}`,
  );
  return evidenceSchema.parse({
    evidenceId,
    migrationId: context.migration.migrationId,
    type: 'MIGRATION_EXPIRED',
    schemaVersion: 1,
    provider: 'DEBTSHIFT_DEADLINE_POLICY',
    network: 'debtshift:workflow',
    providerReference: evidenceId,
    rawObservationHash: observation.rawObservationHash,
    normalizedPayload: { reason, deadline: context.signedPlan.plan.deadline, observation },
    observedAt: observation.observedAt,
    verificationState: 'FINALIZED',
    verificationMethod: 'SIGNED_DEADLINE_AND_PROVIDER_STATE',
    verifierVersion: 'debtshift-worker-v1',
  });
}

interface PreSourceExpiration {
  readonly reason: 'SIGNED_EXECUTION_DEADLINE_EXCEEDED' | 'TRANSPORT_QUOTE_EXPIRED';
  readonly observedAt: string;
}

function preSourceExpiration(
  context: MigrationExecutionContext,
  observedAtMilliseconds: number,
): PreSourceExpiration | undefined {
  const observedAtSeconds = BigInt(Math.floor(observedAtMilliseconds / 1_000));
  const reason =
    observedAtSeconds > BigInt(context.signedPlan.plan.deadline)
      ? 'SIGNED_EXECUTION_DEADLINE_EXCEEDED'
      : observedAtMilliseconds >= Date.parse(context.quote.expiresAt)
        ? 'TRANSPORT_QUOTE_EXPIRED'
        : undefined;
  if (reason === undefined) return undefined;
  return { reason, observedAt: new Date(observedAtMilliseconds).toISOString() };
}

function preReservationExpirationEvidence(
  context: MigrationExecutionContext,
  expiration: PreSourceExpiration,
): Evidence {
  const payload = {
    reason: expiration.reason,
    deadline: context.signedPlan.plan.deadline,
    quoteExpiresAt: context.quote.expiresAt,
    sourcePosition: { disposition: 'NOT_TOUCHED_BY_DEBTSHIFT' },
    reservation: { disposition: 'NOT_COMMITTED' },
  };
  const evidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${context.migration.migrationId}:MIGRATION_EXPIRED:${expiration.reason}`,
  );
  return evidenceSchema.parse({
    evidenceId,
    migrationId: context.migration.migrationId,
    type: 'MIGRATION_EXPIRED',
    schemaVersion: 1,
    provider: 'DEBTSHIFT_DEADLINE_POLICY',
    network: 'debtshift:workflow',
    providerReference: evidenceId,
    rawObservationHash: hashCanonicalText(canonicalJson(payload)),
    normalizedPayload: payload,
    observedAt: expiration.observedAt,
    verificationState: 'FINALIZED',
    verificationMethod: 'SIGNED_DEADLINE_AND_PERSISTED_QUOTE',
    verifierVersion: 'debtshift-worker-v1',
  });
}

function isPastExecutionDeadline(context: MigrationExecutionContext, observedAt: string): boolean {
  return (
    BigInt(Math.floor(Date.parse(observedAt) / 1000)) > BigInt(context.signedPlan.plan.deadline)
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, current: unknown) =>
    typeof current === 'bigint' ? current.toString() : current,
  );
}

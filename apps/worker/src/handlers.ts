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
  type Evidence,
  type EvidenceType,
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

export interface MigrationExecutionPort {
  verifyCanonicalEvidence(
    records: readonly Evidence[],
  ): Promise<readonly ChainCanonicalityFailure[]>;
  reserve(context: MigrationExecutionContext): Promise<FinalizedChainAction>;
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
  finalize(context: MigrationExecutionContext): Promise<Evidence>;
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
}

export function createWorkflowHandlers({
  store,
  execution,
  transport,
  registry,
  evidenceProviders,
}: WorkflowHandlerDependencies): ReadonlyMap<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    [
      'RESERVE_LIQUIDITY',
      handler(store, execution, async (context) => {
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
      'CLOSE_SOURCE',
      handler(store, execution, async (context) => {
        let action: FinalizedChainAction;
        try {
          action = await execution.closeSource(context);
        } catch (error) {
          if (!(error instanceof PreSourceCapacityDeteriorationError)) throw error;
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
      handler(store, execution, async (context) => {
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
      }),
    ],
    [
      'VERIFY_DESTINATION',
      handler(store, execution, async (context) => {
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
            return [
              expirationEvidence(context, observation, 'TRANSPORT_DEADLINE_EXCEEDED'),
              recoveryEvidence(context, observation, 'TRANSPORT_DEADLINE_EXCEEDED'),
            ];
          }
          throw new RetryableCommandError(`Transport remains ${observation.status}.`);
        }
        if (observation.status === 'SUCCESS') {
          const verification = verifyTransportDelivery(context.quote, observation);
          if (!verification.valid) {
            return [recoveryEvidence(context, observation, verification.failures.join(','))];
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
          return [recoveryEvidence(context, observation, 'TRANSPORT_REFUNDED')];
        }
        if (
          observation.status === 'INCOMPLETE_DEPOSIT' ||
          observation.status === 'FAILED_KNOWN_CUSTODY'
        ) {
          return [recoveryEvidence(context, observation, observation.status)];
        }
        throw new RetryableCommandError(`Transport custody is ambiguous: ${observation.status}.`);
      }),
    ],
    [
      'OPEN_TARGET',
      handler(store, execution, async (context) => {
        let action: FinalizedChainAction;
        try {
          action = await execution.openTarget(context);
        } catch (error) {
          if (!(error instanceof PostSourceCapacityDeteriorationError)) throw error;
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
      }),
    ],
    [
      'SETTLE_LIQUIDITY',
      handler(store, execution, async (context) => {
        const action = await execution.settleLiquidity(context);
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
          chainEvidence(
            context.migration.migrationId,
            'LEDGER_RECONCILIATION',
            evidenceProviders.ledger,
            action,
          ),
        ];
      }),
    ],
    [
      'FINALIZE_NEAR_RECEIPT',
      handler(store, execution, async (context) => [await registry.finalize(context)]),
    ],
    [
      'EXECUTE_RECOVERY',
      handler(
        store,
        execution,
        async (context) => [
          chainEvidence(
            context.migration.migrationId,
            'RECOVERY_COMPLETED',
            evidenceProviders.recovery,
            await execution.executeRecovery(context, 'POLICY_SELECTED_RECOVERY'),
          ),
        ],
        false,
      ),
    ],
  ]);
}

function handler(
  store: WorkflowContextStore,
  execution: MigrationExecutionPort,
  execute: (context: MigrationExecutionContext) => Promise<readonly Evidence[]>,
  checkCanonicality = true,
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
  const outcomePayload = {
    reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
    policy:
      outcomeType === 'RECOVERY_OPENED'
        ? 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION'
        : 'DISCARD_ORPHANED_PLAN_AND_REQUOTE',
    requiresManualReview: outcomeType === 'RECOVERY_OPENED',
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

function recoveryEvidence(
  context: MigrationExecutionContext,
  observation: TransportObservation,
  reason: string,
): Evidence {
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
    normalizedPayload: { reason, observation },
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
  const payload = { ...action.payload, reason };
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

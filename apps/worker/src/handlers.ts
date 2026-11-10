import {
  getMigrationExecutionContext,
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
} from '@debtshift/domain';
import {
  verifyTransportDelivery,
  verifyTransportRefund,
  type DeterministicTransportSimulator,
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

export interface MigrationExecutionPort {
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

export interface WorkflowContextStore {
  get(migrationId: string): Promise<MigrationExecutionContext>;
  updateTransport(migrationId: string, update: TransportLegStateUpdate): Promise<void>;
}

export class PostgresWorkflowContextStore implements WorkflowContextStore {
  constructor(private readonly database: DebtShiftDatabase) {}

  async get(migrationId: string): Promise<MigrationExecutionContext> {
    const context = await getMigrationExecutionContext(this.database, migrationId);
    if (context === undefined) throw new Error(`Migration context ${migrationId} was not found.`);
    return context;
  }

  updateTransport(migrationId: string, update: TransportLegStateUpdate): Promise<void> {
    return updateTransportLegState(this.database, migrationId, update);
  }
}

export function createSimulatedWorkflowHandlers(
  store: WorkflowContextStore,
  execution: MigrationExecutionPort,
  simulator: DeterministicTransportSimulator,
): ReadonlyMap<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    [
      'RESERVE_LIQUIDITY',
      handler(store, async (context) => {
        const action = await execution.reserve(context);
        return [
          chainEvidence(
            context.migration.migrationId,
            'FINANCING_REVALIDATION',
            'DEBTSHIFT_RISK_VALIDATOR',
            action,
          ),
          chainEvidence(
            context.migration.migrationId,
            'LIQUIDITY_RESERVATION',
            'LOCAL_TEST_VAULT',
            action,
          ),
        ];
      }),
    ],
    [
      'CLOSE_SOURCE',
      handler(store, async (context) => {
        const action = await execution.closeSource(context);
        return [
          chainEvidence(
            context.migration.migrationId,
            'FINANCING_REVALIDATION',
            'DEBTSHIFT_RISK_VALIDATOR',
            action,
          ),
          chainEvidence(
            context.migration.migrationId,
            'SOURCE_CLOSE',
            'LOCAL_SOURCE_ADAPTER',
            action,
          ),
        ];
      }),
    ],
    [
      'DISPATCH_TRANSPORT',
      handler(store, async (context) => {
        const action = await execution.dispatchTransport(context);
        restoreSimulator(simulator, context);
        const providerReference = await simulator.submitOrigin({
          quoteHash: context.quote.quoteHash as Hex,
          originTransactionHash: action.transactionHash,
        });
        await store.updateTransport(context.migration.migrationId, {
          providerState: 'PROCESSING',
          providerReference,
          originTransactionHash: action.transactionHash,
          observationCount: simulator.getState(providerReference).pollCount,
        });
        return [
          chainEvidence(
            context.migration.migrationId,
            'TRANSPORT_ORIGIN',
            'DEBTSHIFT_SIMULATOR',
            action,
          ),
        ];
      }),
    ],
    [
      'VERIFY_DESTINATION',
      handler(store, async (context) => {
        restoreSimulator(simulator, context);
        const providerReference = context.transportLeg.providerReference ?? context.quote.quoteId;
        const observation = await simulator.getStatus(providerReference);
        const state = simulator.getState(providerReference);
        await store.updateTransport(context.migration.migrationId, {
          providerState: observation.status,
          providerReference,
          observationCount: state.pollCount,
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
              'DEBTSHIFT_SIMULATOR',
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
      handler(store, async (context) => {
        const action = await execution.openTarget(context);
        return [
          chainEvidence(
            context.migration.migrationId,
            'FINANCING_REVALIDATION',
            'DEBTSHIFT_RISK_VALIDATOR',
            action,
          ),
          chainEvidence(
            context.migration.migrationId,
            'TARGET_POSITION',
            'LOCAL_TARGET_ADAPTER',
            action,
          ),
        ];
      }),
    ],
    [
      'SETTLE_LIQUIDITY',
      handler(store, async (context) => {
        const action = await execution.settleLiquidity(context);
        return [
          chainEvidence(
            context.migration.migrationId,
            'FINANCING_REVALIDATION',
            'DEBTSHIFT_RISK_VALIDATOR',
            action,
          ),
          chainEvidence(
            context.migration.migrationId,
            'LIQUIDITY_SETTLEMENT',
            'LOCAL_TEST_VAULT',
            action,
          ),
          chainEvidence(
            context.migration.migrationId,
            'LEDGER_RECONCILIATION',
            'DEBTSHIFT_LEDGER',
            action,
          ),
        ];
      }),
    ],
    [
      'FINALIZE_NEAR_RECEIPT',
      {
        execute: async () => {
          throw new RetryableCommandError('NEAR receipt finalization is not enabled before M7.');
        },
      },
    ],
    [
      'EXECUTE_RECOVERY',
      handler(store, async (context) => [
        chainEvidence(
          context.migration.migrationId,
          'RECOVERY_COMPLETED',
          'LOCAL_RECOVERY',
          await execution.executeRecovery(context, 'POLICY_SELECTED_RECOVERY'),
        ),
      ]),
    ],
  ]);
}

function handler(
  store: WorkflowContextStore,
  execute: (context: MigrationExecutionContext) => Promise<readonly Evidence[]>,
): CommandHandler {
  return {
    execute: async (command: DurableCommand) => execute(await store.get(command.migrationId)),
  };
}

function restoreSimulator(
  simulator: DeterministicTransportSimulator,
  context: MigrationExecutionContext,
): void {
  simulator.restoreQuote(context.quote, {
    pollCount: context.transportLeg.observationCount,
    ...(context.transportLeg.originTransactionHash === null
      ? {}
      : { originTransactionHash: context.transportLeg.originTransactionHash as Hex }),
  });
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

import type {
  DurableCommand,
  MigrationExecutionContext,
  TransportLegStateUpdate,
} from '@debtshift/database';
import { evidenceSchema, type Evidence } from '@debtshift/domain';
import { DeterministicTransportSimulator, transportQuoteRequestSchema } from '@debtshift/intents';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkflowHandlers,
  PostSourceCapacityDeteriorationError,
  PreSourceCapacityDeteriorationError,
  type FinalizedChainAction,
  type MigrationExecutionPort,
  type WorkflowContextStore,
} from './handlers.js';
import { RetryableCommandError, type CommandHandler } from './processor.js';
import {
  PendingSandboxRegistryPort,
  sandboxEvidenceProviders,
  SimulatedTransportExecutionPort,
} from './sandbox/simulated-transport.js';

const MIGRATION_ID = `0x${'11'.repeat(32)}` as const;
const ORIGIN_TRANSACTION = `0x${'22'.repeat(32)}` as const;
const ACTION_TRANSACTION = `0x${'33'.repeat(32)}` as const;
const BLOCK_HASH = `0x${'44'.repeat(32)}` as const;
const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa' as const;
const DESTINATION_ESCROW = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9' as const;

class MemoryContextStore implements WorkflowContextStore {
  readonly updates: TransportLegStateUpdate[] = [];
  readonly chainEvidence: Evidence[] = [];

  constructor(public context: MigrationExecutionContext) {}

  async get(): Promise<MigrationExecutionContext> {
    return this.context;
  }

  async listActiveFinalizedChainEvidence(): Promise<readonly Evidence[]> {
    return this.chainEvidence;
  }

  async updateTransport(_migrationId: string, update: TransportLegStateUpdate): Promise<void> {
    this.updates.push(update);
    this.context = {
      ...this.context,
      transportLeg: { ...this.context.transportLeg, ...update, updatedAt: new Date() },
    };
  }
}

describe('simulated workflow handlers', () => {
  it('persists transport submission state before emitting origin evidence', async () => {
    const simulator = new DeterministicTransportSimulator({ processingPolls: 0 });
    const context = await buildContext(simulator, false);
    const store = new MemoryContextStore(context);
    const execution = fakeExecution();
    const handlers = createSandboxWorkflowHandlers(store, execution, simulator);

    const records = await getHandler(handlers, 'DISPATCH_TRANSPORT').execute(
      command('DISPATCH_TRANSPORT'),
    );

    expect(execution.dispatchTransport).toHaveBeenCalledOnce();
    expect(store.updates).toEqual([
      expect.objectContaining({
        providerState: 'PROCESSING',
        originTransactionHash: ACTION_TRANSACTION,
        observationCount: 0,
      }),
    ]);
    expect(records.map((record) => record.type)).toEqual(['TRANSPORT_ORIGIN']);
  });

  it('restores persisted poll state after restart and delivers the observed amount', async () => {
    const firstSimulator = new DeterministicTransportSimulator({
      processingPolls: 1,
      outcome: 'SUCCESS',
    });
    const context = await buildContext(firstSimulator, true);
    const store = new MemoryContextStore(context);
    const firstExecution = fakeExecution();
    const firstHandlers = createSandboxWorkflowHandlers(store, firstExecution, firstSimulator);

    await expect(
      getHandler(firstHandlers, 'VERIFY_DESTINATION').execute(command('VERIFY_DESTINATION')),
    ).rejects.toBeInstanceOf(RetryableCommandError);
    expect(store.context.transportLeg.observationCount).toBe(1);

    const restartedSimulator = new DeterministicTransportSimulator({
      processingPolls: 1,
      outcome: 'SUCCESS',
    });
    const restartedExecution = fakeExecution();
    const restartedHandlers = createSandboxWorkflowHandlers(
      store,
      restartedExecution,
      restartedSimulator,
    );
    const records = await getHandler(restartedHandlers, 'VERIFY_DESTINATION').execute(
      command('VERIFY_DESTINATION'),
    );

    expect(restartedExecution.deliverDestination).toHaveBeenCalledOnce();
    expect(store.context.transportLeg.observedOutputUnits).toBe('9890100000000000000');
    expect(records.map((record) => record.type)).toEqual(['TRANSPORT_DESTINATION']);
  });

  it('opens deterministic recovery only after a valid simulated refund observation', async () => {
    const simulator = new DeterministicTransportSimulator({
      processingPolls: 0,
      outcome: 'REFUNDED',
    });
    const context = await buildContext(simulator, true);
    const store = new MemoryContextStore(context);
    const execution = fakeExecution();
    const handlers = createSandboxWorkflowHandlers(store, execution, simulator);

    const records = await getHandler(handlers, 'VERIFY_DESTINATION').execute(
      command('VERIFY_DESTINATION'),
    );

    expect(execution.deliverDestination).not.toHaveBeenCalled();
    expect(records.map((record) => record.type)).toEqual(['RECOVERY_OPENED']);
    expect(store.updates[0]).toEqual(
      expect.objectContaining({
        providerState: 'REFUNDED',
        observedOutputUnits: '9900000000000000000',
      }),
    );
  });

  it('enters recovery when known simulator custody remains past the signed deadline', async () => {
    const simulator = new DeterministicTransportSimulator({
      processingPolls: 100,
      now: () => 2_000_000_000_000,
    });
    const context = await buildContext(simulator, true, '1900000000');
    const store = new MemoryContextStore(context);
    const execution = fakeExecution();
    const handlers = createSandboxWorkflowHandlers(store, execution, simulator);

    const records = await getHandler(handlers, 'VERIFY_DESTINATION').execute(
      command('VERIFY_DESTINATION'),
    );

    expect(execution.deliverDestination).not.toHaveBeenCalled();
    expect(records.map((record) => record.type)).toEqual(['MIGRATION_EXPIRED', 'RECOVERY_OPENED']);
  });

  it('emits both settlement and reconciliation evidence from one finalized action', async () => {
    const simulator = new DeterministicTransportSimulator();
    const store = new MemoryContextStore(await buildContext(simulator, true));
    const handlers = createSandboxWorkflowHandlers(store, fakeExecution(), simulator);

    const records = await getHandler(handlers, 'SETTLE_LIQUIDITY').execute(
      command('SETTLE_LIQUIDITY'),
    );

    expect(records.map((record) => record.type)).toEqual([
      'FINANCING_REVALIDATION',
      'LIQUIDITY_SETTLEMENT',
      'LEDGER_RECONCILIATION',
    ]);
  });

  it('halts the next side effect and emits append-only retractions for orphaned evidence', async () => {
    const simulator = new DeterministicTransportSimulator();
    const store = new MemoryContextStore(await buildContext(simulator, true));
    const originalEvidence = evidenceSchema.parse({
      evidenceId: `0x${'90'.repeat(32)}`,
      migrationId: MIGRATION_ID,
      type: 'TRANSPORT_ORIGIN',
      schemaVersion: 1,
      provider: 'DEBTSHIFT_SIMULATOR',
      network: 'eip155:31337',
      chainId: 31_337,
      blockNumber: '100',
      blockHash: BLOCK_HASH,
      transactionHash: ORIGIN_TRANSACTION,
      rawObservationHash: `0x${'91'.repeat(32)}`,
      normalizedPayload: {},
      observedAt: '2026-11-11T00:00:00.000Z',
      verificationState: 'FINALIZED',
      verificationMethod: 'RECEIPT_AND_STATE',
      verifierVersion: 'debtshift-worker-v1',
    });
    store.chainEvidence.push(originalEvidence);
    const execution = fakeExecution();
    vi.mocked(execution.verifyCanonicalEvidence).mockResolvedValue([
      {
        evidence: originalEvidence,
        reason: 'CANONICAL_BLOCK_HASH_MISMATCH',
        observedAt: '2026-11-11T00:01:00.000Z',
        requiredConfirmations: 12,
        observedTipBlockNumber: '120',
        observedBlockHash: `0x${'92'.repeat(32)}`,
      },
    ]);
    const handlers = createSandboxWorkflowHandlers(store, execution, simulator);

    const records = await getHandler(handlers, 'VERIFY_DESTINATION').execute(
      command('VERIFY_DESTINATION'),
    );

    expect(execution.deliverDestination).not.toHaveBeenCalled();
    expect(records.map(({ type }) => type)).toEqual(['RECOVERY_OPENED', 'TRANSPORT_ORIGIN']);
    expect(records[0]).toEqual(
      expect.objectContaining({
        verificationState: 'FINALIZED',
        normalizedPayload: expect.objectContaining({
          reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
          requiresManualReview: true,
        }),
      }),
    );
    expect(records[1]).toEqual(
      expect.objectContaining({
        verificationState: 'RETRACTED',
        supersedesEvidenceId: originalEvidence.evidenceId,
      }),
    );
  });

  it('turns finalized post-source capacity failure into revalidation and recovery evidence', async () => {
    const simulator = new DeterministicTransportSimulator();
    const store = new MemoryContextStore(await buildContext(simulator, true));
    const failedAction: FinalizedChainAction = {
      ...action(),
      payload: {
        action: 'recordCapacityDeterioration',
        policy: 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
        financingRevalidation: {
          checkpoint: 'BEFORE_TARGET_BORROW',
          fundingShortfallUnits: '960909091',
        },
        residualAssets: [
          { kind: 'COLLATERAL_CUSTODY', amountUnits: '9890100000000000000' },
          { kind: 'SOLVER_RECEIVABLE', totalClaimUnits: '10050000000' },
        ],
      },
    };
    const execution: MigrationExecutionPort = {
      ...fakeExecution(),
      openTarget: vi.fn(async () => {
        throw new PostSourceCapacityDeteriorationError(failedAction);
      }),
    };
    const handlers = createSandboxWorkflowHandlers(store, execution, simulator);

    const records = await getHandler(handlers, 'OPEN_TARGET').execute(command('OPEN_TARGET'));

    expect(records.map((record) => record.type)).toEqual([
      'FINANCING_REVALIDATION',
      'RECOVERY_OPENED',
    ]);
    expect(records[1]).toEqual(
      expect.objectContaining({
        transactionHash: ACTION_TRANSACTION,
        verificationMethod: 'FAILED_FEASIBILITY_RECEIPT_AND_RECOVERY_POLICY',
        normalizedPayload: expect.objectContaining({
          reason: 'DESTINATION_CAPACITY_DETERIORATED_AFTER_SOURCE_CLOSE',
          residualAssets: failedAction.payload.residualAssets,
        }),
      }),
    );
  });

  it('turns pre-source capacity failure into revalidation and requote evidence', async () => {
    const simulator = new DeterministicTransportSimulator();
    const store = new MemoryContextStore(await buildContext(simulator, true));
    const releasedAction: FinalizedChainAction = {
      ...action(),
      payload: {
        action: 'releaseFailedReservation',
        reason: 'DESTINATION_CAPACITY_DETERIORATED_BEFORE_SOURCE_CLOSE',
        outcome: 'REQUOTE_REQUIRED',
        reservation: { status: 'RELEASED', principalReceivableUnits: '0' },
        sourcePosition: { disposition: 'UNCHANGED' },
      },
    };
    const execution: MigrationExecutionPort = {
      ...fakeExecution(),
      closeSource: vi.fn(async () => {
        throw new PreSourceCapacityDeteriorationError(releasedAction);
      }),
    };
    const handlers = createSandboxWorkflowHandlers(store, execution, simulator);

    const records = await getHandler(handlers, 'CLOSE_SOURCE').execute(command('CLOSE_SOURCE'));

    expect(records.map((record) => record.type)).toEqual([
      'FINANCING_REVALIDATION',
      'REQUOTE_REQUIRED',
    ]);
    expect(records[1]).toEqual(
      expect.objectContaining({
        transactionHash: ACTION_TRANSACTION,
        normalizedPayload: expect.objectContaining({
          reason: 'DESTINATION_CAPACITY_DETERIORATED_BEFORE_SOURCE_CLOSE',
          reservation: { status: 'RELEASED', principalReceivableUnits: '0' },
          sourcePosition: { disposition: 'UNCHANGED' },
        }),
      }),
    );
  });
});

async function buildContext(
  simulator: DeterministicTransportSimulator,
  submitted: boolean,
  deadline = '1999999999',
): Promise<MigrationExecutionContext> {
  const quote = await simulator.getQuote(
    transportQuoteRequestSchema.parse({
      inputAsset: {
        chainId: 31_337,
        address: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
        decimals: 18,
        symbol: 'sWETH',
      },
      outputAsset: {
        chainId: 31_338,
        address: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
        decimals: 18,
        symbol: 'dWETH',
      },
      amountInUnits: '9900000000000000000',
      maxSlippageBps: 50,
      destinationReceiver: DESTINATION_ESCROW,
      refundReceiver: BORROWER,
    }),
  );
  if (submitted) {
    await simulator.submitOrigin({
      quoteHash: quote.quoteHash as `0x${string}`,
      originTransactionHash: ORIGIN_TRANSACTION,
    });
  }

  const now = new Date('2026-11-09T00:00:00.000Z');
  return {
    migration: {
      migrationId: MIGRATION_ID,
      intentHash: `0x${'55'.repeat(32)}`,
      planHash: `0x${'66'.repeat(32)}`,
      quoteHash: quote.quoteHash,
      phase: 'ROUTING',
      version: 1,
      expiresAt: new Date(quote.expiresAt),
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    signedIntent: {} as MigrationExecutionContext['signedIntent'],
    signedPlan: {
      plan: {
        migrationId: MIGRATION_ID,
        borrower: BORROWER,
        deadline,
      },
    } as unknown as MigrationExecutionContext['signedPlan'],
    targetLendingAuthorization: {
      authorization: { kind: 'NONE' },
      encodedAuthorization: '0x',
    },
    sourceSnapshot: {
      collateralUnits: '10000000000000000000',
    } as MigrationExecutionContext['sourceSnapshot'],
    quote,
    transportLeg: {
      migrationId: MIGRATION_ID,
      legIndex: 0,
      provider: 'DEBTSHIFT_SIMULATOR',
      quoteHash: quote.quoteHash,
      inputAsset: quote.inputAsset,
      outputAsset: quote.outputAsset,
      inputUnits: quote.amountInUnits,
      minimumOutputUnits: quote.minAmountOutUnits,
      observedOutputUnits: null,
      providerState: submitted ? 'PROCESSING' : 'QUOTED',
      providerReference: quote.correlationId ?? quote.quoteId,
      depositAddress: quote.depositAddress ?? null,
      originTransactionHash: submitted ? ORIGIN_TRANSACTION : null,
      destinationTransactionHash: null,
      refundTransactionHash: null,
      observationCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function fakeExecution(): MigrationExecutionPort {
  const perform = vi.fn(async (): Promise<FinalizedChainAction> => action());
  return {
    verifyCanonicalEvidence: vi.fn(async () => []),
    reserve: perform,
    closeSource: perform,
    dispatchTransport: perform,
    deliverDestination: perform,
    openTarget: perform,
    settleLiquidity: perform,
    executeRecovery: perform,
  };
}

function createSandboxWorkflowHandlers(
  store: WorkflowContextStore,
  execution: MigrationExecutionPort,
  simulator: DeterministicTransportSimulator,
): ReadonlyMap<string, CommandHandler> {
  return createWorkflowHandlers({
    store,
    execution,
    transport: new SimulatedTransportExecutionPort(simulator),
    registry: new PendingSandboxRegistryPort(),
    evidenceProviders: sandboxEvidenceProviders,
  });
}

function action(): FinalizedChainAction {
  return {
    chainId: 31_337,
    transactionHash: ACTION_TRANSACTION,
    blockNumber: '100',
    blockHash: BLOCK_HASH,
    payload: { test: true },
  };
}

function command(type: string): DurableCommand {
  const now = new Date('2026-11-09T00:00:00.000Z');
  return {
    commandId: `0x${'77'.repeat(32)}`,
    migrationId: MIGRATION_ID,
    type,
    idempotencyKey: `${type}:${MIGRATION_ID}`,
    status: 'DISPATCHED',
    logicalAttempt: 0,
    payload: { migrationId: MIGRATION_ID },
    payloadHash: `0x${'88'.repeat(32)}`,
    lastError: null,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function getHandler(handlers: ReadonlyMap<string, CommandHandler>, type: string): CommandHandler {
  const handler = handlers.get(type);
  if (handler === undefined) throw new Error(`Missing ${type} handler.`);
  return handler;
}

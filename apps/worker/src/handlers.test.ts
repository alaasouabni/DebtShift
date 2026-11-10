import type {
  DurableCommand,
  MigrationExecutionContext,
  TransportLegStateUpdate,
} from '@debtshift/database';
import { DeterministicTransportSimulator, transportQuoteRequestSchema } from '@debtshift/intents';
import { describe, expect, it, vi } from 'vitest';

import {
  createSimulatedWorkflowHandlers,
  type FinalizedChainAction,
  type MigrationExecutionPort,
  type WorkflowContextStore,
} from './handlers.js';
import { RetryableCommandError, type CommandHandler } from './processor.js';

const MIGRATION_ID = `0x${'11'.repeat(32)}` as const;
const ORIGIN_TRANSACTION = `0x${'22'.repeat(32)}` as const;
const ACTION_TRANSACTION = `0x${'33'.repeat(32)}` as const;
const BLOCK_HASH = `0x${'44'.repeat(32)}` as const;
const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa' as const;
const DESTINATION_ESCROW = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9' as const;

class MemoryContextStore implements WorkflowContextStore {
  readonly updates: TransportLegStateUpdate[] = [];

  constructor(public context: MigrationExecutionContext) {}

  async get(): Promise<MigrationExecutionContext> {
    return this.context;
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
    const handlers = createSimulatedWorkflowHandlers(store, execution, simulator);

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
    const firstHandlers = createSimulatedWorkflowHandlers(store, firstExecution, firstSimulator);

    await expect(
      getHandler(firstHandlers, 'VERIFY_DESTINATION').execute(command('VERIFY_DESTINATION')),
    ).rejects.toBeInstanceOf(RetryableCommandError);
    expect(store.context.transportLeg.observationCount).toBe(1);

    const restartedSimulator = new DeterministicTransportSimulator({
      processingPolls: 1,
      outcome: 'SUCCESS',
    });
    const restartedExecution = fakeExecution();
    const restartedHandlers = createSimulatedWorkflowHandlers(
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
    const handlers = createSimulatedWorkflowHandlers(store, execution, simulator);

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
    const handlers = createSimulatedWorkflowHandlers(store, execution, simulator);

    const records = await getHandler(handlers, 'VERIFY_DESTINATION').execute(
      command('VERIFY_DESTINATION'),
    );

    expect(execution.deliverDestination).not.toHaveBeenCalled();
    expect(records.map((record) => record.type)).toEqual(['MIGRATION_EXPIRED', 'RECOVERY_OPENED']);
  });

  it('emits both settlement and reconciliation evidence from one finalized action', async () => {
    const simulator = new DeterministicTransportSimulator();
    const store = new MemoryContextStore(await buildContext(simulator, true));
    const handlers = createSimulatedWorkflowHandlers(store, fakeExecution(), simulator);

    const records = await getHandler(handlers, 'SETTLE_LIQUIDITY').execute(
      command('SETTLE_LIQUIDITY'),
    );

    expect(records.map((record) => record.type)).toEqual([
      'FINANCING_REVALIDATION',
      'LIQUIDITY_SETTLEMENT',
      'LEDGER_RECONCILIATION',
    ]);
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
    reserve: perform,
    closeSource: perform,
    dispatchTransport: perform,
    deliverDestination: perform,
    openTarget: perform,
    settleLiquidity: perform,
    executeRecovery: perform,
  };
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

import type {
  DurableCommand,
  MigrationExecutionContext,
  TransportLegStateUpdate,
} from '@debtshift/database';
import {
  parseDebtShiftEnvironment,
  type DebtShiftEnvironment,
  type Evidence,
  type TransportProvider,
} from '@debtshift/domain';
import type { TransportObservation } from '@debtshift/intents';
import { describe, expect, it, vi } from 'vitest';

import { composeWorkflowHandlers, type WorkflowAdapterSet } from './composition.js';
import type {
  FinalizedChainAction,
  MigrationExecutionPort,
  TransportExecutionPort,
  WorkflowContextStore,
} from './handlers.js';

describe('composeWorkflowHandlers', () => {
  it('requires an explicitly sandbox-bound adapter set', () => {
    const environment = parseDebtShiftEnvironment({});

    expect(() => composeWorkflowHandlers({ environment, store: fakeStore() })).toThrow(
      'No sandbox workflow adapters were configured.',
    );
    expect(
      composeWorkflowHandlers({
        environment,
        store: fakeStore(),
        adapters: fakeAdapters('sandbox', 'DEBTSHIFT_SIMULATOR'),
      }).size,
    ).toBe(8);
  });

  it('rejects adapter sets from another runtime mode', () => {
    expect(() =>
      composeWorkflowHandlers({
        environment: parseDebtShiftEnvironment({}),
        store: fakeStore(),
        adapters: fakeAdapters('testnet', 'DEBTSHIFT_SIMULATOR'),
      }),
    ).toThrow('Workflow adapter mode testnet cannot run in sandbox.');
  });

  it('constructs no write adapters and rejects every command in mainnet-readonly', async () => {
    const environment = modeEnvironment('mainnet-readonly', false);
    const handlers = composeWorkflowHandlers({ environment, store: fakeStore() });

    expect(handlers.size).toBe(8);
    await expect(handlers.get('RESERVE_LIQUIDITY')?.execute({} as DurableCommand)).rejects.toThrow(
      'Funded execution is unavailable in mainnet-readonly mode.',
    );
    expect(() =>
      composeWorkflowHandlers({
        environment,
        store: fakeStore(),
        adapters: fakeAdapters('mainnet', 'NEAR_INTENTS_1CLICK'),
      }),
    ).toThrow('Write-capable adapters must not be constructed');
  });

  it('constructs no write adapters while the mainnet switch is false', async () => {
    const environment = modeEnvironment('mainnet', false);
    const handlers = composeWorkflowHandlers({ environment, store: fakeStore() });

    await expect(handlers.get('CLOSE_SOURCE')?.execute({} as DurableCommand)).rejects.toThrow(
      'Mainnet execution is disabled by MAINNET_EXECUTION_ENABLED=false.',
    );
    expect(() =>
      composeWorkflowHandlers({
        environment,
        store: fakeStore(),
        adapters: fakeAdapters('mainnet', 'NEAR_INTENTS_1CLICK'),
      }),
    ).toThrow('Write-capable adapters must not be constructed');
  });

  it('requires official 1Click transport when mainnet writes are explicitly enabled', () => {
    const environment = modeEnvironment('mainnet', true);

    expect(() =>
      composeWorkflowHandlers({
        environment,
        store: fakeStore(),
        adapters: fakeAdapters('mainnet', 'DEBTSHIFT_SIMULATOR'),
      }),
    ).toThrow('mainnet requires NEAR_INTENTS_1CLICK, not DEBTSHIFT_SIMULATOR.');
    expect(
      composeWorkflowHandlers({
        environment,
        store: fakeStore(),
        adapters: fakeAdapters('mainnet', 'NEAR_INTENTS_1CLICK'),
      }).size,
    ).toBe(8);
  });
});

function modeEnvironment(
  mode: DebtShiftEnvironment['DEBTSHIFT_MODE'],
  mainnetExecutionEnabled: boolean,
): DebtShiftEnvironment {
  return {
    ...parseDebtShiftEnvironment({}),
    DEBTSHIFT_MODE: mode,
    MAINNET_EXECUTION_ENABLED: mainnetExecutionEnabled,
  };
}

function fakeAdapters(
  mode: WorkflowAdapterSet['mode'],
  provider: TransportProvider,
): WorkflowAdapterSet {
  return {
    mode,
    execution: fakeExecution(),
    transport: fakeTransport(provider),
    registry: {
      finalize: vi.fn(async () => {
        throw new Error('Not exercised by composition tests.');
      }),
    },
    evidenceProviders: {
      financing: 'TEST_FINANCING',
      liquidity: 'TEST_LIQUIDITY',
      source: 'TEST_SOURCE',
      target: 'TEST_TARGET',
      ledger: 'TEST_LEDGER',
      recovery: 'TEST_RECOVERY',
    },
  };
}

function fakeStore(): WorkflowContextStore {
  return {
    get: vi.fn(async () => ({}) as MigrationExecutionContext),
    listActiveFinalizedChainEvidence: vi.fn(async (): Promise<readonly Evidence[]> => []),
    updateTransport: vi.fn(async (_migrationId: string, _update: TransportLegStateUpdate) => {}),
  };
}

function fakeExecution(): MigrationExecutionPort {
  const action = vi.fn(async (): Promise<FinalizedChainAction> => {
    throw new Error('Not exercised by composition tests.');
  });
  return {
    verifyCanonicalEvidence: vi.fn(async () => []),
    reserve: action,
    closeSource: action,
    dispatchTransport: action,
    deliverDestination: action,
    openTarget: action,
    settleLiquidity: action,
    executeRecovery: action,
  };
}

function fakeTransport(provider: TransportProvider): TransportExecutionPort {
  return {
    provider,
    bindOrigin: vi.fn(async () => {
      throw new Error('Not exercised by composition tests.');
    }),
    observe: vi.fn(
      async (): Promise<{
        readonly observation: TransportObservation;
        readonly observationCount: number;
      }> => {
        throw new Error('Not exercised by composition tests.');
      },
    ),
  };
}

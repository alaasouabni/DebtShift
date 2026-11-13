import {
  assertFundedExecutionEnabled,
  commandTypeSchema,
  type DebtShiftEnvironment,
} from '@debtshift/domain';

import {
  createWorkflowHandlers,
  type MigrationExecutionPort,
  type ReceiptRegistryPort,
  type TransportExecutionPort,
  type WorkflowContextStore,
  type WorkflowEvidenceProviders,
} from './handlers.js';
import type { CommandHandler } from './processor.js';

type ExecutableMode = 'sandbox' | 'testnet' | 'mainnet';

export interface WorkflowAdapterSet {
  readonly mode: ExecutableMode;
  readonly execution: MigrationExecutionPort;
  readonly transport: TransportExecutionPort;
  readonly registry: ReceiptRegistryPort;
  readonly evidenceProviders: WorkflowEvidenceProviders;
}

export interface WorkflowCompositionInput {
  readonly environment: DebtShiftEnvironment;
  readonly store: WorkflowContextStore;
  readonly adapters?: WorkflowAdapterSet;
}

export async function assertWorkflowAdaptersReady(adapters?: WorkflowAdapterSet): Promise<void> {
  if (adapters === undefined) return;
  await adapters.execution.assertReady?.();
  await adapters.registry.assertReady?.();
}

/**
 * The only composition boundary for funded workflow handlers. A mode mismatch is
 * fatal, and read-only/disabled mainnet runtimes never construct write adapters.
 */
export function composeWorkflowHandlers({
  environment,
  store,
  adapters,
}: WorkflowCompositionInput): ReadonlyMap<string, CommandHandler> {
  if (
    environment.DEBTSHIFT_MODE === 'mainnet-readonly' ||
    (environment.DEBTSHIFT_MODE === 'mainnet' && !environment.MAINNET_EXECUTION_ENABLED)
  ) {
    if (adapters !== undefined) {
      throw new Error(
        `Write-capable adapters must not be constructed in ${environment.DEBTSHIFT_MODE} with mainnet execution disabled.`,
      );
    }
    return disabledExecutionHandlers(environment);
  }

  assertFundedExecutionEnabled(environment);
  if (adapters === undefined) {
    throw new Error(`No ${environment.DEBTSHIFT_MODE} workflow adapters were configured.`);
  }
  if (adapters.mode !== environment.DEBTSHIFT_MODE) {
    throw new Error(
      `Workflow adapter mode ${adapters.mode} cannot run in ${environment.DEBTSHIFT_MODE}.`,
    );
  }

  const expectedTransport =
    environment.DEBTSHIFT_MODE === 'mainnet' ? 'NEAR_INTENTS_1CLICK' : 'DEBTSHIFT_SIMULATOR';
  if (adapters.transport.provider !== expectedTransport) {
    throw new Error(
      `${environment.DEBTSHIFT_MODE} requires ${expectedTransport}, not ${adapters.transport.provider}.`,
    );
  }

  return createWorkflowHandlers({
    store,
    execution: adapters.execution,
    transport: adapters.transport,
    registry: adapters.registry,
    evidenceProviders: adapters.evidenceProviders,
  });
}

function disabledExecutionHandlers(
  environment: DebtShiftEnvironment,
): ReadonlyMap<string, CommandHandler> {
  return new Map(
    commandTypeSchema.options.map((commandType) => [
      commandType,
      {
        execute: async () => {
          assertFundedExecutionEnabled(environment);
          throw new Error('Execution gate invariant failed.');
        },
      },
    ]),
  );
}

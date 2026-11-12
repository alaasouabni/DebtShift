import type { MigrationExecutionContext } from '@debtshift/database';
import type { DeterministicTransportSimulator, SimulatorTransportState } from '@debtshift/intents';
import type { Hex } from 'viem';

import type {
  ReceiptRegistryPort,
  TransportExecutionPort,
  WorkflowEvidenceProviders,
} from '../handlers.js';
import { RetryableCommandError } from '../processor.js';

export const sandboxEvidenceProviders: WorkflowEvidenceProviders = Object.freeze({
  financing: 'DEBTSHIFT_RISK_VALIDATOR',
  liquidity: 'SANDBOX_LIQUIDITY_VAULT',
  source: 'SANDBOX_SOURCE_ADAPTER',
  target: 'SANDBOX_TARGET_ADAPTER',
  ledger: 'DEBTSHIFT_LEDGER',
  recovery: 'SANDBOX_RECOVERY',
});

/**
 * Adapts the deterministic external-provider simulator to the production-neutral
 * workflow transport port. Asset movement remains the responsibility of the
 * contract-backed execution port and is proven with chain receipts.
 */
export class SimulatedTransportExecutionPort implements TransportExecutionPort {
  readonly provider = 'DEBTSHIFT_SIMULATOR' as const;

  constructor(private readonly simulator: DeterministicTransportSimulator) {}

  async bindOrigin(
    context: MigrationExecutionContext,
    originTransactionHash: Hex,
  ): Promise<{ readonly providerReference: string; readonly observationCount: number }> {
    this.restore(context);
    const providerReference = await this.simulator.submitOrigin({
      quoteHash: context.quote.quoteHash as Hex,
      originTransactionHash,
    });
    return {
      providerReference,
      observationCount: this.simulator.getState(providerReference).pollCount,
    };
  }

  async observe(context: MigrationExecutionContext) {
    this.restore(context);
    const providerReference = context.transportLeg.providerReference ?? context.quote.quoteId;
    const observation = await this.simulator.getStatus(providerReference);
    return {
      observation,
      observationCount: this.simulator.getState(providerReference).pollCount,
    };
  }

  private restore(context: MigrationExecutionContext): void {
    const state: SimulatorTransportState = {
      pollCount: context.transportLeg.observationCount,
      ...(context.transportLeg.originTransactionHash === null
        ? {}
        : { originTransactionHash: context.transportLeg.originTransactionHash as Hex }),
    };
    this.simulator.restoreQuote(context.quote, state);
  }
}

/** Temporary adapter until the NEAR sandbox/testnet registry client is wired. */
export class PendingSandboxRegistryPort implements ReceiptRegistryPort {
  async finalize(_context: MigrationExecutionContext): Promise<never> {
    throw new RetryableCommandError('The sandbox NEAR receipt registry adapter is not configured.');
  }
}

import { storeProviderObservation, type DebtShiftDatabase } from '@debtshift/database';
import { bytes32Schema, type TransportProvider } from '@debtshift/domain';
import {
  OneClickRequestError,
  type OneClickCommittedClient,
  type OneClickStatusObservation,
  type TransportObservation,
} from '@debtshift/intents';
import type { Hex } from 'viem';

import type { TransportExecutionPort } from '../handlers.js';
import { RetryableCommandError } from '../processor.js';

type OneClickCommittedTransportClient = Pick<
  OneClickCommittedClient,
  'submitDepositTransaction' | 'getStatus'
>;

export interface OneClickObservationStore {
  store(
    operation: 'DEPOSIT_SUBMIT' | 'STATUS',
    observation: OneClickStatusObservation,
  ): Promise<void>;
}

export class PostgresOneClickObservationStore implements OneClickObservationStore {
  constructor(private readonly database: DebtShiftDatabase) {}

  async store(
    operation: 'DEPOSIT_SUBMIT' | 'STATUS',
    observation: OneClickStatusObservation,
  ): Promise<void> {
    await storeProviderObservation(this.database, {
      provider: 'NEAR_INTENTS_1CLICK',
      operation,
      requestHash: observation.requestHash,
      responseHash: observation.responseHash,
      requestPayload: observation.rawRequest,
      responsePayload: observation.rawResponse,
      correlationId: observation.correlationId,
      observedAt: observation.observedAt,
    });
  }
}

/**
 * Production 1Click transport adapter. Provider status is evidence about the
 * transport only; chain canonicality and receiver/balance verification remain
 * the responsibility of the execution port before the workflow can advance.
 */
export class OneClickTransportExecutionPort implements TransportExecutionPort {
  readonly provider: TransportProvider = 'NEAR_INTENTS_1CLICK';

  constructor(
    private readonly client: OneClickCommittedTransportClient,
    private readonly observations: OneClickObservationStore,
  ) {}

  async bindOrigin(
    context: Parameters<TransportExecutionPort['bindOrigin']>[0],
    originTransactionHash: Hex,
  ): Promise<{ readonly providerReference: string; readonly observationCount: number }> {
    assertCommittedOneClickQuote(context.quote);
    const depositAddress = requireDepositAddress(context.quote.depositAddress);
    const observation = await retryableProviderRequest(() =>
      this.client.submitDepositTransaction({
        transactionHash: originTransactionHash,
        depositAddress,
        ...(context.quote.depositMemo === undefined
          ? {}
          : { depositMemo: context.quote.depositMemo }),
      }),
    );
    if (
      observation.originTransactionHashes.length > 0 &&
      !observation.originTransactionHashes.includes(originTransactionHash)
    ) {
      throw new Error('1Click bound a different origin transaction to the committed quote.');
    }
    await this.observations.store('DEPOSIT_SUBMIT', observation);
    return {
      providerReference: depositAddress,
      observationCount: context.transportLeg.observationCount + 1,
    };
  }

  async observe(context: Parameters<TransportExecutionPort['observe']>[0]): Promise<{
    readonly observation: TransportObservation;
    readonly observationCount: number;
  }> {
    assertCommittedOneClickQuote(context.quote);
    const depositAddress = requireDepositAddress(context.quote.depositAddress);
    if (
      context.transportLeg.providerReference !== null &&
      context.transportLeg.providerReference !== depositAddress
    ) {
      throw new Error('Stored 1Click provider reference does not match the committed quote.');
    }
    const providerObservation = await retryableProviderRequest(() =>
      this.client.getStatus(depositAddress, context.quote.depositMemo),
    );
    await this.observations.store('STATUS', providerObservation);
    return {
      observation: mapTransportObservation(context, providerObservation),
      observationCount: context.transportLeg.observationCount + 1,
    };
  }
}

async function retryableProviderRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof OneClickRequestError && error.retryable) {
      throw new RetryableCommandError(
        'Official 1Click request exhausted its internal transport retries.',
      );
    }
    throw error;
  }
}

function mapTransportObservation(
  context: Parameters<TransportExecutionPort['observe']>[0],
  providerObservation: OneClickStatusObservation,
): TransportObservation {
  const status = mapStatus(providerObservation.status);
  const originTransactionHash = optionalBytes32(
    context.transportLeg.originTransactionHash ??
      providerObservation.originTransactionHashes.find(
        (hash) => optionalBytes32(hash) !== undefined,
      ),
  );
  const destinationTransactionHash = providerObservation.destinationTransactionHashes
    .map(optionalBytes32)
    .find((hash): hash is Hex => hash !== undefined);
  const refundTransactionHash = providerObservation.originTransactionHashes
    .map(optionalBytes32)
    .find(
      (hash): hash is Hex =>
        hash !== undefined &&
        (originTransactionHash === undefined || hash !== originTransactionHash),
    );
  const refunded = status === 'REFUNDED';
  return {
    provider: 'NEAR_INTENTS_1CLICK',
    simulated: false,
    providerReference: providerObservation.depositAddress,
    quoteHash: context.quote.quoteHash as Hex,
    ...(originTransactionHash === undefined ? {} : { originTransactionHash }),
    ...(status === 'SUCCESS' && destinationTransactionHash !== undefined
      ? { destinationTransactionHash }
      : {}),
    ...(refunded && refundTransactionHash !== undefined ? { refundTransactionHash } : {}),
    status,
    outputAsset: refunded ? context.quote.inputAsset : context.quote.outputAsset,
    receiver: refunded ? context.quote.refundReceiver : context.quote.destinationReceiver,
    observedAmountOutUnits: refunded
      ? (providerObservation.refundedAmountUnits ?? '0')
      : (providerObservation.amountOutUnits ?? '0'),
    observedAt: providerObservation.observedAt,
    rawObservationHash: providerObservation.responseHash,
  };
}

function mapStatus(status: OneClickStatusObservation['status']): TransportObservation['status'] {
  switch (status) {
    case 'PENDING_DEPOSIT':
      return 'AWAITING_DEPOSIT';
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
      return 'PROCESSING';
    case 'INCOMPLETE_DEPOSIT':
      return 'INCOMPLETE_DEPOSIT';
    case 'SUCCESS':
      return 'SUCCESS';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'FAILED':
      return 'FAILED_AMBIGUOUS_CUSTODY';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

function assertCommittedOneClickQuote(
  quote: Parameters<TransportExecutionPort['bindOrigin']>[0]['quote'],
): void {
  if (quote.provider !== 'NEAR_INTENTS_1CLICK' || quote.mode !== 'COMMITTED') {
    throw new Error('Production 1Click transport requires a committed official quote.');
  }
}

function requireDepositAddress(value: string | undefined): string {
  if (value === undefined) throw new Error('Committed 1Click quote has no deposit address.');
  return value;
}

function optionalBytes32(value: string | undefined): Hex | undefined {
  if (value === undefined) return undefined;
  const parsed = bytes32Schema.safeParse(value);
  return parsed.success ? (parsed.data as Hex) : undefined;
}

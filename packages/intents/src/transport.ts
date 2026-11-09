import type { ProviderQuote, TokenReference } from '@debtshift/domain';
import {
  baseUnitAmountSchema,
  basisPointsSchema,
  bytes32Schema,
  evmAddressSchema,
  providerQuoteSchema,
  tokenReferenceSchema,
} from '@debtshift/domain';
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from 'viem';
import type { Hex } from 'viem';
import { z } from 'zod';

export const transportTerminalOutcomeSchema = z.enum([
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED_KNOWN_CUSTODY',
  'FAILED_AMBIGUOUS_CUSTODY',
  'UNKNOWN',
]);

export const transportStatusSchema = z.enum([
  'AWAITING_DEPOSIT',
  'PROCESSING',
  ...transportTerminalOutcomeSchema.options,
]);

export type TransportTerminalOutcome = z.infer<typeof transportTerminalOutcomeSchema>;
export type TransportStatus = z.infer<typeof transportStatusSchema>;

export const transportQuoteRequestSchema = z
  .object({
    inputAsset: tokenReferenceSchema,
    outputAsset: tokenReferenceSchema,
    amountInUnits: baseUnitAmountSchema,
    maxSlippageBps: basisPointsSchema,
    destinationReceiver: evmAddressSchema,
    refundReceiver: evmAddressSchema,
  })
  .strict();

export type TransportQuoteRequest = z.infer<typeof transportQuoteRequestSchema>;

export interface TransportSubmission {
  readonly quoteHash: Hex;
  readonly originTransactionHash: Hex;
}

export interface TransportObservation {
  readonly provider: 'DEBTSHIFT_SIMULATOR';
  readonly simulated: true;
  readonly providerReference: string;
  readonly quoteHash: Hex;
  readonly originTransactionHash?: Hex;
  readonly destinationTransactionHash?: Hex;
  readonly refundTransactionHash?: Hex;
  readonly status: TransportStatus;
  readonly outputAsset: TokenReference;
  readonly receiver: string;
  readonly observedAmountOutUnits: string;
  readonly observedAt: string;
  readonly rawObservationHash: Hex;
}

export interface TransportProvider {
  getQuote(request: TransportQuoteRequest): Promise<ProviderQuote>;
  submitOrigin(submission: TransportSubmission): Promise<string>;
  getStatus(providerReference: string): Promise<TransportObservation>;
}

export interface SimulatorConfig {
  readonly outcome?: TransportTerminalOutcome;
  readonly processingPolls?: number;
  readonly feeBps?: number;
  readonly quoteTtlSeconds?: number;
  readonly deliveredAmountUnits?: string;
  readonly deliveredAsset?: TokenReference;
  readonly deliveredReceiver?: string;
  readonly now?: () => number;
}

interface SimulationRecord {
  readonly quote: ProviderQuote;
  readonly providerReference: string;
  originTransactionHash?: Hex;
  pollCount: number;
}

export interface SimulatorTransportState {
  readonly originTransactionHash?: Hex;
  readonly pollCount: number;
}

export class DeterministicTransportSimulator implements TransportProvider {
  readonly #config: Required<
    Pick<SimulatorConfig, 'outcome' | 'processingPolls' | 'feeBps' | 'quoteTtlSeconds' | 'now'>
  > &
    Pick<SimulatorConfig, 'deliveredAmountUnits' | 'deliveredAsset' | 'deliveredReceiver'>;
  readonly #recordsByQuote = new Map<Hex, SimulationRecord>();
  readonly #recordsByReference = new Map<string, SimulationRecord>();

  constructor(config: SimulatorConfig = {}) {
    const processingPolls = config.processingPolls ?? 1;
    const feeBps = config.feeBps ?? 10;
    const quoteTtlSeconds = config.quoteTtlSeconds ?? 300;
    if (!Number.isInteger(processingPolls) || processingPolls < 0) {
      throw new Error('processingPolls must be a non-negative integer.');
    }
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
      throw new Error('feeBps must be between 0 and 10,000.');
    }
    if (!Number.isInteger(quoteTtlSeconds) || quoteTtlSeconds <= 0) {
      throw new Error('quoteTtlSeconds must be a positive integer.');
    }
    if (config.deliveredAmountUnits !== undefined) {
      baseUnitAmountSchema.parse(config.deliveredAmountUnits);
    }

    this.#config = {
      outcome: config.outcome ?? 'SUCCESS',
      processingPolls,
      feeBps,
      quoteTtlSeconds,
      now: config.now ?? Date.now,
      ...(config.deliveredAmountUnits === undefined
        ? {}
        : { deliveredAmountUnits: config.deliveredAmountUnits }),
      ...(config.deliveredAsset === undefined ? {} : { deliveredAsset: config.deliveredAsset }),
      ...(config.deliveredReceiver === undefined
        ? {}
        : { deliveredReceiver: config.deliveredReceiver }),
    };
  }

  restoreQuote(quoteInput: ProviderQuote, state: SimulatorTransportState = { pollCount: 0 }): void {
    const quote = providerQuoteSchema.parse(quoteInput);
    if (quote.provider !== 'DEBTSHIFT_SIMULATOR' || quote.mode !== 'SIMULATED') {
      throw new Error('Only explicitly simulated DebtShift quotes can be restored.');
    }
    if (!Number.isInteger(state.pollCount) || state.pollCount < 0) {
      throw new Error('Simulator poll count must be a non-negative integer.');
    }
    const providerReference = quote.correlationId ?? quote.quoteId;
    const record: SimulationRecord = {
      quote,
      providerReference,
      pollCount: state.pollCount,
      ...(state.originTransactionHash === undefined
        ? {}
        : { originTransactionHash: state.originTransactionHash }),
    };
    this.#recordsByQuote.set(quote.quoteHash as Hex, record);
    this.#recordsByReference.set(providerReference, record);
  }

  getState(providerReference: string): SimulatorTransportState {
    const record = this.#recordsByReference.get(providerReference);
    if (record === undefined) throw new Error('Unknown simulator transport reference.');
    return {
      pollCount: record.pollCount,
      ...(record.originTransactionHash === undefined
        ? {}
        : { originTransactionHash: record.originTransactionHash }),
    };
  }

  async getQuote(request: TransportQuoteRequest): Promise<ProviderQuote> {
    const amountIn = BigInt(baseUnitAmountSchema.parse(request.amountInUnits));
    if (amountIn === 0n) throw new Error('Transport amount must be positive.');
    if (
      !Number.isInteger(request.maxSlippageBps) ||
      request.maxSlippageBps < 0 ||
      request.maxSlippageBps > 10_000
    ) {
      throw new Error('maxSlippageBps must be between 0 and 10,000.');
    }
    const expectedOut = (amountIn * BigInt(10_000 - this.#config.feeBps)) / 10_000n;
    const minimumOut = (expectedOut * BigInt(10_000 - request.maxSlippageBps)) / 10_000n;
    if (minimumOut === 0n) throw new Error('Transport minimum output must be positive.');

    const expiresAtSeconds = BigInt(
      Math.floor(this.#config.now() / 1000) + this.#config.quoteTtlSeconds,
    );
    const quoteHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          'uint256, address, uint8, uint256, address, uint8, uint256, uint32, address, address, uint64, uint32',
        ),
        [
          BigInt(request.inputAsset.chainId),
          request.inputAsset.address,
          request.inputAsset.decimals,
          BigInt(request.outputAsset.chainId),
          request.outputAsset.address,
          request.outputAsset.decimals,
          amountIn,
          request.maxSlippageBps,
          request.destinationReceiver,
          request.refundReceiver,
          expiresAtSeconds,
          this.#config.feeBps,
        ],
      ),
    );
    const providerReference = `sim-${quoteHash.slice(2, 18)}`;
    const quote = providerQuoteSchema.parse({
      quoteId: providerReference,
      quoteHash,
      provider: 'DEBTSHIFT_SIMULATOR',
      mode: 'SIMULATED',
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      amountInUnits: amountIn.toString(),
      expectedAmountOutUnits: expectedOut.toString(),
      minAmountOutUnits: minimumOut.toString(),
      fees: [
        {
          kind: 'TRANSPORT',
          asset: request.inputAsset,
          amountUnits: (amountIn - expectedOut).toString(),
        },
      ],
      destinationReceiver: request.destinationReceiver,
      refundReceiver: request.refundReceiver,
      depositAddress: `simulator:${quoteHash.slice(2, 34)}`,
      expiresAt: new Date(Number(expiresAtSeconds) * 1000).toISOString(),
      correlationId: providerReference,
      rawResponseHash: keccak256(stringToHex(`DEBTSHIFT_SIMULATOR:${quoteHash}`)),
    });

    const existing = this.#recordsByQuote.get(quoteHash);
    if (existing !== undefined) return existing.quote;
    const record: SimulationRecord = { quote, providerReference, pollCount: 0 };
    this.#recordsByQuote.set(quoteHash, record);
    this.#recordsByReference.set(providerReference, record);
    return quote;
  }

  async submitOrigin(submission: TransportSubmission): Promise<string> {
    const quoteHash = bytes32Schema.parse(submission.quoteHash) as Hex;
    const originTransactionHash = bytes32Schema.parse(submission.originTransactionHash) as Hex;
    const record = this.#recordsByQuote.get(quoteHash);
    if (record === undefined) throw new Error('Unknown simulator quote.');
    if (Date.parse(record.quote.expiresAt) < this.#config.now()) {
      throw new Error('Simulator quote has expired.');
    }
    if (
      record.originTransactionHash !== undefined &&
      record.originTransactionHash !== originTransactionHash
    ) {
      throw new Error('A different origin transaction is already bound to this quote.');
    }
    record.originTransactionHash = originTransactionHash;
    return record.providerReference;
  }

  async getStatus(providerReference: string): Promise<TransportObservation> {
    const record = this.#recordsByReference.get(providerReference);
    if (record === undefined) throw new Error('Unknown simulator transport reference.');
    const status = this.#status(record);
    const defaultAsset = status === 'REFUNDED' ? record.quote.inputAsset : record.quote.outputAsset;
    const defaultReceiver =
      status === 'REFUNDED' ? record.quote.refundReceiver : record.quote.destinationReceiver;
    const outputAsset = this.#config.deliveredAsset ?? defaultAsset;
    const receiver = this.#config.deliveredReceiver ?? defaultReceiver;
    const observedAmountOutUnits = this.#observedAmount(record, status);
    const observationSeed = [
      providerReference,
      status,
      record.originTransactionHash ?? 'none',
      outputAsset.chainId,
      outputAsset.address,
      receiver,
      observedAmountOutUnits,
      record.pollCount,
    ].join(':');
    const rawObservationHash = keccak256(stringToHex(observationSeed));
    const terminalHash = keccak256(stringToHex(`${observationSeed}:transaction`));

    return {
      provider: 'DEBTSHIFT_SIMULATOR',
      simulated: true,
      providerReference,
      quoteHash: record.quote.quoteHash as Hex,
      ...(record.originTransactionHash === undefined
        ? {}
        : { originTransactionHash: record.originTransactionHash }),
      ...(status === 'SUCCESS' ? { destinationTransactionHash: terminalHash } : {}),
      ...(status === 'REFUNDED' ? { refundTransactionHash: terminalHash } : {}),
      status,
      outputAsset,
      receiver,
      observedAmountOutUnits,
      observedAt: new Date(this.#config.now()).toISOString(),
      rawObservationHash,
    };
  }

  #status(record: SimulationRecord): TransportStatus {
    if (record.originTransactionHash === undefined) return 'AWAITING_DEPOSIT';
    if (record.pollCount < this.#config.processingPolls) {
      record.pollCount += 1;
      return 'PROCESSING';
    }
    return this.#config.outcome;
  }

  #observedAmount(record: SimulationRecord, status: TransportStatus): string {
    if (this.#config.deliveredAmountUnits !== undefined) {
      return this.#config.deliveredAmountUnits;
    }
    if (status === 'SUCCESS') return record.quote.expectedAmountOutUnits;
    if (status === 'REFUNDED') return record.quote.amountInUnits;
    if (status === 'INCOMPLETE_DEPOSIT') {
      return (BigInt(record.quote.minAmountOutUnits) - 1n).toString();
    }
    return '0';
  }
}

export function normalizeTransportStatus(rawStatus: string): TransportStatus {
  const normalized = rawStatus.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  const parsed = transportStatusSchema.safeParse(normalized);
  return parsed.success ? parsed.data : 'UNKNOWN';
}

export interface TransportVerificationResult {
  readonly valid: boolean;
  readonly failures: readonly string[];
}

export function verifyTransportDelivery(
  quote: ProviderQuote,
  observation: TransportObservation,
): TransportVerificationResult {
  const failures: string[] = [];
  if (observation.status !== 'SUCCESS') failures.push('STATUS_NOT_SUCCESS');
  if (observation.quoteHash !== quote.quoteHash) failures.push('QUOTE_HASH_MISMATCH');
  if (observation.destinationTransactionHash === undefined) {
    failures.push('DESTINATION_TRANSACTION_MISSING');
  }
  if (
    observation.outputAsset.chainId !== quote.outputAsset.chainId ||
    observation.outputAsset.address !== quote.outputAsset.address ||
    observation.outputAsset.decimals !== quote.outputAsset.decimals
  ) {
    failures.push('OUTPUT_ASSET_MISMATCH');
  }
  if (observation.receiver !== quote.destinationReceiver) {
    failures.push('DESTINATION_RECEIVER_MISMATCH');
  }
  if (BigInt(observation.observedAmountOutUnits) < BigInt(quote.minAmountOutUnits)) {
    failures.push('OUTPUT_BELOW_MINIMUM');
  }
  return { valid: failures.length === 0, failures };
}

export function verifyTransportRefund(
  quote: ProviderQuote,
  observation: TransportObservation,
): TransportVerificationResult {
  const failures: string[] = [];
  if (observation.status !== 'REFUNDED') failures.push('STATUS_NOT_REFUNDED');
  if (observation.quoteHash !== quote.quoteHash) failures.push('QUOTE_HASH_MISMATCH');
  if (observation.refundTransactionHash === undefined) {
    failures.push('REFUND_TRANSACTION_MISSING');
  }
  if (
    observation.outputAsset.chainId !== quote.inputAsset.chainId ||
    observation.outputAsset.address !== quote.inputAsset.address ||
    observation.outputAsset.decimals !== quote.inputAsset.decimals
  ) {
    failures.push('REFUND_ASSET_MISMATCH');
  }
  if (observation.receiver !== quote.refundReceiver) failures.push('REFUND_RECEIVER_MISMATCH');
  if (BigInt(observation.observedAmountOutUnits) !== BigInt(quote.amountInUnits)) {
    failures.push('REFUND_AMOUNT_MISMATCH');
  }
  return { valid: failures.length === 0, failures };
}

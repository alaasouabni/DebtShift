import {
  DeterministicTransportSimulator,
  OneClickCommittedClient,
  OneClickReadOnlyClient,
  transportQuoteRequestSchema,
  type OneClickClientConfig,
  type OneClickCommittedQuoteRequest,
  type OneClickDryQuoteRequest,
} from '@debtshift/intents';
import { storeAssetCatalogVersion, storeProviderObservation } from '@debtshift/database';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DatabaseService } from './database.service.js';

@Injectable()
export class TransportService {
  readonly #simulator?: DeterministicTransportSimulator;
  readonly #oneClickReadOnly?: OneClickReadOnlyClient;
  readonly #oneClickCommitted?: OneClickCommittedClient;
  readonly #environment: string;

  constructor(
    @Optional() @Inject(ConfigService) config?: ConfigService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {
    this.#environment = config?.get<string>('DEBTSHIFT_MODE') ?? 'sandbox';
    const provider = config?.get<string>('TRANSPORT_PROVIDER') ?? 'DEBTSHIFT_SIMULATOR';
    if (provider === 'DEBTSHIFT_SIMULATOR') {
      this.#simulator = new DeterministicTransportSimulator();
      return;
    }
    if (provider !== 'NEAR_INTENTS_1CLICK') {
      throw new Error(`Unsupported transport provider ${provider}.`);
    }
    const authToken = config?.get<string>('INTENTS_AUTH_TOKEN');
    const clientConfig: OneClickClientConfig = {
      baseUrl: config?.getOrThrow<string>('INTENTS_BASE_URL') ?? '',
      ...(authToken === undefined ? {} : { authToken }),
      requestTimeoutMs: config?.get<number>('INTENTS_REQUEST_TIMEOUT_MS') ?? 8_000,
      responseLimitBytes: config?.get<number>('INTENTS_RESPONSE_LIMIT_BYTES') ?? 1_000_000,
      catalogCacheTtlMs: config?.get<number>('INTENTS_CATALOG_CACHE_TTL_MS') ?? 600_000,
      resilience: {
        maximumAttempts: config?.get<number>('INTENTS_MAX_ATTEMPTS') ?? 3,
        baseRetryDelayMs: config?.get<number>('INTENTS_RETRY_BASE_DELAY_MS') ?? 200,
        maximumRetryDelayMs: config?.get<number>('INTENTS_RETRY_MAX_DELAY_MS') ?? 2_000,
        circuitFailureThreshold: config?.get<number>('INTENTS_CIRCUIT_FAILURE_THRESHOLD') ?? 5,
        circuitResetMs: config?.get<number>('INTENTS_CIRCUIT_RESET_MS') ?? 30_000,
        rateLimitCapacity: config?.get<number>('INTENTS_RATE_LIMIT_CAPACITY') ?? 10,
        rateLimitWindowMs: config?.get<number>('INTENTS_RATE_LIMIT_WINDOW_MS') ?? 1_000,
        maximumCacheEntries: config?.get<number>('INTENTS_CACHE_MAX_ENTRIES') ?? 100,
      },
    };
    this.#oneClickReadOnly = new OneClickReadOnlyClient(clientConfig);
    if (config?.get<string>('INTENTS_MODE') === 'mainnet') {
      this.#oneClickCommitted = new OneClickCommittedClient(clientConfig);
    }
  }

  getQuote(input: unknown) {
    const request = transportQuoteRequestSchema.parse(input);
    if (this.#simulator !== undefined) return this.#simulator.getQuote(request);
    const quoteRequest = {
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      amountUnits: request.amountInUnits,
      amountKind: 'EXACT_INPUT',
      maxSlippageBps: request.maxSlippageBps,
      destinationReceiver: request.destinationReceiver,
      refundReceiver: request.refundReceiver,
      deadline: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
    } as const;
    if (this.#oneClickCommitted !== undefined) {
      return this.#getAndStoreOneClickCommittedQuote(quoteRequest);
    }
    if (this.#oneClickReadOnly === undefined) {
      throw new Error('No transport quote provider is active.');
    }
    return this.#getAndStoreOneClickDryQuote(quoteRequest);
  }

  async getTokenCatalog() {
    if (this.#oneClickReadOnly === undefined) {
      throw new Error('The live 1Click token catalog is unavailable in simulator mode.');
    }
    if (this.database === undefined) {
      throw new Error('Live 1Click observations require durable database storage.');
    }
    const observation = await this.#oneClickReadOnly.getTokenCatalogObservation();
    await Promise.all([
      storeProviderObservation(this.database.db, {
        provider: 'NEAR_INTENTS_1CLICK',
        operation: 'TOKEN_CATALOG',
        requestHash: observation.requestHash,
        responseHash: observation.responseHash,
        requestPayload: { method: 'GET', path: '/v0/tokens' },
        responsePayload: observation.rawResponse,
        observedAt: observation.observedAt,
      }),
      storeAssetCatalogVersion(this.database.db, {
        provider: 'NEAR_INTENTS_1CLICK',
        environment: this.#environment,
        assets: observation.tokens,
        rawResponseHash: observation.responseHash,
        fetchedAt: observation.observedAt,
      }),
    ]);
    return observation.tokens;
  }

  getOneClickDryQuote(request: OneClickDryQuoteRequest) {
    if (this.#oneClickReadOnly === undefined) {
      throw new Error('Live 1Click dry quotes are unavailable in simulator mode.');
    }
    return this.#getAndStoreOneClickDryQuote(request);
  }

  getAnalysisQuote(request: OneClickDryQuoteRequest) {
    if (this.#simulator !== undefined) return this.#getSimulatorAnalysisQuote(request);
    return this.#getAndStoreOneClickDryQuote(request);
  }

  async #getSimulatorAnalysisQuote(request: OneClickDryQuoteRequest) {
    if (this.#simulator === undefined) {
      throw new Error('The simulated analysis quote provider is unavailable.');
    }
    const quoteRequest = transportQuoteRequestSchema.parse({
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      amountInUnits: request.amountUnits,
      maxSlippageBps: request.maxSlippageBps,
      destinationReceiver: request.destinationReceiver,
      refundReceiver: request.refundReceiver,
    });
    if (request.amountKind === 'EXACT_INPUT') return this.#simulator.getQuote(quoteRequest);

    const targetOutputUnits = BigInt(request.amountUnits);
    const probe = await this.#simulator.getQuote(quoteRequest);
    const probeOutputUnits = BigInt(probe.expectedAmountOutUnits);
    const requiredInputUnits =
      (targetOutputUnits * targetOutputUnits + probeOutputUnits - 1n) / probeOutputUnits;
    return this.#simulator.getQuote(
      transportQuoteRequestSchema.parse({
        ...quoteRequest,
        amountInUnits: requiredInputUnits.toString(),
      }),
    );
  }

  async #getAndStoreOneClickDryQuote(request: OneClickDryQuoteRequest) {
    if (this.#oneClickReadOnly === undefined) {
      throw new Error('Live 1Click dry quotes are unavailable in simulator mode.');
    }
    const observation = await this.#oneClickReadOnly.getDryQuoteObservation(request);
    if (this.database === undefined) {
      throw new Error('Live 1Click observations require durable database storage.');
    }
    await storeProviderObservation(this.database.db, {
      provider: observation.quote.provider,
      operation: 'DRY_QUOTE',
      requestHash: observation.requestHash,
      responseHash: observation.responseHash,
      requestPayload: observation.rawRequest,
      responsePayload: observation.rawResponse,
      ...(observation.quote.correlationId === undefined
        ? {}
        : { correlationId: observation.quote.correlationId }),
      observedAt: observation.observedAt,
    });
    return observation.quote;
  }

  getOneClickCommittedQuote(request: OneClickCommittedQuoteRequest) {
    if (this.#oneClickCommitted === undefined) {
      throw new Error('Committed 1Click quotes are available only in mainnet mode.');
    }
    return this.#getAndStoreOneClickCommittedQuote(request);
  }

  async #getAndStoreOneClickCommittedQuote(request: OneClickCommittedQuoteRequest) {
    if (this.#oneClickCommitted === undefined) {
      throw new Error('Committed 1Click quotes are available only in mainnet mode.');
    }
    const observation = await this.#oneClickCommitted.getCommittedQuoteObservation(request);
    if (observation.quote.depositMemo !== undefined) {
      throw new Error(
        'The configured EVM source adapter cannot execute a memo-required 1Click deposit.',
      );
    }
    if (this.database === undefined) {
      throw new Error('Live 1Click observations require durable database storage.');
    }
    await storeProviderObservation(this.database.db, {
      provider: observation.quote.provider,
      operation: 'COMMITTED_QUOTE',
      requestHash: observation.requestHash,
      responseHash: observation.responseHash,
      requestPayload: observation.rawRequest,
      responsePayload: observation.rawResponse,
      ...(observation.quote.correlationId === undefined
        ? {}
        : { correlationId: observation.quote.correlationId }),
      observedAt: observation.observedAt,
    });
    return observation.quote;
  }
}

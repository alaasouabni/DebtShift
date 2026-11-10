import {
  baseUnitAmountSchema,
  basisPointsSchema,
  isoTimestampSchema,
  providerQuoteSchema,
  tokenReferenceSchema,
  type ProviderQuote,
  type TokenReference,
} from '@debtshift/domain';
import { keccak256, stringToHex } from 'viem';
import { z } from 'zod';

import {
  ProviderRequestGovernor,
  type ProviderRequestGovernorConfig,
} from './provider-resilience.js';

const OFFICIAL_ONE_CLICK_ORIGIN = 'https://1click.chaindefuser.com';
const DEFAULT_RESPONSE_LIMIT_BYTES = 1_000_000;

const oneClickTokenSchema = z
  .object({
    assetId: z.string().trim().min(1),
    decimals: z.number().int().min(0).max(255),
    blockchain: z.string().trim().min(1),
    symbol: z.string().trim().min(1),
    price: z.number().finite().nonnegative(),
    priceUpdatedAt: isoTimestampSchema,
    contractAddress: z.string().trim().min(1).optional().nullable(),
  })
  .passthrough();

const oneClickTokenCatalogSchema = z.union([
  z.array(oneClickTokenSchema),
  z.object({ tokens: z.array(oneClickTokenSchema) }).passthrough(),
]);

const oneClickQuoteSchema = z
  .object({
    depositAddress: z.string().trim().min(1).optional(),
    amountIn: baseUnitAmountSchema,
    amountInFormatted: z.string(),
    amountInUsd: z.string(),
    minAmountIn: baseUnitAmountSchema,
    amountOut: baseUnitAmountSchema,
    amountOutFormatted: z.string(),
    amountOutUsd: z.string(),
    minAmountOut: baseUnitAmountSchema,
    deadline: isoTimestampSchema.optional(),
    timeWhenInactive: isoTimestampSchema.optional(),
    timeEstimate: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

const oneClickQuoteResponseSchema = z
  .object({
    timestamp: isoTimestampSchema,
    signature: z.string().trim().min(1),
    quoteRequest: z.unknown(),
    quote: oneClickQuoteSchema,
  })
  .passthrough();

const oneClickDryQuoteRequestSchema = z
  .object({
    inputAsset: tokenReferenceSchema.refine(
      (asset) => asset.providerAssetId !== undefined,
      'Input asset requires a 1Click provider asset ID.',
    ),
    outputAsset: tokenReferenceSchema.refine(
      (asset) => asset.providerAssetId !== undefined,
      'Output asset requires a 1Click provider asset ID.',
    ),
    amountUnits: baseUnitAmountSchema.refine((amount) => BigInt(amount) > 0n),
    amountKind: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT']),
    maxSlippageBps: basisPointsSchema,
    destinationReceiver: z.string().trim().min(1),
    refundReceiver: z.string().trim().min(1),
    deadline: isoTimestampSchema,
  })
  .strict();

export type OneClickToken = z.infer<typeof oneClickTokenSchema>;
export interface OneClickTokenCatalogObservation {
  readonly tokens: readonly OneClickToken[];
  readonly requestHash: `0x${string}`;
  readonly responseHash: `0x${string}`;
  readonly rawResponse: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}
export interface OneClickDryQuoteRequest {
  readonly inputAsset: TokenReference;
  readonly outputAsset: TokenReference;
  readonly amountUnits: string;
  readonly amountKind: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  readonly maxSlippageBps: number;
  readonly destinationReceiver: string;
  readonly refundReceiver: string;
  readonly deadline: string;
}

export interface OneClickDryQuoteObservation {
  readonly quote: ProviderQuote;
  readonly requestHash: `0x${string}`;
  readonly responseHash: `0x${string}`;
  readonly rawRequest: Readonly<Record<string, unknown>>;
  readonly rawResponse: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export interface OneClickClientConfig {
  readonly baseUrl: string;
  readonly authToken?: string;
  readonly requestTimeoutMs?: number;
  readonly responseLimitBytes?: number;
  readonly allowTestEndpoint?: boolean;
  readonly fetchImplementation?: typeof fetch;
  readonly catalogCacheTtlMs?: number;
  readonly resilience?: Partial<Omit<ProviderRequestGovernorConfig, 'now' | 'sleep' | 'random'>>;
  readonly requestGovernor?: ProviderRequestGovernor;
}

export class OneClickRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OneClickRequestError';
  }
}

interface RawProviderResponse {
  readonly raw: string;
  readonly receivedAt: string;
}

/**
 * Strict, read-only 1Click client. It can fetch the catalog and dry quotes but
 * has no committed-quote, deposit, or broadcast method.
 */
export class OneClickReadOnlyClient {
  readonly #baseUrl: URL;
  readonly #authToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #responseLimitBytes: number;
  readonly #fetch: typeof fetch;
  readonly #catalogCacheTtlMs: number;
  readonly #governor: ProviderRequestGovernor;

  constructor(config: OneClickClientConfig) {
    const baseUrl = new URL(config.baseUrl);
    if (
      baseUrl.protocol !== 'https:' ||
      baseUrl.username.length > 0 ||
      baseUrl.password.length > 0 ||
      baseUrl.search.length > 0 ||
      baseUrl.hash.length > 0
    ) {
      throw new Error('1Click requires a credential-free HTTPS base URL.');
    }
    if (!config.allowTestEndpoint && baseUrl.origin !== OFFICIAL_ONE_CLICK_ORIGIN) {
      throw new Error('Live 1Click reads are pinned to the official production origin.');
    }
    const timeoutMs = config.requestTimeoutMs ?? 8_000;
    const responseLimitBytes = config.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error('1Click request timeout must be between 100 and 60,000 milliseconds.');
    }
    if (
      !Number.isInteger(responseLimitBytes) ||
      responseLimitBytes < 1_024 ||
      responseLimitBytes > 10_000_000
    ) {
      throw new Error('1Click response limit must be between 1 KB and 10 MB.');
    }
    const token = config.authToken?.trim();
    this.#baseUrl = new URL('/', baseUrl);
    this.#authToken = token === undefined || token.length === 0 ? undefined : token;
    this.#timeoutMs = timeoutMs;
    this.#responseLimitBytes = responseLimitBytes;
    this.#fetch = config.fetchImplementation ?? fetch;
    const catalogCacheTtlMs = config.catalogCacheTtlMs ?? 10 * 60 * 1_000;
    if (
      !Number.isInteger(catalogCacheTtlMs) ||
      catalogCacheTtlMs < 1_000 ||
      catalogCacheTtlMs > 24 * 60 * 60 * 1_000
    ) {
      throw new Error('1Click catalog cache TTL must be between 1 second and 24 hours.');
    }
    this.#catalogCacheTtlMs = catalogCacheTtlMs;
    this.#governor =
      config.requestGovernor ??
      new ProviderRequestGovernor({
        maximumAttempts: config.resilience?.maximumAttempts ?? 3,
        baseRetryDelayMs: config.resilience?.baseRetryDelayMs ?? 200,
        maximumRetryDelayMs: config.resilience?.maximumRetryDelayMs ?? 2_000,
        circuitFailureThreshold: config.resilience?.circuitFailureThreshold ?? 5,
        circuitResetMs: config.resilience?.circuitResetMs ?? 30_000,
        rateLimitCapacity: config.resilience?.rateLimitCapacity ?? 10,
        rateLimitWindowMs: config.resilience?.rateLimitWindowMs ?? 1_000,
        maximumCacheEntries: config.resilience?.maximumCacheEntries ?? 100,
      });
  }

  async getTokenCatalog(): Promise<readonly OneClickToken[]> {
    return (await this.getTokenCatalogObservation()).tokens;
  }

  async getTokenCatalogObservation(): Promise<OneClickTokenCatalogObservation> {
    const result = await this.#request(
      '/v0/tokens',
      { method: 'GET' },
      false,
      this.#catalogCacheTtlMs,
    );
    const rawResponse = JSON.parse(result.raw) as unknown;
    const parsed = oneClickTokenCatalogSchema.parse(rawResponse);
    return {
      tokens: Array.isArray(parsed) ? parsed : parsed.tokens,
      requestHash: keccak256(stringToHex('GET:/v0/tokens')),
      responseHash: keccak256(stringToHex(result.raw)),
      rawResponse: { body: rawResponse },
      observedAt: result.receivedAt,
    };
  }

  async getDryQuote(input: OneClickDryQuoteRequest): Promise<ProviderQuote> {
    return (await this.getDryQuoteObservation(input)).quote;
  }

  async getDryQuoteObservation(
    input: OneClickDryQuoteRequest,
  ): Promise<OneClickDryQuoteObservation> {
    if (this.#authToken === undefined) {
      throw new Error('A 1Click bearer token is required for dry quote requests.');
    }
    const request = oneClickDryQuoteRequestSchema.parse(input);
    if (Date.parse(request.deadline) <= Date.now()) {
      throw new Error('1Click dry quote deadline must be in the future.');
    }
    const body = {
      dry: true,
      swapType: request.amountKind,
      slippageTolerance: request.maxSlippageBps,
      originAsset: requireProviderAssetId(request.inputAsset),
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: requireProviderAssetId(request.outputAsset),
      amount: request.amountUnits,
      refundTo: request.refundReceiver,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.destinationReceiver,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline,
    } as const;
    const result = await this.#request(
      '/v0/quote',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      true,
    );
    const response = oneClickQuoteResponseSchema.parse(JSON.parse(result.raw));
    const quoteHash = keccak256(stringToHex(result.raw));
    const requestHash = keccak256(stringToHex(JSON.stringify(body)));
    const expiresAt = response.quote.deadline ?? request.deadline;
    const quote = providerQuoteSchema.parse({
      quoteId: `oneclick-${quoteHash.slice(2, 18)}`,
      quoteHash,
      provider: 'NEAR_INTENTS_1CLICK',
      mode: 'DRY',
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      amountInUnits: response.quote.amountIn,
      expectedAmountOutUnits: response.quote.amountOut,
      minAmountOutUnits: response.quote.minAmountOut,
      fees: [],
      destinationReceiver: request.destinationReceiver,
      refundReceiver: request.refundReceiver,
      expiresAt,
      correlationId: response.timestamp,
      rawResponseHash: quoteHash,
    });
    return {
      quote,
      requestHash,
      responseHash: quoteHash,
      rawRequest: body,
      rawResponse: response,
      observedAt: response.timestamp,
    };
  }

  async #request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    cacheTtlMs?: number,
  ): Promise<RawProviderResponse> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin)
      throw new Error('1Click URL escaped its pinned origin.');
    const body = typeof init.body === 'string' ? init.body : '';
    const requestKey = [
      'oneclick',
      init.method ?? 'GET',
      url.pathname,
      body.length === 0 ? 'no-body' : keccak256(stringToHex(body)),
    ].join(':');
    return this.#governor.execute({
      key: requestKey,
      operation: () => this.#requestOnce(url, init, authenticated),
      shouldRetry: isRetryableOneClickError,
      ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
    });
  }

  async #requestOnce(
    url: URL,
    init: RequestInit,
    authenticated: boolean,
  ): Promise<RawProviderResponse> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.#timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set('accept', 'application/json');
      if (authenticated) headers.set('authorization', `Bearer ${this.#authToken}`);
      const response = await this.#fetch(url, {
        ...init,
        headers,
        redirect: 'error',
        signal: abort.signal,
      });
      if (!response.ok) {
        throw new OneClickRequestError(
          `1Click request failed with HTTP ${response.status}.`,
          response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
        );
      }
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength !== null &&
        Number.parseInt(declaredLength, 10) > this.#responseLimitBytes
      ) {
        throw new Error('1Click response exceeded the configured size limit.');
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > this.#responseLimitBytes) {
        throw new Error('1Click response exceeded the configured size limit.');
      }
      return { raw, receivedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OneClickRequestError('1Click request timed out.', true, { cause: error });
      }
      if (error instanceof OneClickRequestError) throw error;
      if (error instanceof TypeError) {
        throw new OneClickRequestError('1Click network request failed.', true, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRetryableOneClickError(error: unknown): boolean {
  return error instanceof OneClickRequestError && error.retryable;
}

function requireProviderAssetId(asset: TokenReference): string {
  if (asset.providerAssetId === undefined) {
    throw new Error('A 1Click provider asset ID is required.');
  }
  return asset.providerAssetId;
}

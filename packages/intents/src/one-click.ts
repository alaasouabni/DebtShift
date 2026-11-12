import {
  baseUnitAmountSchema,
  basisPointsSchema,
  bytes32Schema,
  isoTimestampSchema,
  providerQuoteSchema,
  tokenReferenceSchema,
  type ProviderQuote,
  type TokenReference,
} from '@debtshift/domain';
import {
  verifyQuoteSignature as verifyOfficialQuoteSignature,
  type OneClickQuoteResponse as OfficialOneClickQuoteResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import { keccak256, stringToHex, type Hex } from 'viem';
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
    depositMemo: z.string().trim().min(1).optional(),
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
    refundFee: baseUnitAmountSchema.optional(),
    withdrawFee: baseUnitAmountSchema.optional(),
  })
  .passthrough();

const oneClickProviderQuoteRequestSchema = z
  .object({
    dry: z.boolean(),
    swapType: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT']),
    slippageTolerance: basisPointsSchema,
    originAsset: z.string().trim().min(1),
    depositType: z.literal('ORIGIN_CHAIN'),
    destinationAsset: z.string().trim().min(1),
    amount: baseUnitAmountSchema,
    refundTo: z.string().trim().min(1),
    refundType: z.literal('ORIGIN_CHAIN'),
    recipient: z.string().trim().min(1),
    recipientType: z.literal('DESTINATION_CHAIN'),
    deadline: isoTimestampSchema,
    depositMode: z.enum(['SIMPLE', 'MEMO']).optional(),
  })
  .passthrough();

const oneClickQuoteResponseSchema = z
  .object({
    correlationId: z.string().trim().min(1),
    timestamp: isoTimestampSchema,
    signature: z.string().trim().min(1),
    quoteRequest: oneClickProviderQuoteRequestSchema,
    quote: oneClickQuoteSchema,
  })
  .passthrough();

const oneClickTransactionSchema = z
  .object({
    hash: z.string().trim().min(1),
    explorerUrl: z.string().trim().min(1),
  })
  .passthrough();

const oneClickSwapDetailsSchema = z
  .object({
    intentHashes: z.array(z.string().trim().min(1)),
    nearTxHashes: z.array(z.string().trim().min(1)),
    originChainTxHashes: z.array(oneClickTransactionSchema),
    destinationChainTxHashes: z.array(oneClickTransactionSchema),
    amountIn: baseUnitAmountSchema.optional(),
    amountOut: baseUnitAmountSchema.optional(),
    refundedAmount: baseUnitAmountSchema.optional(),
    refundReason: z.string().optional(),
    depositedAmount: baseUnitAmountSchema.optional(),
  })
  .passthrough();

export const oneClickExecutionStatusSchema = z.enum([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
]);

const oneClickStatusResponseSchema = z
  .object({
    correlationId: z.string().trim().min(1),
    quoteResponse: oneClickQuoteResponseSchema,
    status: oneClickExecutionStatusSchema,
    updatedAt: isoTimestampSchema,
    swapDetails: oneClickSwapDetailsSchema,
  })
  .passthrough();

const oneClickQuoteRequestSchema = z
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

const oneClickCommittedQuoteRequestSchema = oneClickQuoteRequestSchema.extend({
  amountKind: z.literal('EXACT_INPUT'),
});

const oneClickDepositSubmissionSchema = z
  .object({
    transactionHash: bytes32Schema,
    depositAddress: z.string().trim().min(1),
    depositMemo: z.string().trim().min(1).optional(),
    nearSenderAccount: z.string().trim().min(1).optional(),
  })
  .strict();

export type OneClickToken = z.infer<typeof oneClickTokenSchema>;
export type OneClickExecutionStatus = z.infer<typeof oneClickExecutionStatusSchema>;

export interface OneClickTokenCatalogObservation {
  readonly tokens: readonly OneClickToken[];
  readonly requestHash: Hex;
  readonly responseHash: Hex;
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

export interface OneClickCommittedQuoteRequest extends OneClickDryQuoteRequest {
  readonly amountKind: 'EXACT_INPUT';
}

export interface OneClickDepositSubmission {
  readonly transactionHash: Hex;
  readonly depositAddress: string;
  readonly depositMemo?: string;
  readonly nearSenderAccount?: string;
}

interface OneClickQuoteObservation {
  readonly quote: ProviderQuote;
  readonly requestHash: Hex;
  readonly responseHash: Hex;
  readonly rawRequest: Readonly<Record<string, unknown>>;
  readonly rawResponse: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export type OneClickDryQuoteObservation = OneClickQuoteObservation;

export type OneClickCommittedQuoteObservation = OneClickQuoteObservation;

export interface OneClickStatusObservation {
  readonly status: OneClickExecutionStatus;
  readonly correlationId: string;
  readonly depositAddress: string;
  readonly depositMemo?: string;
  readonly originTransactionHashes: readonly string[];
  readonly destinationTransactionHashes: readonly string[];
  readonly nearTransactionHashes: readonly string[];
  readonly amountInUnits?: string;
  readonly amountOutUnits?: string;
  readonly refundedAmountUnits?: string;
  readonly depositedAmountUnits?: string;
  readonly refundReason?: string;
  readonly requestHash: Hex;
  readonly responseHash: Hex;
  readonly rawRequest: Readonly<Record<string, unknown>>;
  readonly rawResponse: Readonly<Record<string, unknown>>;
  readonly providerUpdatedAt: string;
  readonly observedAt: string;
}

export type OneClickQuoteSignatureVerifier = (response: OfficialOneClickQuoteResponse) => boolean;

export interface OneClickClientConfig {
  readonly baseUrl: string;
  readonly authToken?: string;
  readonly requestTimeoutMs?: number;
  readonly responseLimitBytes?: number;
  readonly allowTestEndpoint?: boolean;
  readonly fetchImplementation?: typeof fetch;
  readonly catalogCacheTtlMs?: number;
  readonly signatureVerifier?: OneClickQuoteSignatureVerifier;
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

interface OneClickRuntime {
  readonly http: OneClickHttpClient;
  readonly catalogCacheTtlMs: number;
  readonly signatureVerifier: OneClickQuoteSignatureVerifier;
}

/**
 * Strict, read-only 1Click client. It can fetch the catalog and signed dry
 * quotes but deliberately exposes no committed quote or deposit method.
 */
export class OneClickReadOnlyClient {
  readonly #runtime: OneClickRuntime;

  constructor(config: OneClickClientConfig) {
    this.#runtime = createRuntime(config);
  }

  async getTokenCatalog(): Promise<readonly OneClickToken[]> {
    return (await this.getTokenCatalogObservation()).tokens;
  }

  async getTokenCatalogObservation(): Promise<OneClickTokenCatalogObservation> {
    const result = await this.#runtime.http.request(
      '/v0/tokens',
      { method: 'GET' },
      false,
      this.#runtime.catalogCacheTtlMs,
    );
    const rawResponse = parseJson(result.raw);
    const parsed = oneClickTokenCatalogSchema.parse(rawResponse);
    return {
      tokens: Array.isArray(parsed) ? parsed : parsed.tokens,
      requestHash: hashJson({ method: 'GET', path: '/v0/tokens' }),
      responseHash: keccak256(stringToHex(result.raw)),
      rawResponse: asRecord(rawResponse),
      observedAt: result.receivedAt,
    };
  }

  async getDryQuote(input: OneClickDryQuoteRequest): Promise<ProviderQuote> {
    return (await this.getDryQuoteObservation(input)).quote;
  }

  async getDryQuoteObservation(
    input: OneClickDryQuoteRequest,
  ): Promise<OneClickDryQuoteObservation> {
    const request = oneClickQuoteRequestSchema.parse(input);
    assertFutureDeadline(request.deadline);
    const body = buildProviderQuoteRequest(request, true);
    const result = await this.#runtime.http.request(
      '/v0/quote',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      true,
    );
    const response = parseVerifiedQuoteResponse(result.raw, body, this.#runtime.signatureVerifier);
    if (response.quote.depositAddress !== undefined) {
      throw new Error('A dry 1Click quote unexpectedly created a deposit address.');
    }
    return mapQuoteObservation(request, body, response, result, 'DRY');
  }
}

/**
 * Write-capable 1Click client for the production composition root. Constructing
 * this object does not bypass the server-side execution gate; callers must
 * enforce that gate before requesting a committed quote or submitting a hash.
 */
export class OneClickCommittedClient {
  readonly #runtime: OneClickRuntime;

  constructor(config: OneClickClientConfig) {
    this.#runtime = createRuntime(config);
  }

  async getCommittedQuote(input: OneClickCommittedQuoteRequest): Promise<ProviderQuote> {
    return (await this.getCommittedQuoteObservation(input)).quote;
  }

  async getCommittedQuoteObservation(
    input: OneClickCommittedQuoteRequest,
  ): Promise<OneClickCommittedQuoteObservation> {
    const request = oneClickCommittedQuoteRequestSchema.parse(input);
    assertFutureDeadline(request.deadline);
    const body = buildProviderQuoteRequest(request, false);
    const result = await this.#runtime.http.request(
      '/v0/quote',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      true,
    );
    const response = parseVerifiedQuoteResponse(result.raw, body, this.#runtime.signatureVerifier);
    if (response.quote.depositAddress === undefined) {
      throw new Error('A committed 1Click quote did not contain a deposit address.');
    }
    if (response.quote.amountIn !== request.amountUnits) {
      throw new Error('Committed 1Click exact-input amount does not match the request.');
    }
    return mapQuoteObservation(request, body, response, result, 'COMMITTED');
  }

  async submitDepositTransaction(
    input: OneClickDepositSubmission,
  ): Promise<OneClickStatusObservation> {
    const submission = oneClickDepositSubmissionSchema.parse(input);
    const body = {
      txHash: submission.transactionHash,
      depositAddress: submission.depositAddress,
      ...(submission.nearSenderAccount === undefined
        ? {}
        : { nearSenderAccount: submission.nearSenderAccount }),
      ...(submission.depositMemo === undefined ? {} : { memo: submission.depositMemo }),
    };
    const result = await this.#runtime.http.request(
      '/v0/deposit/submit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      true,
    );
    return parseStatusObservation(
      result,
      body,
      submission.depositAddress,
      submission.depositMemo,
      this.#runtime.signatureVerifier,
    );
  }

  async getStatus(
    depositAddress: string,
    depositMemo?: string,
  ): Promise<OneClickStatusObservation> {
    const request = z
      .object({
        depositAddress: z.string().trim().min(1),
        depositMemo: z.string().trim().min(1).optional(),
      })
      .strict()
      .parse({
        depositAddress,
        ...(depositMemo === undefined ? {} : { depositMemo }),
      });
    const query = new URLSearchParams({ depositAddress: request.depositAddress });
    if (request.depositMemo !== undefined) query.set('depositMemo', request.depositMemo);
    const rawRequest = {
      method: 'GET',
      path: '/v0/status',
      depositAddress: request.depositAddress,
      ...(request.depositMemo === undefined ? {} : { depositMemo: request.depositMemo }),
    };
    const result = await this.#runtime.http.request(
      `/v0/status?${query.toString()}`,
      { method: 'GET' },
      true,
    );
    return parseStatusObservation(
      result,
      rawRequest,
      request.depositAddress,
      request.depositMemo,
      this.#runtime.signatureVerifier,
    );
  }
}

class OneClickHttpClient {
  readonly #baseUrl: URL;
  readonly #authToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #responseLimitBytes: number;
  readonly #fetch: typeof fetch;
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

  async request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    cacheTtlMs?: number,
  ): Promise<RawProviderResponse> {
    if (authenticated && this.#authToken === undefined) {
      throw new Error('A 1Click bearer token is required for authenticated requests.');
    }
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new Error('1Click URL escaped its pinned origin.');
    }
    const body = typeof init.body === 'string' ? init.body : '';
    const requestKey = [
      'oneclick',
      init.method ?? 'GET',
      url.pathname,
      url.search.length === 0 ? 'no-query' : keccak256(stringToHex(url.search)),
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

function createRuntime(config: OneClickClientConfig): OneClickRuntime {
  const catalogCacheTtlMs = config.catalogCacheTtlMs ?? 10 * 60 * 1_000;
  if (
    !Number.isInteger(catalogCacheTtlMs) ||
    catalogCacheTtlMs < 1_000 ||
    catalogCacheTtlMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error('1Click catalog cache TTL must be between 1 second and 24 hours.');
  }
  return {
    http: new OneClickHttpClient(config),
    catalogCacheTtlMs,
    signatureVerifier: config.signatureVerifier ?? verifyOfficialQuoteSignature,
  };
}

function buildProviderQuoteRequest(
  request: z.infer<typeof oneClickQuoteRequestSchema>,
  dry: boolean,
): Readonly<Record<string, unknown>> {
  return {
    dry,
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
  };
}

function parseVerifiedQuoteResponse(
  raw: string,
  request: Readonly<Record<string, unknown>>,
  signatureVerifier: OneClickQuoteSignatureVerifier,
): z.infer<typeof oneClickQuoteResponseSchema> {
  const response = oneClickQuoteResponseSchema.parse(parseJson(raw));
  assertEchoedRequest(request, response.quoteRequest);
  assertValidSignature(response, signatureVerifier);
  return response;
}

function mapQuoteObservation(
  request: z.infer<typeof oneClickQuoteRequestSchema>,
  rawRequest: Readonly<Record<string, unknown>>,
  response: z.infer<typeof oneClickQuoteResponseSchema>,
  result: RawProviderResponse,
  mode: 'DRY' | 'COMMITTED',
): OneClickQuoteObservation {
  const responseHash = keccak256(stringToHex(result.raw));
  const expiresAt = response.quote.deadline ?? request.deadline;
  const quote = providerQuoteSchema.parse({
    quoteId: `oneclick-${response.correlationId}`,
    quoteHash: responseHash,
    provider: 'NEAR_INTENTS_1CLICK',
    mode,
    inputAsset: request.inputAsset,
    outputAsset: request.outputAsset,
    amountInUnits: response.quote.amountIn,
    expectedAmountOutUnits: response.quote.amountOut,
    minAmountOutUnits: response.quote.minAmountOut,
    fees: [],
    destinationReceiver: request.destinationReceiver,
    refundReceiver: request.refundReceiver,
    ...(response.quote.depositAddress === undefined
      ? {}
      : { depositAddress: response.quote.depositAddress }),
    ...(response.quote.depositMemo === undefined
      ? {}
      : { depositMemo: response.quote.depositMemo }),
    expiresAt,
    correlationId: response.correlationId,
    rawResponseHash: responseHash,
  });
  return {
    quote,
    requestHash: hashJson(rawRequest),
    responseHash,
    rawRequest,
    rawResponse: response,
    observedAt: result.receivedAt,
  };
}

function parseStatusObservation(
  result: RawProviderResponse,
  rawRequest: Readonly<Record<string, unknown>>,
  expectedDepositAddress: string,
  expectedDepositMemo: string | undefined,
  signatureVerifier: OneClickQuoteSignatureVerifier,
): OneClickStatusObservation {
  const response = oneClickStatusResponseSchema.parse(parseJson(result.raw));
  assertValidSignature(response.quoteResponse, signatureVerifier);
  const quote = response.quoteResponse.quote;
  if (quote.depositAddress !== expectedDepositAddress) {
    throw new Error('1Click status response deposit address does not match the requested quote.');
  }
  if (quote.depositMemo !== expectedDepositMemo) {
    throw new Error('1Click status response deposit memo does not match the requested quote.');
  }
  return {
    status: response.status,
    correlationId: response.correlationId,
    depositAddress: expectedDepositAddress,
    ...(expectedDepositMemo === undefined ? {} : { depositMemo: expectedDepositMemo }),
    originTransactionHashes: response.swapDetails.originChainTxHashes.map(({ hash }) => hash),
    destinationTransactionHashes: response.swapDetails.destinationChainTxHashes.map(
      ({ hash }) => hash,
    ),
    nearTransactionHashes: response.swapDetails.nearTxHashes,
    ...(response.swapDetails.amountIn === undefined
      ? {}
      : { amountInUnits: response.swapDetails.amountIn }),
    ...(response.swapDetails.amountOut === undefined
      ? {}
      : { amountOutUnits: response.swapDetails.amountOut }),
    ...(response.swapDetails.refundedAmount === undefined
      ? {}
      : { refundedAmountUnits: response.swapDetails.refundedAmount }),
    ...(response.swapDetails.depositedAmount === undefined
      ? {}
      : { depositedAmountUnits: response.swapDetails.depositedAmount }),
    ...(response.swapDetails.refundReason === undefined
      ? {}
      : { refundReason: response.swapDetails.refundReason }),
    requestHash: hashJson(rawRequest),
    responseHash: keccak256(stringToHex(result.raw)),
    rawRequest,
    rawResponse: response,
    providerUpdatedAt: response.updatedAt,
    observedAt: result.receivedAt,
  };
}

function assertValidSignature(
  response: z.infer<typeof oneClickQuoteResponseSchema>,
  signatureVerifier: OneClickQuoteSignatureVerifier,
): void {
  let valid: boolean;
  try {
    valid = signatureVerifier(response as OfficialOneClickQuoteResponse);
  } catch (error) {
    throw new Error('1Click quote signature verification failed.', { cause: error });
  }
  if (!valid) throw new Error('1Click quote signature is invalid.');
}

function assertEchoedRequest(
  request: Readonly<Record<string, unknown>>,
  echoed: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(request)) {
    if (echoed[key] !== value) {
      throw new Error(`1Click quote echoed a mismatched ${key} field.`);
    }
  }
}

function assertFutureDeadline(deadline: string): void {
  if (Date.parse(deadline) <= Date.now()) {
    throw new Error('1Click quote deadline must be in the future.');
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('1Click returned invalid JSON.', { cause: error });
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { body: value };
  }
  return value as Readonly<Record<string, unknown>>;
}

function hashJson(value: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(value)));
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

import { hashCanonicalText } from '@debtshift/domain';
import { getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { z } from 'zod';

const DEFAULT_MORPHO_API_ORIGIN = 'https://api.morpho.org';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 2_000_000;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAXIMUM_PAGES = 20;

const digitsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const addressTextSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32TextSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const morphoApiMarketSchema = z
  .object({
    chain_id: z.number().int().positive(),
    market_id: bytes32TextSchema,
    loan_token: addressTextSchema,
    collateral_token: addressTextSchema,
    oracle_address: addressTextSchema,
    irm_address: addressTextSchema,
    lltv_wad: digitsSchema,
    creation_block_number: digitsSchema,
    creation_timestamp: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const morphoApiMarketPageSchema = z
  .object({
    data: z.array(morphoApiMarketSchema).max(DEFAULT_PAGE_SIZE),
    cursor: z.string().min(1).max(16_384).nullable(),
  })
  .passthrough();

export interface DiscoveredMorphoMarket {
  readonly chainId: number;
  readonly marketId: Hex;
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltvWad: string;
  readonly creationBlockNumber: string;
  readonly creationTimestamp?: number;
}

export interface MorphoMarketDiscoveryRequest {
  readonly chainId: number;
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly listed?: boolean;
}

export interface MorphoMarketDiscoveryObservation {
  readonly provider: 'MORPHO_REST_INDEX';
  readonly requestHash: Hex;
  readonly responseHashes: readonly Hex[];
  readonly observedAt: string;
  readonly pages: number;
  readonly markets: readonly DiscoveredMorphoMarket[];
}

export interface MorphoMarketDiscoveryClientOptions {
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly responseLimitBytes?: number;
  readonly pageSize?: number;
  readonly maximumPages?: number;
  readonly allowTestEndpoint?: boolean;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * Morpho's index is discovery-only. Every returned market must still be
 * re-read from the configured Morpho singleton before it becomes a route
 * candidate or execution input.
 */
export class MorphoMarketDiscoveryClient {
  readonly #baseUrl: URL;
  readonly #requestTimeoutMs: number;
  readonly #responseLimitBytes: number;
  readonly #pageSize: number;
  readonly #maximumPages: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: MorphoMarketDiscoveryClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_MORPHO_API_ORIGIN,
      options.allowTestEndpoint ?? false,
    );
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      100,
      60_000,
      'Morpho request timeout',
    );
    this.#responseLimitBytes = boundedInteger(
      options.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES,
      1_024,
      10_000_000,
      'Morpho response limit',
    );
    this.#pageSize = boundedInteger(
      options.pageSize ?? DEFAULT_PAGE_SIZE,
      1,
      DEFAULT_PAGE_SIZE,
      'Morpho page size',
    );
    this.#maximumPages = boundedInteger(
      options.maximumPages ?? DEFAULT_MAXIMUM_PAGES,
      1,
      100,
      'Morpho maximum pages',
    );
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async discoverMarkets(
    input: MorphoMarketDiscoveryRequest,
  ): Promise<MorphoMarketDiscoveryObservation> {
    if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
      throw new Error('Morpho discovery chain ID must be a positive integer.');
    }
    const loanToken = getAddress(input.loanToken);
    const collateralToken = getAddress(input.collateralToken);
    if (isAddressEqual(loanToken, collateralToken)) {
      throw new Error('Morpho discovery loan and collateral tokens must differ.');
    }
    const listed = input.listed ?? true;
    const requestIdentity = {
      chainId: input.chainId,
      loanToken,
      collateralToken,
      listed,
      pageSize: this.#pageSize,
    } as const;
    const responseHashes: Hex[] = [];
    const markets = new Map<string, DiscoveredMorphoMarket>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    while (pages < this.#maximumPages) {
      const url = new URL('/v0/blue/markets', this.#baseUrl);
      url.searchParams.set('chain_id', input.chainId.toString());
      url.searchParams.set('loan_token', `${input.chainId}:${loanToken}`);
      url.searchParams.set('collateral_token', collateralToken);
      url.searchParams.set('listed', listed.toString());
      url.searchParams.set('limit', this.#pageSize.toString());
      if (cursor !== undefined) url.searchParams.set('cursor', cursor);

      const raw = await this.#get(url);
      responseHashes.push(hashCanonicalText(raw));
      const page = morphoApiMarketPageSchema.parse(JSON.parse(raw));
      pages += 1;
      for (const rawMarket of page.data) {
        const market = normalizeMarket(rawMarket);
        assertRequestedMarket(market, input.chainId, loanToken, collateralToken);
        const key = market.marketId.toLowerCase();
        const previous = markets.get(key);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(market)) {
          throw new Error(
            `Morpho discovery returned conflicting rows for market ${market.marketId}.`,
          );
        }
        markets.set(key, market);
      }

      if (page.cursor === null) {
        return {
          provider: 'MORPHO_REST_INDEX',
          requestHash: hashCanonicalText(JSON.stringify(requestIdentity)),
          responseHashes,
          observedAt: this.#now().toISOString(),
          pages,
          markets: [...markets.values()].sort((left, right) =>
            left.marketId.localeCompare(right.marketId),
          ),
        };
      }
      if (seenCursors.has(page.cursor)) {
        throw new Error('Morpho discovery returned a repeated pagination cursor.');
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }

    throw new Error('Morpho discovery exceeded the configured pagination limit.');
  }

  async #get(url: URL): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        throw new Error(`Morpho discovery request failed with status ${response.status}.`);
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > this.#responseLimitBytes) {
        throw new Error('Morpho discovery response exceeded the configured size limit.');
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > this.#responseLimitBytes) {
        throw new Error('Morpho discovery response exceeded the configured size limit.');
      }
      return raw;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeMarket(raw: z.infer<typeof morphoApiMarketSchema>): DiscoveredMorphoMarket {
  return {
    chainId: raw.chain_id,
    marketId: raw.market_id.toLowerCase() as Hex,
    loanToken: getAddress(raw.loan_token),
    collateralToken: getAddress(raw.collateral_token),
    oracle: getAddress(raw.oracle_address),
    irm: getAddress(raw.irm_address),
    lltvWad: raw.lltv_wad,
    creationBlockNumber: raw.creation_block_number,
    ...(raw.creation_timestamp === undefined ? {} : { creationTimestamp: raw.creation_timestamp }),
  };
}

function assertRequestedMarket(
  market: DiscoveredMorphoMarket,
  chainId: number,
  loanToken: Address,
  collateralToken: Address,
): void {
  if (
    market.chainId !== chainId ||
    !isAddressEqual(market.loanToken, loanToken) ||
    !isAddressEqual(market.collateralToken, collateralToken)
  ) {
    throw new Error('Morpho discovery returned a market outside the requested asset boundary.');
  }
}

function normalizeBaseUrl(value: string, allowTestEndpoint: boolean): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(allowTestEndpoint && url.protocol === 'http:')) {
    throw new Error('Morpho discovery endpoint must use HTTPS.');
  }
  if (!allowTestEndpoint && url.origin !== DEFAULT_MORPHO_API_ORIGIN) {
    throw new Error('Morpho discovery is pinned to the official API origin.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

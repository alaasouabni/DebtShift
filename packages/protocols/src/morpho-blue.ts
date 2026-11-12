import {
  hashCanonicalText,
  marketSnapshotSchema,
  tokenReferenceSchema,
  type MarketSnapshot,
  type TokenReference,
} from '@debtshift/domain';
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToNumber,
  isAddressEqual,
  keccak256,
  size,
  sliceHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { ERC20_METADATA_ABI, type PreparedEvmTransaction } from './aave-v3.js';

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1_000_000n;
const SECONDS_PER_YEAR = 365n * 86_400n;

const MARKET_PARAMS_COMPONENTS = [
  { name: 'loanToken', type: 'address' },
  { name: 'collateralToken', type: 'address' },
  { name: 'oracle', type: 'address' },
  { name: 'irm', type: 'address' },
  { name: 'lltv', type: 'uint256' },
] as const;

const MARKET_COMPONENTS = [
  { name: 'totalSupplyAssets', type: 'uint128' },
  { name: 'totalSupplyShares', type: 'uint128' },
  { name: 'totalBorrowAssets', type: 'uint128' },
  { name: 'totalBorrowShares', type: 'uint128' },
  { name: 'lastUpdate', type: 'uint128' },
  { name: 'fee', type: 'uint128' },
] as const;

const AUTHORIZATION_COMPONENTS = [
  { name: 'authorizer', type: 'address' },
  { name: 'authorized', type: 'address' },
  { name: 'isAuthorized', type: 'bool' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const;

const SIGNATURE_COMPONENTS = [
  { name: 'v', type: 'uint8' },
  { name: 'r', type: 'bytes32' },
  { name: 's', type: 'bytes32' },
] as const;

export const MORPHO_AUTHORIZATION_TYPES = {
  Authorization: AUTHORIZATION_COMPONENTS,
} as const;

export const MORPHO_AUTHORIZATION_PAIR_PARAMETERS = [
  { name: 'enable', type: 'tuple', components: AUTHORIZATION_COMPONENTS },
  { name: 'enableSignature', type: 'tuple', components: SIGNATURE_COMPONENTS },
  { name: 'disable', type: 'tuple', components: AUTHORIZATION_COMPONENTS },
  { name: 'disableSignature', type: 'tuple', components: SIGNATURE_COMPONENTS },
] as const;

export const MORPHO_BLUE_READ_ABI = [
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: MARKET_PARAMS_COMPONENTS,
  },
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: MARKET_COMPONENTS,
  },
  {
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [{ name: 'authorizer', type: 'address' }],
    outputs: [{ name: 'nonce', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isAuthorized',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'authorized', type: 'address' },
    ],
    outputs: [{ name: 'authorized', type: 'bool' }],
  },
] as const;

export const MORPHO_BLUE_WRITE_ABI = [
  {
    type: 'function',
    name: 'supplyCollateral',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketParams', type: 'tuple', components: MARKET_PARAMS_COMPONENTS },
      { name: 'assets', type: 'uint256' },
      { name: 'onBehalf', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'borrow',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketParams', type: 'tuple', components: MARKET_PARAMS_COMPONENTS },
      { name: 'assets', type: 'uint256' },
      { name: 'shares', type: 'uint256' },
      { name: 'onBehalf', type: 'address' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [
      { name: 'assetsBorrowed', type: 'uint256' },
      { name: 'sharesBorrowed', type: 'uint256' },
    ],
  },
] as const;

const MORPHO_IRM_ABI = [
  {
    type: 'function',
    name: 'borrowRateView',
    stateMutability: 'view',
    inputs: [
      { name: 'marketParams', type: 'tuple', components: MARKET_PARAMS_COMPONENTS },
      { name: 'market', type: 'tuple', components: MARKET_COMPONENTS },
    ],
    outputs: [{ name: 'borrowRate', type: 'uint256' }],
  },
] as const;

const MORPHO_ORACLE_ABI = [
  {
    type: 'function',
    name: 'price',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'price', type: 'uint256' }],
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

export interface MorphoMarketParams {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: bigint;
}

export interface MorphoAuthorization {
  readonly authorizer: Address;
  readonly authorized: Address;
  readonly isAuthorized: boolean;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface MorphoAuthorizationPair {
  readonly enable: MorphoAuthorization;
  readonly disable: MorphoAuthorization;
}

export interface MorphoMarketState {
  readonly totalSupplyAssets: bigint;
  readonly totalSupplyShares: bigint;
  readonly totalBorrowAssets: bigint;
  readonly totalBorrowShares: bigint;
  readonly lastUpdate: bigint;
  readonly fee: bigint;
}

export interface MorphoOracleFreshnessReader {
  readUpdatedAt(input: {
    readonly oracle: Address;
    readonly blockNumber: bigint;
    readonly blockObservedAt: string;
  }): Promise<{ readonly updatedAt: string; readonly provenance: string }>;
}

export interface MorphoBlueAdapterConfig {
  readonly chainId: number;
  readonly morpho: Address;
}

export interface MorphoMarketObservation {
  readonly snapshot: MarketSnapshot;
  readonly marketId: Hex;
  readonly params: MorphoMarketParams;
  readonly accruedMarket: MorphoMarketState;
  readonly availableBorrowUnits: string;
  readonly currentBorrowAprBps: number;
  readonly projectedBorrowAprBps: number;
  readonly currentBorrowRatePerSecondWad: string;
  readonly projectedBorrowRatePerSecondWad: string;
  readonly requestedBorrowUnits: string;
  readonly blockNumber: string;
  readonly oracleFreshnessProvenance: string;
}

export interface MorphoPositionObservation {
  readonly market: MorphoMarketObservation;
  readonly borrower: Address;
  readonly supplyShares: string;
  readonly borrowShares: string;
  readonly collateralUnits: string;
  readonly debtUnits: string;
  readonly ltvBps?: number;
}

export class MorphoBlueReadAdapter {
  readonly #morpho: Address;

  constructor(
    private readonly client: PublicClient,
    private readonly config: MorphoBlueAdapterConfig,
    private readonly oracleFreshness: MorphoOracleFreshnessReader,
  ) {
    this.#morpho = getAddress(config.morpho);
  }

  async readMarket(
    marketIdInput: Hex,
    requestedBorrowUnits: bigint,
  ): Promise<MorphoMarketObservation> {
    if (requestedBorrowUnits < 0n) throw new Error('Requested Morpho borrow cannot be negative.');
    const marketId = marketIdInput;
    const [actualChainId, block] = await Promise.all([
      this.client.getChainId(),
      this.client.getBlock({ blockTag: 'latest' }),
    ]);
    if (actualChainId !== this.config.chainId) {
      throw new Error(
        `Morpho RPC chain mismatch: expected ${this.config.chainId}, received ${actualChainId}.`,
      );
    }
    if (block.hash === null) throw new Error('Morpho market block is not canonical.');
    const blockNumber = block.number;
    const [paramsResult, marketResult] = await Promise.all([
      this.client.readContract({
        address: this.#morpho,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'idToMarketParams',
        args: [marketId],
        blockNumber,
      }),
      this.client.readContract({
        address: this.#morpho,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'market',
        args: [marketId],
        blockNumber,
      }),
    ]);
    const params = normalizeMarketParams(paramsResult);
    if (morphoMarketId(params) !== marketId) {
      throw new Error(
        'Morpho returned market parameters that do not derive the requested market ID.',
      );
    }
    const storedMarket = normalizeMarketState(marketResult);
    if (storedMarket.lastUpdate === 0n)
      throw new Error('The requested Morpho market is not initialized.');
    const observedAt = new Date(Number(block.timestamp) * 1_000).toISOString();
    const [initialRate, price, singletonLoanBalance, loanToken, collateralToken, freshness] =
      await Promise.all([
        this.#readBorrowRate(params, storedMarket, blockNumber),
        this.client.readContract({
          address: params.oracle,
          abi: MORPHO_ORACLE_ABI,
          functionName: 'price',
          blockNumber,
        }),
        this.client.readContract({
          address: params.loanToken,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [this.#morpho],
          blockNumber,
        }),
        this.#readToken(params.loanToken, blockNumber),
        this.#readToken(params.collateralToken, blockNumber),
        this.oracleFreshness.readUpdatedAt({
          oracle: params.oracle,
          blockNumber,
          blockObservedAt: observedAt,
        }),
      ]);
    if (price <= 0n) throw new Error('Morpho oracle returned a non-positive price.');
    if (Date.parse(freshness.updatedAt) > Date.parse(observedAt)) {
      throw new Error('Morpho oracle freshness timestamp is after the observed block.');
    }
    const accruedMarket = accrueMarket(storedMarket, initialRate, block.timestamp);
    const currentRate = await this.#readBorrowRate(params, accruedMarket, blockNumber);
    const projectedMarket = projectBorrow(accruedMarket, requestedBorrowUnits);
    const projectedRate = await this.#readBorrowRate(params, projectedMarket, blockNumber);
    const marketLiquidity = zeroFloorSubtract(
      accruedMarket.totalSupplyAssets,
      accruedMarket.totalBorrowAssets,
    );
    const availableBorrow =
      singletonLoanBalance < marketLiquidity ? singletonLoanBalance : marketLiquidity;
    const lltvBps = wadToBpsFloor(params.lltv);
    const blockReference = { number: blockNumber.toString(), hash: block.hash, observedAt };
    const snapshot = marketSnapshotSchema.parse({
      snapshotId: hashCanonicalText(
        `debtshift.morpho-market-snapshot.v1:${this.config.chainId}:${marketId}:${block.hash}`,
      ),
      market: {
        chainId: this.config.chainId,
        protocol: 'MORPHO_BLUE',
        deployment: this.#morpho,
        marketId,
      },
      collateralAsset: collateralToken,
      debtAsset: loanToken,
      borrowAprBps: ratePerSecondToApyBps(currentRate),
      availableBorrowUnits: availableBorrow.toString(),
      lltvBps,
      oracle: {
        oracle: `${params.oracle}:${freshness.provenance}`,
        priceMantissa: price.toString(),
        priceDecimals: 36,
        updatedAt: freshness.updatedAt,
        block: blockReference,
      },
      block: blockReference,
    });
    return {
      snapshot,
      marketId,
      params,
      accruedMarket,
      availableBorrowUnits: availableBorrow.toString(),
      currentBorrowAprBps: ratePerSecondToApyBps(currentRate),
      projectedBorrowAprBps: ratePerSecondToApyBps(projectedRate),
      currentBorrowRatePerSecondWad: currentRate.toString(),
      projectedBorrowRatePerSecondWad: projectedRate.toString(),
      requestedBorrowUnits: requestedBorrowUnits.toString(),
      blockNumber: blockNumber.toString(),
      oracleFreshnessProvenance: freshness.provenance,
    };
  }

  async readPosition(marketId: Hex, borrowerInput: Address): Promise<MorphoPositionObservation> {
    const borrower = getAddress(borrowerInput);
    const market = await this.readMarket(marketId, 0n);
    const position = await this.client.readContract({
      address: this.#morpho,
      abi: MORPHO_BLUE_READ_ABI,
      functionName: 'position',
      args: [marketId, borrower],
      blockNumber: BigInt(market.blockNumber),
    });
    const debtUnits = toAssetsUp(
      position[1],
      market.accruedMarket.totalBorrowAssets,
      market.accruedMarket.totalBorrowShares,
    );
    const price = BigInt(market.snapshot.oracle.priceMantissa);
    const collateralValueInLoanUnits = (position[2] * price) / ORACLE_PRICE_SCALE;
    const ltvBps =
      collateralValueInLoanUnits === 0n
        ? undefined
        : Number(ceilDiv(debtUnits * 10_000n, collateralValueInLoanUnits));
    return {
      market,
      borrower,
      supplyShares: position[0].toString(),
      borrowShares: position[1].toString(),
      collateralUnits: position[2].toString(),
      debtUnits: debtUnits.toString(),
      ...(ltvBps === undefined ? {} : { ltvBps }),
    };
  }

  async #readBorrowRate(
    params: MorphoMarketParams,
    market: MorphoMarketState,
    blockNumber: bigint,
  ): Promise<bigint> {
    if (isAddressEqual(params.irm, zeroAddress)) return 0n;
    return this.client.readContract({
      address: params.irm,
      abi: MORPHO_IRM_ABI,
      functionName: 'borrowRateView',
      args: [params, market],
      blockNumber,
    });
  }

  async #readToken(addressInput: Address, blockNumber: bigint): Promise<TokenReference> {
    const address = getAddress(addressInput);
    const [decimals, symbol] = await Promise.all([
      this.client.readContract({
        address,
        abi: ERC20_METADATA_ABI,
        functionName: 'decimals',
        blockNumber,
      }),
      this.client.readContract({
        address,
        abi: ERC20_METADATA_ABI,
        functionName: 'symbol',
        blockNumber,
      }),
    ]);
    return tokenReferenceSchema.parse({
      chainId: this.config.chainId,
      address,
      decimals,
      symbol,
    });
  }
}

export interface MorphoOpenPositionRequest {
  readonly caller: Address;
  readonly borrower: Address;
  readonly debtReceiver: Address;
  readonly collateralUnits: bigint;
  readonly borrowUnits: bigint;
}

export interface PreparedMorphoOpenPosition {
  readonly marketId: Hex;
  readonly requiresMorphoAuthorization: boolean;
  readonly transactions: readonly PreparedEvmTransaction[];
}

export function buildMorphoAuthorizationPair(
  authorizerInput: Address,
  authorizedInput: Address,
  startingNonce: bigint,
  deadline: bigint,
): MorphoAuthorizationPair {
  if (startingNonce < 0n) throw new Error('Morpho authorization nonce cannot be negative.');
  if (deadline <= 0n) throw new Error('Morpho authorization deadline must be positive.');
  const authorizer = getAddress(authorizerInput);
  const authorized = getAddress(authorizedInput);
  return {
    enable: {
      authorizer,
      authorized,
      isAuthorized: true,
      nonce: startingNonce,
      deadline,
    },
    disable: {
      authorizer,
      authorized,
      isAuthorized: false,
      nonce: startingNonce + 1n,
      deadline,
    },
  };
}

export function morphoAuthorizationTypedData(
  chainId: number,
  morphoInput: Address,
  authorization: MorphoAuthorization,
) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('Morpho authorization chain ID must be a positive safe integer.');
  }
  return {
    domain: {
      chainId,
      verifyingContract: getAddress(morphoInput),
    },
    types: MORPHO_AUTHORIZATION_TYPES,
    primaryType: 'Authorization',
    message: authorization,
  } as const;
}

export function encodeMorphoAuthorizationPair(
  pair: MorphoAuthorizationPair,
  enableSignature: Hex,
  disableSignature: Hex,
): Hex {
  assertAuthorizationPair(pair);
  return encodeAbiParameters(MORPHO_AUTHORIZATION_PAIR_PARAMETERS, [
    pair.enable,
    splitMorphoSignature(enableSignature),
    pair.disable,
    splitMorphoSignature(disableSignature),
  ]);
}

export function buildMorphoOpenPositionTransactions(
  morphoInput: Address,
  paramsInput: MorphoMarketParams,
  request: MorphoOpenPositionRequest,
): PreparedMorphoOpenPosition {
  if (request.collateralUnits <= 0n || request.borrowUnits <= 0n) {
    throw new Error('Morpho open-position amounts must be positive.');
  }
  const morpho = getAddress(morphoInput);
  const params = normalizeMarketParams([
    paramsInput.loanToken,
    paramsInput.collateralToken,
    paramsInput.oracle,
    paramsInput.irm,
    paramsInput.lltv,
  ]);
  const caller = getAddress(request.caller);
  const borrower = getAddress(request.borrower);
  const receiver = getAddress(request.debtReceiver);
  return {
    marketId: morphoMarketId(params),
    requiresMorphoAuthorization: !isAddressEqual(caller, borrower),
    transactions: [
      {
        to: params.collateralToken,
        data: encodeFunctionData({
          abi: ERC20_METADATA_ABI,
          functionName: 'approve',
          args: [morpho, request.collateralUnits],
        }),
        value: 0n,
        description: 'Approve the exact collateral amount to Morpho Blue.',
      },
      {
        to: morpho,
        data: encodeFunctionData({
          abi: MORPHO_BLUE_WRITE_ABI,
          functionName: 'supplyCollateral',
          args: [params, request.collateralUnits, borrower, '0x'],
        }),
        value: 0n,
        description: 'Supply collateral to the exact derived Morpho market.',
      },
      {
        to: morpho,
        data: encodeFunctionData({
          abi: MORPHO_BLUE_WRITE_ABI,
          functionName: 'borrow',
          args: [params, request.borrowUnits, 0n, borrower, receiver],
        }),
        value: 0n,
        description: 'Borrow the bounded loan amount to the signed receiver.',
      },
    ],
  };
}

function assertAuthorizationPair(pair: MorphoAuthorizationPair): void {
  if (
    !isAddressEqual(pair.enable.authorizer, pair.disable.authorizer) ||
    !isAddressEqual(pair.enable.authorized, pair.disable.authorized) ||
    !pair.enable.isAuthorized ||
    pair.disable.isAuthorized ||
    pair.enable.nonce < 0n ||
    pair.disable.nonce !== pair.enable.nonce + 1n ||
    pair.enable.deadline <= 0n ||
    pair.disable.deadline <= 0n
  ) {
    throw new Error('Invalid consecutive Morpho enable/disable authorization pair.');
  }
}

function splitMorphoSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  if (size(signature) !== 65) throw new Error('Morpho authorization signature must be 65 bytes.');
  const rawV = hexToNumber(sliceHex(signature, 64, 65));
  const v = rawV <= 1 ? rawV + 27 : rawV;
  if (v !== 27 && v !== 28) throw new Error('Morpho authorization signature v must be 27 or 28.');
  return {
    v,
    r: sliceHex(signature, 0, 32),
    s: sliceHex(signature, 32, 64),
  };
}

export function morphoMarketId(paramsInput: MorphoMarketParams): Hex {
  const params = normalizeMarketParams([
    paramsInput.loanToken,
    paramsInput.collateralToken,
    paramsInput.oracle,
    paramsInput.irm,
    paramsInput.lltv,
  ]);
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
    ),
  );
}

export function ratePerSecondToApyBps(ratePerSecondWad: bigint): number {
  if (ratePerSecondWad < 0n) throw new Error('Morpho borrow rate cannot be negative.');
  return wadToBps(wTaylorCompounded(ratePerSecondWad, SECONDS_PER_YEAR));
}

export function wTaylorCompounded(ratePerSecondWad: bigint, elapsedSeconds: bigint): bigint {
  if (ratePerSecondWad < 0n || elapsedSeconds < 0n) {
    throw new Error('Morpho rate and elapsed time cannot be negative.');
  }
  const firstTerm = ratePerSecondWad * elapsedSeconds;
  const secondTerm = (firstTerm * firstTerm) / (2n * WAD);
  const thirdTerm = (secondTerm * firstTerm) / (3n * WAD);
  return firstTerm + secondTerm + thirdTerm;
}

function accrueMarket(
  market: MorphoMarketState,
  borrowRatePerSecondWad: bigint,
  blockTimestamp: bigint,
): MorphoMarketState {
  if (blockTimestamp <= market.lastUpdate) return market;
  const elapsed = blockTimestamp - market.lastUpdate;
  const interest =
    (market.totalBorrowAssets * wTaylorCompounded(borrowRatePerSecondWad, elapsed)) / WAD;
  return {
    ...market,
    totalSupplyAssets: market.totalSupplyAssets + interest,
    totalBorrowAssets: market.totalBorrowAssets + interest,
    lastUpdate: blockTimestamp,
  };
}

function projectBorrow(market: MorphoMarketState, requestedBorrowUnits: bigint): MorphoMarketState {
  if (requestedBorrowUnits === 0n) return market;
  return {
    ...market,
    totalBorrowAssets: market.totalBorrowAssets + requestedBorrowUnits,
    totalBorrowShares:
      market.totalBorrowShares +
      toSharesUp(requestedBorrowUnits, market.totalBorrowAssets, market.totalBorrowShares),
  };
}

function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return ceilDiv(shares * (totalAssets + VIRTUAL_ASSETS), totalShares + VIRTUAL_SHARES);
}

function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return ceilDiv(assets * (totalShares + VIRTUAL_SHARES), totalAssets + VIRTUAL_ASSETS);
}

function normalizeMarketParams(
  value: readonly [Address, Address, Address, Address, bigint],
): MorphoMarketParams {
  const [loanToken, collateralToken, oracle, irm, lltv] = value;
  if (lltv <= 0n || lltv >= WAD) throw new Error('Morpho LLTV must be between zero and one WAD.');
  return {
    loanToken: getAddress(loanToken),
    collateralToken: getAddress(collateralToken),
    oracle: getAddress(oracle),
    irm: getAddress(irm),
    lltv,
  };
}

function normalizeMarketState(
  value: readonly [bigint, bigint, bigint, bigint, bigint, bigint],
): MorphoMarketState {
  const [
    totalSupplyAssets,
    totalSupplyShares,
    totalBorrowAssets,
    totalBorrowShares,
    lastUpdate,
    fee,
  ] = value;
  if (totalBorrowAssets > totalSupplyAssets) {
    throw new Error('Morpho market borrow assets exceed supply assets.');
  }
  return {
    totalSupplyAssets,
    totalSupplyShares,
    totalBorrowAssets,
    totalBorrowShares,
    lastUpdate,
    fee,
  };
}

function wadToBps(value: bigint): number {
  const result = (value * 10_000n + WAD / 2n) / WAD;
  if (result > 10_000n && value <= WAD) throw new Error('Invalid WAD basis-point conversion.');
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WAD value exceeds safe bounds.');
  return Number(result);
}

function wadToBpsFloor(value: bigint): number {
  const result = (value * 10_000n) / WAD;
  if (result > 10_000n) throw new Error('Morpho LLTV exceeds one WAD.');
  return Number(result);
}

function zeroFloorSubtract(left: bigint, right: bigint): bigint {
  return left > right ? left - right : 0n;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('A positive denominator is required.');
  return (numerator + denominator - 1n) / denominator;
}

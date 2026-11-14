import {
  hashCanonicalText,
  positionSnapshotSchema,
  tokenReferenceSchema,
  type PositionSnapshot,
  type TokenReference,
} from '@debtshift/domain';
import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

const RAY = 10n ** 27n;
const BPS = 10_000n;

export const AAVE_POOL_READ_ABI = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const;

export const AAVE_POOL_WRITE_ABI = [
  {
    type: 'function',
    name: 'repay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [{ name: 'repaid', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: 'withdrawn', type: 'uint256' }],
  },
] as const;

export const AAVE_DATA_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getAllReservesTokens',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: 'reserves',
        type: 'tuple[]',
        components: [
          { name: 'symbol', type: 'string' },
          { name: 'tokenAddress', type: 'address' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getReserveTokensAddresses',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'aTokenAddress', type: 'address' },
      { name: 'stableDebtTokenAddress', type: 'address' },
      { name: 'variableDebtTokenAddress', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'getUserReserveData',
    stateMutability: 'view',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'currentATokenBalance', type: 'uint256' },
      { name: 'currentStableDebt', type: 'uint256' },
      { name: 'currentVariableDebt', type: 'uint256' },
      { name: 'principalStableDebt', type: 'uint256' },
      { name: 'scaledVariableDebt', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'stableRateLastUpdated', type: 'uint40' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: 'accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'averageStableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ],
  },
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'decimals', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
      { name: 'reserveFactor', type: 'uint256' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
      { name: 'borrowingEnabled', type: 'bool' },
      { name: 'stableBorrowRateEnabled', type: 'bool' },
      { name: 'isActive', type: 'bool' },
      { name: 'isFrozen', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getPaused',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'paused', type: 'bool' }],
  },
] as const;

export const ERC20_METADATA_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: 'allowance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'name', type: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'symbol', type: 'string' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'approved', type: 'bool' }],
  },
] as const;

export interface AaveV3PositionConfig {
  readonly chainId: number;
  readonly pool: Address;
  readonly dataProvider: Address;
  readonly collateralAsset: Omit<TokenReference, 'symbol'> & { readonly symbol?: string };
  readonly debtAsset: Omit<TokenReference, 'symbol'> & { readonly symbol?: string };
}

export interface AaveBorrowerCloseRequest {
  readonly borrower: Address;
  readonly debtUnits: bigint;
  readonly collateralUnits: bigint;
  readonly collateralReceiver: Address;
}

export interface AaveReserveTokenAddresses {
  readonly aToken: Address;
  readonly stableDebtToken: Address;
  readonly variableDebtToken: Address;
}

export interface AaveUserReserveBalance {
  readonly asset: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly collateralUnits: string;
  readonly stableDebtUnits: string;
  readonly variableDebtUnits: string;
  readonly usageAsCollateralEnabled: boolean;
}

export interface AaveUserReserveDiscovery {
  readonly chainId: number;
  readonly pool: Address;
  readonly dataProvider: Address;
  readonly borrower: Address;
  readonly block: {
    readonly number: string;
    readonly hash: Hex;
    readonly observedAt: string;
  };
  readonly reserves: readonly AaveUserReserveBalance[];
}

export interface PreparedEvmTransaction {
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly description: string;
}

export async function readAaveReserveTokenAddresses(
  client: PublicClient,
  dataProviderInput: Address,
  assetInput: Address,
  blockNumber?: bigint,
): Promise<AaveReserveTokenAddresses> {
  const dataProvider = getAddress(dataProviderInput);
  const asset = getAddress(assetInput);
  const [aToken, stableDebtToken, variableDebtToken] = await client.readContract({
    address: dataProvider,
    abi: AAVE_DATA_PROVIDER_ABI,
    functionName: 'getReserveTokensAddresses',
    args: [asset],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  const normalized = {
    aToken: getAddress(aToken),
    stableDebtToken: getAddress(stableDebtToken),
    variableDebtToken: getAddress(variableDebtToken),
  };
  if (
    normalized.aToken === zeroAddress ||
    normalized.variableDebtToken === zeroAddress ||
    isAddressEqual(normalized.aToken, normalized.variableDebtToken)
  ) {
    throw new Error(`Aave reserve ${asset} returned invalid token identities.`);
  }
  return normalized;
}

/**
 * Enumerates the user's active balances across the complete Aave reserve list
 * at one canonical block. Route support is decided by the caller after this
 * discovery step; unsupported active assets are not silently ignored.
 */
export async function discoverAaveUserReserves(
  client: PublicClient,
  config: { readonly chainId: number; readonly pool: Address; readonly dataProvider: Address },
  borrowerInput: Address,
  requestedBlockNumber?: bigint,
): Promise<AaveUserReserveDiscovery> {
  const borrower = getAddress(borrowerInput);
  const pool = getAddress(config.pool);
  const dataProvider = getAddress(config.dataProvider);
  const [actualChainId, block] = await Promise.all([
    client.getChainId(),
    requestedBlockNumber === undefined
      ? client.getBlock({ blockTag: 'latest' })
      : client.getBlock({ blockNumber: requestedBlockNumber }),
  ]);
  if (actualChainId !== config.chainId) {
    throw new Error(
      `Aave discovery RPC chain mismatch: expected ${config.chainId}, received ${actualChainId}.`,
    );
  }
  if (block.hash === null) throw new Error('Aave discovery block is not canonical.');
  if (requestedBlockNumber !== undefined && block.number !== requestedBlockNumber) {
    throw new Error('Aave discovery RPC returned a different block than requested.');
  }
  const reserveRows = await client.readContract({
    address: dataProvider,
    abi: AAVE_DATA_PROVIDER_ABI,
    functionName: 'getAllReservesTokens',
    blockNumber: block.number,
  });
  if (reserveRows.length === 0 || reserveRows.length > 128) {
    throw new Error('Aave discovery returned an invalid reserve count.');
  }
  const seen = new Set<string>();
  const reserves = await Promise.all(
    reserveRows.map(async (reserve) => {
      const asset = getAddress(reserve.tokenAddress);
      const key = asset.toLowerCase();
      if (seen.has(key)) throw new Error(`Aave discovery returned duplicate reserve ${asset}.`);
      seen.add(key);
      const [user, configuration] = await Promise.all([
        client.readContract({
          address: dataProvider,
          abi: AAVE_DATA_PROVIDER_ABI,
          functionName: 'getUserReserveData',
          args: [asset, borrower],
          blockNumber: block.number,
        }),
        client.readContract({
          address: dataProvider,
          abi: AAVE_DATA_PROVIDER_ABI,
          functionName: 'getReserveConfigurationData',
          args: [asset],
          blockNumber: block.number,
        }),
      ]);
      return {
        asset,
        symbol: reserve.symbol,
        decimals: Number(configuration[0]),
        collateralUnits: user[0].toString(),
        stableDebtUnits: user[1].toString(),
        variableDebtUnits: user[2].toString(),
        usageAsCollateralEnabled: user[8],
      } satisfies AaveUserReserveBalance;
    }),
  );
  return {
    chainId: config.chainId,
    pool,
    dataProvider,
    borrower,
    block: {
      number: block.number.toString(),
      hash: block.hash,
      observedAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
    },
    reserves: reserves
      .filter(
        (reserve) =>
          BigInt(reserve.collateralUnits) > 0n ||
          BigInt(reserve.stableDebtUnits) > 0n ||
          BigInt(reserve.variableDebtUnits) > 0n,
      )
      .sort((left, right) => left.asset.localeCompare(right.asset)),
  };
}

/**
 * Builds the borrower's exact aToken approval for the atomic DebtShift source
 * module. It is a collateral claim only: repayment and withdrawal still occur
 * together inside the signed SourceAdapter transaction.
 */
export function buildAaveCollateralClaimAuthorization(
  aTokenInput: Address,
  sourceLendingInput: Address,
  collateralUnits: bigint,
): PreparedEvmTransaction {
  if (collateralUnits <= 0n) throw new Error('Aave collateral authorization must be positive.');
  const aToken = getAddress(aTokenInput);
  const sourceLending = getAddress(sourceLendingInput);
  if (aToken === zeroAddress || sourceLending === zeroAddress) {
    throw new Error('Aave collateral authorization addresses must be non-zero.');
  }
  return {
    to: aToken,
    data: encodeFunctionData({
      abi: ERC20_METADATA_ABI,
      functionName: 'approve',
      args: [sourceLending, collateralUnits],
    }),
    value: 0n,
    description: 'Approve the exact signed aToken collateral claim for atomic source closure.',
  };
}

/**
 * Direct Aave reads are pinned to one block. Indexed Aave data may discover a
 * position, but this adapter is the execution-authority read.
 */
export class AaveV3ReadAdapter {
  readonly #pool: Address;
  readonly #dataProvider: Address;

  constructor(
    private readonly client: PublicClient,
    private readonly config: AaveV3PositionConfig,
  ) {
    this.#pool = getAddress(config.pool);
    this.#dataProvider = getAddress(config.dataProvider);
    if (
      config.collateralAsset.chainId !== config.chainId ||
      config.debtAsset.chainId !== config.chainId
    ) {
      throw new Error('Aave assets must use the configured chain ID.');
    }
    if (isAddressEqual(config.collateralAsset.address, config.debtAsset.address)) {
      throw new Error('Aave collateral and debt assets must be different.');
    }
  }

  async readPosition(
    borrowerInput: Address,
    requestedBlockNumber?: bigint,
  ): Promise<PositionSnapshot | undefined> {
    const borrower = getAddress(borrowerInput);
    const [actualChainId, block] = await Promise.all([
      this.client.getChainId(),
      requestedBlockNumber === undefined
        ? this.client.getBlock({ blockTag: 'latest' })
        : this.client.getBlock({ blockNumber: requestedBlockNumber }),
    ]);
    if (actualChainId !== this.config.chainId) {
      throw new Error(
        `Aave RPC chain mismatch: expected ${this.config.chainId}, received ${actualChainId}.`,
      );
    }
    if (block.hash === null) throw new Error('Aave position block is not canonical.');
    const blockNumber = block.number;
    if (requestedBlockNumber !== undefined && blockNumber !== requestedBlockNumber) {
      throw new Error('Aave RPC returned a different block than requested.');
    }
    const collateralAddress = getAddress(this.config.collateralAsset.address);
    const debtAddress = getAddress(this.config.debtAsset.address);
    const [collateralData, debtData, reserveData, accountData, collateralToken, debtToken] =
      await Promise.all([
        this.client.readContract({
          address: this.#dataProvider,
          abi: AAVE_DATA_PROVIDER_ABI,
          functionName: 'getUserReserveData',
          args: [collateralAddress, borrower],
          blockNumber,
        }),
        this.client.readContract({
          address: this.#dataProvider,
          abi: AAVE_DATA_PROVIDER_ABI,
          functionName: 'getUserReserveData',
          args: [debtAddress, borrower],
          blockNumber,
        }),
        this.client.readContract({
          address: this.#dataProvider,
          abi: AAVE_DATA_PROVIDER_ABI,
          functionName: 'getReserveData',
          args: [debtAddress],
          blockNumber,
        }),
        this.client.readContract({
          address: this.#pool,
          abi: AAVE_POOL_READ_ABI,
          functionName: 'getUserAccountData',
          args: [borrower],
          blockNumber,
        }),
        this.#readAndVerifyToken(this.config.collateralAsset, blockNumber),
        this.#readAndVerifyToken(this.config.debtAsset, blockNumber),
      ]);

    const collateralUnits = collateralData[0];
    const stableDebtUnits = debtData[1];
    const variableDebtUnits = debtData[2];
    if (collateralUnits === 0n || stableDebtUnits + variableDebtUnits === 0n) return undefined;
    if (stableDebtUnits !== 0n) {
      throw new Error('DebtShift does not aggregate legacy Aave stable-rate debt into one APR.');
    }
    if (!collateralData[8])
      throw new Error('The selected Aave asset is not enabled as collateral.');
    const observedAt = new Date(Number(block.timestamp) * 1_000).toISOString();
    const marketId = hashCanonicalText(
      `debtshift.aave-v3-market.v1:${this.config.chainId}:${this.#pool.toLowerCase()}`,
    );
    return positionSnapshotSchema.parse({
      snapshotId: hashCanonicalText(
        [
          'debtshift.aave-v3-position-snapshot.v1',
          this.config.chainId,
          this.#pool,
          borrower,
          collateralAddress,
          debtAddress,
          block.hash,
          collateralUnits,
          variableDebtUnits,
        ].join(':'),
      ),
      position: {
        market: {
          chainId: this.config.chainId,
          protocol: 'AAVE_V3',
          deployment: this.#pool,
          marketId,
        },
        borrower,
        collateralAsset: collateralToken,
        debtAsset: debtToken,
      },
      collateralUnits: collateralUnits.toString(),
      debtUnits: variableDebtUnits.toString(),
      health: {
        kind: 'AAVE_HEALTH_FACTOR',
        healthFactorWad: accountData[5].toString(),
      },
      borrowAprBps: rayToBps(reserveData[6]),
      block: {
        number: blockNumber.toString(),
        hash: block.hash,
        observedAt,
      },
    });
  }

  async #readAndVerifyToken(
    configured: AaveV3PositionConfig['collateralAsset'],
    blockNumber: bigint,
  ): Promise<TokenReference> {
    const address = getAddress(configured.address);
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
    if (decimals !== configured.decimals) {
      throw new Error(`Token decimal mismatch for ${address}.`);
    }
    if (configured.symbol !== undefined && configured.symbol !== symbol) {
      throw new Error(`Token symbol mismatch for ${address}.`);
    }
    return tokenReferenceSchema.parse({
      chainId: this.config.chainId,
      address,
      decimals,
      symbol,
      ...(configured.providerAssetId === undefined
        ? {}
        : { providerAssetId: configured.providerAssetId }),
    });
  }
}

/**
 * Builds an explicit borrower-direct fallback. The caller must be the borrower
 * and already possess the repayment asset; this is not an aToken-allowance
 * claim and is not enabled as DebtShift's funded source-close path yet.
 */
export function buildAaveBorrowerCloseTransactions(
  config: Pick<AaveV3PositionConfig, 'pool' | 'collateralAsset' | 'debtAsset'>,
  request: AaveBorrowerCloseRequest,
): readonly PreparedEvmTransaction[] {
  if (request.debtUnits <= 0n || request.collateralUnits <= 0n) {
    throw new Error('Aave close amounts must be positive.');
  }
  const pool = getAddress(config.pool);
  const debtAsset = getAddress(config.debtAsset.address);
  const collateralAsset = getAddress(config.collateralAsset.address);
  const borrower = getAddress(request.borrower);
  const receiver = getAddress(request.collateralReceiver);
  return [
    {
      to: debtAsset,
      data: encodeFunctionData({
        abi: ERC20_METADATA_ABI,
        functionName: 'approve',
        args: [pool, request.debtUnits],
      }),
      value: 0n,
      description: 'Approve the exact Aave variable-debt repayment amount.',
    },
    {
      to: pool,
      data: encodeFunctionData({
        abi: AAVE_POOL_WRITE_ABI,
        functionName: 'repay',
        args: [debtAsset, request.debtUnits, 2n, borrower],
      }),
      value: 0n,
      description: 'Repay variable-rate debt on behalf of the borrower.',
    },
    {
      to: pool,
      data: encodeFunctionData({
        abi: AAVE_POOL_WRITE_ABI,
        functionName: 'withdraw',
        args: [collateralAsset, request.collateralUnits, receiver],
      }),
      value: 0n,
      description: 'Withdraw the bounded collateral amount to the signed receiver.',
    },
  ];
}

export function rayToBps(ray: bigint): number {
  if (ray < 0n) throw new Error('Aave rate cannot be negative.');
  const bps = (ray * BPS + RAY / 2n) / RAY;
  if (bps > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Aave rate exceeds safe bounds.');
  return Number(bps);
}

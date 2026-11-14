import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestnetMorphoDeploymentManifest } from '@debtshift/domain';
import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';

import { loadMorphoTestnetArtifact, type FoundryArtifact } from './artifacts.js';
import { morphoMarketId, type MorphoMarketParams } from './morpho-blue.js';

type DeploymentWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;
type ContractRecord = TestnetMorphoDeploymentManifest['contracts']['morpho'];
type TransactionRecord = TestnetMorphoDeploymentManifest['configurationTransactions'][number];

const ERC20_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
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
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'approved', type: 'bool' }],
  },
] as const;

const FEED_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

interface TestnetMorphoArtifacts {
  readonly morpho: FoundryArtifact;
  readonly irm: FoundryArtifact;
  readonly oracle: FoundryArtifact;
}

interface ExpectedConfigurationTransaction {
  readonly action: string;
  readonly sender: Address;
  readonly target: Address;
  readonly input: Hex;
}

export interface TestnetMorphoDeploymentInput {
  readonly sourceCommit: string;
  readonly routeId: string;
  readonly routeDependenciesHash: Hex;
  readonly publicClient: PublicClient;
  readonly wallet: DeploymentWallet;
  readonly chainId: number;
  readonly confirmations: number;
  readonly owner: Address;
  readonly collateralToken: Address;
  readonly loanToken: Address;
  readonly collateralFeed: Address;
  readonly loanFeed: Address;
  readonly sequencerUptimeFeed?: Address;
  readonly collateralMaxPriceAgeSeconds: bigint;
  readonly loanMaxPriceAgeSeconds: bigint;
  readonly sequencerGracePeriodSeconds: bigint;
  readonly lltv: bigint;
  readonly seedLiquidityOwner: Address;
  readonly seedLiquidityAssets: bigint;
  readonly createdAt?: string;
}

export interface TestnetMorphoVerificationInput {
  readonly manifest: TestnetMorphoDeploymentManifest;
  readonly publicClient: PublicClient;
  readonly minimumAvailableLiquidityUnits?: bigint;
  readonly expectedRouteId?: string;
  readonly expectedRouteDependenciesHash?: Hex;
}

export interface TestnetMorphoVerificationReport {
  readonly verifiedAt: string;
  readonly chainId: number;
  readonly blockNumber: string;
  readonly marketId: Hex;
  readonly oraclePrice: string;
  readonly totalSupplyAssets: string;
  readonly totalBorrowAssets: string;
  readonly availableLiquidityUnits: string;
  readonly seedLiquidityShares: string;
  readonly owner: Address;
  readonly workflowWriteSwitchEnabled: false;
}

export async function deployTestnetMorphoMarket(
  input: TestnetMorphoDeploymentInput,
): Promise<TestnetMorphoDeploymentManifest> {
  await assertDeploymentInput(input);
  const artifacts = await loadArtifacts();
  const upstream = await readUpstreamProvenance();
  const deployer = getAddress(input.wallet.account.address);
  const sequencerUptimeFeed = getAddress(input.sequencerUptimeFeed ?? zeroAddress);

  const morpho = await deployTracked(
    input.wallet,
    input.publicClient,
    input.confirmations,
    'Morpho',
    artifacts.morpho,
    [deployer],
  );
  const irm = await deployTracked(
    input.wallet,
    input.publicClient,
    input.confirmations,
    'AdaptiveCurveIrm',
    artifacts.irm,
    [morpho.address],
  );
  const oracle = await deployTracked(
    input.wallet,
    input.publicClient,
    input.confirmations,
    'DebtShiftChainlinkOracle',
    artifacts.oracle,
    [
      input.collateralToken,
      input.loanToken,
      input.collateralFeed,
      input.loanFeed,
      sequencerUptimeFeed,
      input.collateralMaxPriceAgeSeconds,
      input.loanMaxPriceAgeSeconds,
      input.sequencerGracePeriodSeconds,
    ],
  );
  const marketParams: MorphoMarketParams = {
    loanToken: getAddress(input.loanToken),
    collateralToken: getAddress(input.collateralToken),
    oracle: oracle.address,
    irm: irm.address,
    lltv: input.lltv,
  };
  const marketId = morphoMarketId(marketParams);
  const configurationTransactions: TransactionRecord[] = [];
  configurationTransactions.push(
    (
      await writeTracked(
        input.wallet,
        input.publicClient,
        input.confirmations,
        'enable canonical AdaptiveCurveIrm',
        artifacts.morpho.abi,
        morpho.address,
        'enableIrm',
        [irm.address],
      )
    ).record,
    (
      await writeTracked(
        input.wallet,
        input.publicClient,
        input.confirmations,
        'enable configured LLTV',
        artifacts.morpho.abi,
        morpho.address,
        'enableLltv',
        [input.lltv],
      )
    ).record,
    (
      await writeTracked(
        input.wallet,
        input.publicClient,
        input.confirmations,
        'create funded testnet market',
        artifacts.morpho.abi,
        morpho.address,
        'createMarket',
        [marketParams],
      )
    ).record,
  );

  const existingAllowance = await readBigInt(
    input.publicClient,
    ERC20_ABI,
    input.loanToken,
    'allowance',
    [deployer, morpho.address],
  );
  if (existingAllowance !== 0n) {
    configurationTransactions.push(
      (
        await writeTracked(
          input.wallet,
          input.publicClient,
          input.confirmations,
          'clear pre-existing Morpho seed allowance',
          ERC20_ABI,
          input.loanToken,
          'approve',
          [morpho.address, 0n],
        )
      ).record,
    );
  }
  configurationTransactions.push(
    (
      await writeTracked(
        input.wallet,
        input.publicClient,
        input.confirmations,
        'approve exact Morpho seed liquidity',
        ERC20_ABI,
        input.loanToken,
        'approve',
        [morpho.address, input.seedLiquidityAssets],
      )
    ).record,
  );
  const supply = await writeTracked(
    input.wallet,
    input.publicClient,
    input.confirmations,
    'supply real testnet loan-token liquidity',
    artifacts.morpho.abi,
    morpho.address,
    'supply',
    [marketParams, input.seedLiquidityAssets, 0n, input.seedLiquidityOwner, '0x'],
  );
  configurationTransactions.push(supply.record);
  configurationTransactions.push(
    (
      await writeTracked(
        input.wallet,
        input.publicClient,
        input.confirmations,
        'revoke Morpho seed allowance',
        ERC20_ABI,
        input.loanToken,
        'approve',
        [morpho.address, 0n],
      )
    ).record,
  );
  if (!isAddressEqual(input.owner, deployer)) {
    configurationTransactions.push(
      (
        await writeTracked(
          input.wallet,
          input.publicClient,
          input.confirmations,
          'transfer Morpho owner',
          artifacts.morpho.abi,
          morpho.address,
          'setOwner',
          [input.owner],
        )
      ).record,
    );
  }

  const seedResult = parseSupplyResult(supply.result);
  const [
    marketState,
    morphoLoanBalance,
    seedPosition,
    tokenRecords,
    feedRecords,
    oraclePriceAtDeployment,
  ] = await Promise.all([
    readMarket(input.publicClient, artifacts.morpho.abi, morpho.address, marketId),
    readBigInt(input.publicClient, ERC20_ABI, input.loanToken, 'balanceOf', [morpho.address]),
    readPosition(
      input.publicClient,
      artifacts.morpho.abi,
      morpho.address,
      marketId,
      input.seedLiquidityOwner,
    ),
    readTokenRecords(input),
    readFeedRecords(input),
    readBigInt(input.publicClient, artifacts.oracle.abi, oracle.address, 'price', []),
  ]);
  if (
    seedResult.assets !== input.seedLiquidityAssets ||
    seedResult.shares === 0n ||
    seedPosition.supplyShares < seedResult.shares ||
    marketState.totalSupplyAssets < input.seedLiquidityAssets ||
    oraclePriceAtDeployment === 0n
  ) {
    throw new Error('Morpho seed-liquidity receipt did not create the expected funded position.');
  }
  const availableLiquidity = minimum(
    marketState.totalSupplyAssets - marketState.totalBorrowAssets,
    morphoLoanBalance,
  );
  if (availableLiquidity < input.seedLiquidityAssets) {
    throw new Error('Morpho market did not retain the exact seeded testnet loan liquidity.');
  }

  return {
    schemaVersion: 1,
    environment: 'testnet',
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    routeId: input.routeId,
    routeDependenciesHash: input.routeDependenciesHash,
    workflowWriteSwitchEnabled: false,
    upstream,
    chainId: input.chainId,
    deploymentBlockNumber: minimumDeploymentBlock([morpho, irm, oracle]),
    deployer,
    owner: getAddress(input.owner),
    contracts: { morpho, irm, oracle },
    tokens: tokenRecords,
    feeds: {
      ...feedRecords,
      collateralMaxPriceAgeSeconds: input.collateralMaxPriceAgeSeconds.toString(),
      loanMaxPriceAgeSeconds: input.loanMaxPriceAgeSeconds.toString(),
      sequencerGracePeriodSeconds: input.sequencerGracePeriodSeconds.toString(),
    },
    market: {
      id: marketId,
      loanToken: marketParams.loanToken,
      collateralToken: marketParams.collateralToken,
      oracle: marketParams.oracle,
      irm: marketParams.irm,
      lltv: marketParams.lltv.toString(),
      seedLiquidityOwner: getAddress(input.seedLiquidityOwner),
      seedLiquidityAssets: seedResult.assets.toString(),
      seedLiquidityShares: seedResult.shares.toString(),
      oraclePriceAtDeployment: oraclePriceAtDeployment.toString(),
      totalSupplyAssetsAtDeployment: marketState.totalSupplyAssets.toString(),
      availableLiquidityAtDeployment: availableLiquidity.toString(),
    },
    configurationTransactions,
  };
}

export async function verifyTestnetMorphoDeployment({
  manifest,
  publicClient,
  minimumAvailableLiquidityUnits = 1n,
  expectedRouteId,
  expectedRouteDependenciesHash,
}: TestnetMorphoVerificationInput): Promise<TestnetMorphoVerificationReport> {
  if (minimumAvailableLiquidityUnits < 1n) {
    throw new Error('Testnet Morpho readiness requires a positive liquidity floor.');
  }
  if (
    (expectedRouteId !== undefined && manifest.routeId !== expectedRouteId) ||
    (expectedRouteDependenciesHash !== undefined &&
      manifest.routeDependenciesHash.toLowerCase() !== expectedRouteDependenciesHash.toLowerCase())
  ) {
    throw new Error('Testnet Morpho route dependency binding does not match.');
  }
  const [chainId, blockNumber, artifacts, upstream] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    loadArtifacts(),
    readUpstreamProvenance(),
  ]);
  if (chainId !== manifest.chainId) throw new Error('Testnet Morpho manifest chain mismatch.');
  if (
    upstream.commit !== manifest.upstream.commit ||
    upstream.sourceManifestHash !== manifest.upstream.sourceManifestHash
  ) {
    throw new Error('Vendored Morpho provenance does not match the deployment manifest.');
  }
  assertDeploymentTimeline(manifest);
  const sequencerUptimeFeed = manifest.feeds.sequencerUptime?.address ?? zeroAddress;
  const marketParams: MorphoMarketParams = {
    loanToken: manifest.market.loanToken,
    collateralToken: manifest.market.collateralToken,
    oracle: manifest.market.oracle,
    irm: manifest.market.irm,
    lltv: BigInt(manifest.market.lltv),
  };
  const expectedConfiguration = expectedConfigurationTransactions(
    manifest,
    artifacts,
    marketParams,
  );
  await Promise.all([
    verifyContractRecord(
      publicClient,
      manifest.contracts.morpho,
      artifacts.morpho,
      [manifest.deployer],
      manifest.deployer,
    ),
    verifyContractRecord(
      publicClient,
      manifest.contracts.irm,
      artifacts.irm,
      [manifest.contracts.morpho.address],
      manifest.deployer,
    ),
    verifyContractRecord(
      publicClient,
      manifest.contracts.oracle,
      artifacts.oracle,
      [
        manifest.tokens.collateral.address,
        manifest.tokens.loan.address,
        manifest.feeds.collateral.address,
        manifest.feeds.loan.address,
        sequencerUptimeFeed,
        BigInt(manifest.feeds.collateralMaxPriceAgeSeconds),
        BigInt(manifest.feeds.loanMaxPriceAgeSeconds),
        BigInt(manifest.feeds.sequencerGracePeriodSeconds),
      ],
      manifest.deployer,
    ),
    ...manifest.configurationTransactions.map((record, index) =>
      verifyTransactionRecord(publicClient, record, expectedConfiguration[index]!),
    ),
    verifyCodeRecord(publicClient, manifest.tokens.collateral),
    verifyCodeRecord(publicClient, manifest.tokens.loan),
    verifyCodeRecord(publicClient, manifest.feeds.collateral),
    verifyCodeRecord(publicClient, manifest.feeds.loan),
    ...(manifest.feeds.sequencerUptime === null
      ? []
      : [verifyCodeRecord(publicClient, manifest.feeds.sequencerUptime)]),
  ]);

  if (morphoMarketId(marketParams).toLowerCase() !== manifest.market.id.toLowerCase()) {
    throw new Error('Testnet Morpho market ID does not derive from the manifested parameters.');
  }
  const [owner, irmEnabled, lltvEnabled, rawParams, marketState, seedPosition, loanBalance] =
    await Promise.all([
      readAddress(
        publicClient,
        artifacts.morpho.abi,
        manifest.contracts.morpho.address,
        'owner',
        [],
      ),
      readBoolean(
        publicClient,
        artifacts.morpho.abi,
        manifest.contracts.morpho.address,
        'isIrmEnabled',
        [manifest.contracts.irm.address],
      ),
      readBoolean(
        publicClient,
        artifacts.morpho.abi,
        manifest.contracts.morpho.address,
        'isLltvEnabled',
        [BigInt(manifest.market.lltv)],
      ),
      publicClient.readContract({
        address: manifest.contracts.morpho.address,
        abi: artifacts.morpho.abi,
        functionName: 'idToMarketParams',
        args: [manifest.market.id],
      }),
      readMarket(
        publicClient,
        artifacts.morpho.abi,
        manifest.contracts.morpho.address,
        manifest.market.id,
      ),
      readPosition(
        publicClient,
        artifacts.morpho.abi,
        manifest.contracts.morpho.address,
        manifest.market.id,
        manifest.market.seedLiquidityOwner,
      ),
      readBigInt(publicClient, ERC20_ABI, manifest.tokens.loan.address, 'balanceOf', [
        manifest.contracts.morpho.address,
      ]),
    ]);
  const actualParams = parseMarketParams(rawParams);
  assertMarketParams(actualParams, marketParams);
  if (!isAddressEqual(owner, manifest.owner) || !irmEnabled || !lltvEnabled) {
    throw new Error('Testnet Morpho owner, IRM, or LLTV configuration drifted.');
  }
  const [irmMorpho, oracleCollateralFeed, oracleLoanFeed, oracleSequencerFeed] = await Promise.all([
    readAddress(publicClient, artifacts.irm.abi, manifest.contracts.irm.address, 'MORPHO', []),
    readAddress(
      publicClient,
      artifacts.oracle.abi,
      manifest.contracts.oracle.address,
      'COLLATERAL_FEED',
      [],
    ),
    readAddress(
      publicClient,
      artifacts.oracle.abi,
      manifest.contracts.oracle.address,
      'LOAN_FEED',
      [],
    ),
    readAddress(
      publicClient,
      artifacts.oracle.abi,
      manifest.contracts.oracle.address,
      'SEQUENCER_UPTIME_FEED',
      [],
    ),
  ]);
  if (
    !isAddressEqual(irmMorpho, manifest.contracts.morpho.address) ||
    !isAddressEqual(oracleCollateralFeed, manifest.feeds.collateral.address) ||
    !isAddressEqual(oracleLoanFeed, manifest.feeds.loan.address) ||
    !isAddressEqual(oracleSequencerFeed, sequencerUptimeFeed)
  ) {
    throw new Error('Testnet Morpho IRM or oracle immutable binding drifted.');
  }
  const [
    collateralMaxPriceAge,
    loanMaxPriceAge,
    gracePeriod,
    oraclePrice,
    allowance,
    collateralDecimals,
    loanDecimals,
  ] = await Promise.all([
    readBigInt(
      publicClient,
      artifacts.oracle.abi,
      manifest.contracts.oracle.address,
      'COLLATERAL_MAX_PRICE_AGE',
      [],
    ),
    readBigInt(
      publicClient,
      artifacts.oracle.abi,
      manifest.contracts.oracle.address,
      'LOAN_MAX_PRICE_AGE',
      [],
    ),
    readBigInt(
      publicClient,
      artifacts.oracle.abi,
      manifest.contracts.oracle.address,
      'SEQUENCER_GRACE_PERIOD',
      [],
    ),
    readBigInt(publicClient, artifacts.oracle.abi, manifest.contracts.oracle.address, 'price', []),
    readBigInt(publicClient, ERC20_ABI, manifest.tokens.loan.address, 'allowance', [
      manifest.deployer,
      manifest.contracts.morpho.address,
    ]),
    readBigInt(publicClient, ERC20_ABI, manifest.tokens.collateral.address, 'decimals', []),
    readBigInt(publicClient, ERC20_ABI, manifest.tokens.loan.address, 'decimals', []),
  ]);
  if (
    collateralMaxPriceAge.toString() !== manifest.feeds.collateralMaxPriceAgeSeconds ||
    loanMaxPriceAge.toString() !== manifest.feeds.loanMaxPriceAgeSeconds ||
    gracePeriod.toString() !== manifest.feeds.sequencerGracePeriodSeconds ||
    oraclePrice === 0n ||
    allowance !== 0n ||
    collateralDecimals !== BigInt(manifest.tokens.collateral.decimals) ||
    loanDecimals !== BigInt(manifest.tokens.loan.decimals)
  ) {
    throw new Error('Testnet Morpho oracle, token decimals, or revoked allowance drifted.');
  }
  if (
    marketState.lastUpdate === 0n ||
    marketState.totalSupplyAssets < BigInt(manifest.market.seedLiquidityAssets) ||
    seedPosition.supplyShares < BigInt(manifest.market.seedLiquidityShares)
  ) {
    throw new Error('Testnet Morpho initialized market or seed-liquidity position drifted.');
  }
  const availableLiquidity = minimum(
    marketState.totalSupplyAssets - marketState.totalBorrowAssets,
    loanBalance,
  );
  if (availableLiquidity < minimumAvailableLiquidityUnits) {
    throw new Error(
      `Testnet Morpho has ${availableLiquidity} available units; ${minimumAvailableLiquidityUnits} required.`,
    );
  }
  return {
    verifiedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    marketId: manifest.market.id,
    oraclePrice: oraclePrice.toString(),
    totalSupplyAssets: marketState.totalSupplyAssets.toString(),
    totalBorrowAssets: marketState.totalBorrowAssets.toString(),
    availableLiquidityUnits: availableLiquidity.toString(),
    seedLiquidityShares: seedPosition.supplyShares.toString(),
    owner,
    workflowWriteSwitchEnabled: false,
  };
}

async function assertDeploymentInput(input: TestnetMorphoDeploymentInput): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) {
    throw new Error('Testnet Morpho deployment requires a full lowercase Git source commit.');
  }
  if (
    input.routeId.trim().length === 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.routeDependenciesHash)
  ) {
    throw new Error('Testnet Morpho deployment requires an exact route dependency binding.');
  }
  if (
    !Number.isInteger(input.chainId) ||
    input.chainId < 1 ||
    !Number.isInteger(input.confirmations) ||
    input.confirmations < 1
  ) {
    throw new Error('Testnet Morpho chain ID and confirmations must be positive integers.');
  }
  if (input.wallet.account === undefined) throw new Error('Testnet Morpho wallet has no account.');
  if (isAddressEqual(input.collateralToken, input.loanToken)) {
    throw new Error('Testnet Morpho collateral and loan tokens must differ.');
  }
  if (
    input.collateralMaxPriceAgeSeconds < 1n ||
    input.loanMaxPriceAgeSeconds < 1n ||
    input.lltv <= 0n ||
    input.lltv >= 10n ** 18n ||
    input.seedLiquidityAssets < 1n
  ) {
    throw new Error(
      'Testnet Morpho price age, LLTV, and seed liquidity must be positive and safe.',
    );
  }
  const sequencer = input.sequencerUptimeFeed ?? zeroAddress;
  if (
    (isAddressEqual(sequencer, zeroAddress) && input.sequencerGracePeriodSeconds !== 0n) ||
    (!isAddressEqual(sequencer, zeroAddress) && input.sequencerGracePeriodSeconds < 1n)
  ) {
    throw new Error('Testnet Morpho sequencer feed and grace period must be configured together.');
  }
  const actualChainId = await input.publicClient.getChainId();
  if (actualChainId !== input.chainId) {
    throw new Error(
      `Testnet Morpho RPC chain mismatch: expected ${input.chainId}, received ${actualChainId}.`,
    );
  }
  await Promise.all(
    [input.collateralToken, input.loanToken, input.collateralFeed, input.loanFeed, sequencer]
      .filter((address) => !isAddressEqual(address, zeroAddress))
      .map(async (address) => {
        const code = await input.publicClient.getCode({ address });
        if (code === undefined || code === '0x') {
          throw new Error(`Testnet Morpho dependency has no deployed code: ${address}.`);
        }
      }),
  );
  const balance = await readBigInt(input.publicClient, ERC20_ABI, input.loanToken, 'balanceOf', [
    input.wallet.account.address,
  ]);
  if (balance < input.seedLiquidityAssets) {
    throw new Error(
      `Testnet Morpho deployer has ${balance} loan-token units; ${input.seedLiquidityAssets} required.`,
    );
  }
  await assertOracleInputsReady(input);
}

async function assertOracleInputsReady(input: TestnetMorphoDeploymentInput): Promise<void> {
  const [
    block,
    collateralTokenDecimals,
    loanTokenDecimals,
    collateralFeedDecimals,
    loanFeedDecimals,
  ] = await Promise.all([
    input.publicClient.getBlock({ blockTag: 'latest' }),
    readBigInt(input.publicClient, ERC20_ABI, input.collateralToken, 'decimals', []),
    readBigInt(input.publicClient, ERC20_ABI, input.loanToken, 'decimals', []),
    readBigInt(input.publicClient, FEED_ABI, input.collateralFeed, 'decimals', []),
    readBigInt(input.publicClient, FEED_ABI, input.loanFeed, 'decimals', []),
  ]);
  const [collateralRound, loanRound] = await Promise.all([
    readFeedRound(input.publicClient, input.collateralFeed),
    readFeedRound(input.publicClient, input.loanFeed),
  ]);
  const collateralPrice = assertCompletePriceRound(
    'collateral',
    collateralRound,
    block.timestamp,
    input.collateralMaxPriceAgeSeconds,
  );
  const loanPrice = assertCompletePriceRound(
    'loan',
    loanRound,
    block.timestamp,
    input.loanMaxPriceAgeSeconds,
  );
  const exponent =
    36n + loanTokenDecimals + loanFeedDecimals - collateralTokenDecimals - collateralFeedDecimals;
  if (exponent < 0n || exponent > 36n) {
    throw new Error('Testnet Morpho oracle scale is outside the supported route range.');
  }
  if ((collateralPrice * 10n ** exponent) / loanPrice === 0n) {
    throw new Error('Testnet Morpho oracle inputs derive a zero price.');
  }
  if (
    input.sequencerUptimeFeed !== undefined &&
    !isAddressEqual(input.sequencerUptimeFeed, zeroAddress)
  ) {
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await readFeedRound(
      input.publicClient,
      input.sequencerUptimeFeed,
    );
    if (
      answer !== 0n ||
      startedAt === 0n ||
      updatedAt === 0n ||
      startedAt > updatedAt ||
      updatedAt > block.timestamp ||
      answeredInRound < roundId
    ) {
      throw new Error('Testnet Morpho sequencer feed reports an unavailable or incomplete round.');
    }
    if (block.timestamp - startedAt <= input.sequencerGracePeriodSeconds) {
      throw new Error('Testnet Morpho sequencer feed is still inside the recovery grace period.');
    }
  }
}

async function readFeedRound(
  client: PublicClient,
  address: Address,
): Promise<readonly [bigint, bigint, bigint, bigint, bigint]> {
  const result = await client.readContract({
    address,
    abi: FEED_ABI,
    functionName: 'latestRoundData',
  });
  if (
    !Array.isArray(result) ||
    result.length !== 5 ||
    result.some((value) => typeof value !== 'bigint')
  ) {
    throw new Error(`Unexpected Chainlink round response from ${address}.`);
  }
  return result as readonly [bigint, bigint, bigint, bigint, bigint];
}

function assertCompletePriceRound(
  label: string,
  round: readonly [bigint, bigint, bigint, bigint, bigint],
  blockTimestamp: bigint,
  maximumAge: bigint,
): bigint {
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = round;
  if (
    answer <= 0n ||
    startedAt === 0n ||
    updatedAt === 0n ||
    startedAt > updatedAt ||
    updatedAt > blockTimestamp ||
    answeredInRound < roundId
  ) {
    throw new Error(`Testnet Morpho ${label} feed has an invalid or incomplete round.`);
  }
  if (blockTimestamp - updatedAt > maximumAge) {
    throw new Error(`Testnet Morpho ${label} feed is stale before deployment.`);
  }
  return answer;
}

async function loadArtifacts(): Promise<TestnetMorphoArtifacts> {
  const [morpho, irm, oracle] = await Promise.all([
    loadMorphoTestnetArtifact('Morpho'),
    loadMorphoTestnetArtifact('AdaptiveCurveIrm'),
    loadMorphoTestnetArtifact('DebtShiftChainlinkOracle'),
  ]);
  return { morpho, irm, oracle };
}

async function readUpstreamProvenance(): Promise<TestnetMorphoDeploymentManifest['upstream']> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const path = resolve(repositoryRoot, 'contracts/morpho-testnet/vendor/morpho-blue/UPSTREAM.json');
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as { repository?: unknown; commit?: unknown };
  if (
    parsed.repository !== 'https://github.com/morpho-org/morpho-blue' ||
    typeof parsed.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(parsed.commit)
  ) {
    throw new Error('Vendored Morpho upstream manifest is invalid.');
  }
  return {
    repository: parsed.repository,
    commit: parsed.commit,
    sourceManifestHash: keccak256(stringToHex(raw)),
    compilerVersion: '0.8.19',
    evmVersion: 'paris',
    viaIr: true,
    optimizerRuns: 999_999,
  };
}

async function deployTracked(
  wallet: DeploymentWallet,
  client: PublicClient,
  confirmations: number,
  artifactName: string,
  artifact: FoundryArtifact,
  args: readonly unknown[],
): Promise<ContractRecord> {
  const deploymentInput = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const deploymentTransactionHash = await wallet.deployContract({
    account: wallet.account,
    chain: wallet.chain,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: deploymentTransactionHash,
    confirmations,
  });
  if (
    receipt.status !== 'success' ||
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error(`${artifactName} deployment reverted: ${deploymentTransactionHash}`);
  }
  const code = await readDeployedCode(client, receipt.contractAddress, receipt.blockNumber);
  if (code === undefined || code === '0x') {
    throw new Error(
      `${artifactName} deployment ${deploymentTransactionHash} at ${receipt.contractAddress} ` +
        `has no runtime bytecode at receipt block ${receipt.blockNumber}.`,
    );
  }
  return {
    artifact: artifactName,
    address: receipt.contractAddress,
    artifactCreationCodeHash: keccak256(artifact.bytecode),
    deploymentTransactionHash,
    deploymentTransactionInputHash: keccak256(deploymentInput),
    deploymentBlockNumber: receipt.blockNumber.toString(),
    deploymentBlockHash: receipt.blockHash,
    runtimeCodeHash: keccak256(code),
  };
}

async function readDeployedCode(
  client: PublicClient,
  address: Address,
  blockNumber: bigint,
): Promise<Hex | undefined> {
  const maximumAttempts = 15;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const code = await client.getCode({ address, blockNumber });
      if (code !== undefined && code !== '0x') return code;
    } catch {
      // Public RPC load balancers can route the receipt and state reads to backends at different
      // heads. Retry the exact receipt block rather than accepting an empty latest-state read.
    }
    if (attempt < maximumAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return undefined;
}

async function writeTracked(
  wallet: DeploymentWallet,
  client: PublicClient,
  confirmations: number,
  action: string,
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<{ readonly record: TransactionRecord; readonly result: unknown }> {
  const transactionInput = encodeFunctionData({ abi, functionName, args });
  const simulation = await client.simulateContract({
    account: wallet.account,
    address,
    abi,
    functionName,
    args,
  });
  const transactionHash = await wallet.writeContract(simulation.request);
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations });
  if (receipt.status !== 'success') throw new Error(`${action} reverted: ${transactionHash}`);
  return {
    result: simulation.result,
    record: {
      action,
      transactionHash,
      transactionInputHash: keccak256(transactionInput),
      sender: getAddress(wallet.account.address),
      target: getAddress(address),
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
    },
  };
}

async function verifyContractRecord(
  client: PublicClient,
  record: ContractRecord,
  artifact: FoundryArtifact,
  args: readonly unknown[],
  expectedDeployer: Address,
): Promise<void> {
  const expectedInput = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const [receipt, transaction, code] = await Promise.all([
    client.getTransactionReceipt({ hash: record.deploymentTransactionHash }),
    client.getTransaction({ hash: record.deploymentTransactionHash }),
    client.getCode({ address: record.address }),
  ]);
  if (
    record.artifactCreationCodeHash !== keccak256(artifact.bytecode) ||
    record.deploymentTransactionInputHash !== keccak256(expectedInput) ||
    transaction.input.toLowerCase() !== expectedInput.toLowerCase() ||
    !isAddressEqual(transaction.from, expectedDeployer) ||
    transaction.to !== null ||
    receipt.status !== 'success' ||
    receipt.blockNumber.toString() !== record.deploymentBlockNumber ||
    receipt.blockHash.toLowerCase() !== record.deploymentBlockHash.toLowerCase() ||
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined ||
    !isAddressEqual(receipt.contractAddress, record.address) ||
    code === undefined ||
    code === '0x' ||
    keccak256(code) !== record.runtimeCodeHash
  ) {
    throw new Error(`Testnet Morpho deployment provenance mismatch for ${record.artifact}.`);
  }
  await assertCanonicalBlock(client, receipt.blockNumber, receipt.blockHash, record.artifact);
}

async function verifyTransactionRecord(
  client: PublicClient,
  record: TransactionRecord,
  expected: ExpectedConfigurationTransaction,
): Promise<void> {
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: record.transactionHash }),
    client.getTransaction({ hash: record.transactionHash }),
  ]);
  if (
    record.action !== expected.action ||
    !isAddressEqual(record.sender, expected.sender) ||
    !isAddressEqual(record.target, expected.target) ||
    record.transactionInputHash !== keccak256(expected.input) ||
    receipt.status !== 'success' ||
    receipt.blockNumber.toString() !== record.blockNumber ||
    receipt.blockHash.toLowerCase() !== record.blockHash.toLowerCase() ||
    !isAddressEqual(transaction.from, record.sender) ||
    transaction.to === null ||
    !isAddressEqual(transaction.to, record.target) ||
    transaction.input.toLowerCase() !== expected.input.toLowerCase() ||
    keccak256(transaction.input) !== record.transactionInputHash
  ) {
    throw new Error(`Testnet Morpho transaction provenance mismatch for ${record.action}.`);
  }
  await assertCanonicalBlock(client, receipt.blockNumber, receipt.blockHash, record.action);
}

function expectedConfigurationTransactions(
  manifest: TestnetMorphoDeploymentManifest,
  artifacts: TestnetMorphoArtifacts,
  marketParams: MorphoMarketParams,
): readonly ExpectedConfigurationTransaction[] {
  const morpho = manifest.contracts.morpho.address;
  const loanToken = manifest.tokens.loan.address;
  const sender = manifest.deployer;
  const expected: ExpectedConfigurationTransaction[] = [
    expectedWrite(
      'enable canonical AdaptiveCurveIrm',
      sender,
      morpho,
      artifacts.morpho.abi,
      'enableIrm',
      [manifest.contracts.irm.address],
    ),
    expectedWrite('enable configured LLTV', sender, morpho, artifacts.morpho.abi, 'enableLltv', [
      BigInt(manifest.market.lltv),
    ]),
    expectedWrite(
      'create funded testnet market',
      sender,
      morpho,
      artifacts.morpho.abi,
      'createMarket',
      [marketParams],
    ),
  ];
  const ownerTransferCount = isAddressEqual(manifest.owner, sender) ? 0 : 1;
  const requiredCountWithoutAllowanceClear = 6 + ownerTransferCount;
  if (
    manifest.configurationTransactions.length !== requiredCountWithoutAllowanceClear &&
    manifest.configurationTransactions.length !== requiredCountWithoutAllowanceClear + 1
  ) {
    throw new Error('Testnet Morpho configuration transaction count is not canonical.');
  }
  if (manifest.configurationTransactions.length === requiredCountWithoutAllowanceClear + 1) {
    expected.push(
      expectedWrite(
        'clear pre-existing Morpho seed allowance',
        sender,
        loanToken,
        ERC20_ABI,
        'approve',
        [morpho, 0n],
      ),
    );
  }
  expected.push(
    expectedWrite('approve exact Morpho seed liquidity', sender, loanToken, ERC20_ABI, 'approve', [
      morpho,
      BigInt(manifest.market.seedLiquidityAssets),
    ]),
    expectedWrite(
      'supply real testnet loan-token liquidity',
      sender,
      morpho,
      artifacts.morpho.abi,
      'supply',
      [
        marketParams,
        BigInt(manifest.market.seedLiquidityAssets),
        0n,
        manifest.market.seedLiquidityOwner,
        '0x',
      ],
    ),
    expectedWrite('revoke Morpho seed allowance', sender, loanToken, ERC20_ABI, 'approve', [
      morpho,
      0n,
    ]),
  );
  if (ownerTransferCount === 1) {
    expected.push(
      expectedWrite('transfer Morpho owner', sender, morpho, artifacts.morpho.abi, 'setOwner', [
        manifest.owner,
      ]),
    );
  }
  return expected;
}

function expectedWrite(
  action: string,
  sender: Address,
  target: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): ExpectedConfigurationTransaction {
  return {
    action,
    sender,
    target,
    input: encodeFunctionData({ abi, functionName, args }),
  };
}

function assertDeploymentTimeline(manifest: TestnetMorphoDeploymentManifest): void {
  const contracts = [manifest.contracts.morpho, manifest.contracts.irm, manifest.contracts.oracle];
  const contractBlocks = contracts.map((record) => BigInt(record.deploymentBlockNumber));
  const minimumBlock = contractBlocks.reduce((minimum, block) =>
    block < minimum ? block : minimum,
  );
  if (
    BigInt(manifest.deploymentBlockNumber) !== minimumBlock ||
    contractBlocks[0]! > contractBlocks[1]! ||
    contractBlocks[1]! > contractBlocks[2]!
  ) {
    throw new Error('Testnet Morpho deployment timeline is not canonical.');
  }
  let previousBlock = contractBlocks[2]!;
  for (const transaction of manifest.configurationTransactions) {
    const block = BigInt(transaction.blockNumber);
    if (block < previousBlock) {
      throw new Error('Testnet Morpho configuration transaction timeline is not canonical.');
    }
    previousBlock = block;
  }
}

async function assertCanonicalBlock(
  client: PublicClient,
  blockNumber: bigint,
  blockHash: Hex,
  label: string,
): Promise<void> {
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash?.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error(`Testnet Morpho block is no longer canonical for ${label}.`);
  }
}

async function verifyCodeRecord(
  client: PublicClient,
  record: { readonly address: Address; readonly runtimeCodeHash: Hex },
): Promise<void> {
  const code = await client.getCode({ address: record.address });
  if (code === undefined || code === '0x' || keccak256(code) !== record.runtimeCodeHash) {
    throw new Error(`Testnet Morpho dependency code drifted at ${record.address}.`);
  }
}

async function readTokenRecords(input: TestnetMorphoDeploymentInput) {
  const [collateral, loan] = await Promise.all([
    readCodeAndDecimals(input.publicClient, input.collateralToken, ERC20_ABI),
    readCodeAndDecimals(input.publicClient, input.loanToken, ERC20_ABI),
  ]);
  return { collateral, loan };
}

async function readFeedRecords(input: TestnetMorphoDeploymentInput) {
  const [collateral, loan, sequencerUptime] = await Promise.all([
    readCodeAndDecimals(input.publicClient, input.collateralFeed, FEED_ABI),
    readCodeAndDecimals(input.publicClient, input.loanFeed, FEED_ABI),
    input.sequencerUptimeFeed === undefined ||
    isAddressEqual(input.sequencerUptimeFeed, zeroAddress)
      ? Promise.resolve(null)
      : readCodeAndDecimals(input.publicClient, input.sequencerUptimeFeed, FEED_ABI),
  ]);
  return { collateral, loan, sequencerUptime };
}

async function readCodeAndDecimals(client: PublicClient, address: Address, abi: Abi) {
  const [code, decimals] = await Promise.all([
    client.getCode({ address }),
    readBigInt(client, abi, address, 'decimals', []),
  ]);
  if (code === undefined || code === '0x' || decimals > 36n) {
    throw new Error(`Invalid testnet Morpho token or feed at ${address}.`);
  }
  return {
    address: getAddress(address),
    decimals: Number(decimals),
    runtimeCodeHash: keccak256(code),
  };
}

async function readMarket(client: PublicClient, abi: Abi, morpho: Address, marketId: Hex) {
  const result = await client.readContract({
    address: morpho,
    abi,
    functionName: 'market',
    args: [marketId],
  });
  const values = Array.isArray(result) ? result : undefined;
  if (values?.length !== 6 || values.some((value) => typeof value !== 'bigint')) {
    throw new Error('Unexpected testnet Morpho market response.');
  }
  return {
    totalSupplyAssets: values[0] as bigint,
    totalSupplyShares: values[1] as bigint,
    totalBorrowAssets: values[2] as bigint,
    totalBorrowShares: values[3] as bigint,
    lastUpdate: values[4] as bigint,
    fee: values[5] as bigint,
  };
}

async function readPosition(
  client: PublicClient,
  abi: Abi,
  morpho: Address,
  marketId: Hex,
  user: Address,
) {
  const result = await client.readContract({
    address: morpho,
    abi,
    functionName: 'position',
    args: [marketId, user],
  });
  const values = Array.isArray(result) ? result : undefined;
  if (values?.length !== 3 || values.some((value) => typeof value !== 'bigint')) {
    throw new Error('Unexpected testnet Morpho position response.');
  }
  return {
    supplyShares: values[0] as bigint,
    borrowShares: values[1] as bigint,
    collateral: values[2] as bigint,
  };
}

function parseSupplyResult(result: unknown): { readonly assets: bigint; readonly shares: bigint } {
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    typeof result[0] !== 'bigint' ||
    typeof result[1] !== 'bigint'
  ) {
    throw new Error('Unexpected testnet Morpho supply simulation response.');
  }
  return { assets: result[0], shares: result[1] };
}

function parseMarketParams(result: unknown): MorphoMarketParams {
  if (
    !Array.isArray(result) ||
    result.length !== 5 ||
    typeof result[0] !== 'string' ||
    typeof result[1] !== 'string' ||
    typeof result[2] !== 'string' ||
    typeof result[3] !== 'string' ||
    typeof result[4] !== 'bigint'
  ) {
    throw new Error('Unexpected testnet Morpho market-parameter response.');
  }
  return {
    loanToken: getAddress(result[0]),
    collateralToken: getAddress(result[1]),
    oracle: getAddress(result[2]),
    irm: getAddress(result[3]),
    lltv: result[4],
  };
}

function assertMarketParams(actual: MorphoMarketParams, expected: MorphoMarketParams): void {
  if (
    !isAddressEqual(actual.loanToken, expected.loanToken) ||
    !isAddressEqual(actual.collateralToken, expected.collateralToken) ||
    !isAddressEqual(actual.oracle, expected.oracle) ||
    !isAddressEqual(actual.irm, expected.irm) ||
    actual.lltv !== expected.lltv
  ) {
    throw new Error('Testnet Morpho market parameters drifted from the manifest.');
  }
}

async function readAddress(
  client: PublicClient,
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<Address> {
  const result = await client.readContract({ address, abi, functionName, args });
  if (typeof result !== 'string') throw new Error(`Unexpected ${functionName} address response.`);
  return getAddress(result);
}

async function readBoolean(
  client: PublicClient,
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<boolean> {
  const result = await client.readContract({ address, abi, functionName, args });
  if (typeof result !== 'boolean') throw new Error(`Unexpected ${functionName} boolean response.`);
  return result;
}

async function readBigInt(
  client: PublicClient,
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<bigint> {
  const result = await client.readContract({ address, abi, functionName, args });
  if (typeof result === 'bigint') return result;
  if (typeof result === 'number' && Number.isSafeInteger(result) && result >= 0) {
    return BigInt(result);
  }
  throw new Error(`Unexpected ${functionName} integer response.`);
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function minimumDeploymentBlock(records: readonly ContractRecord[]): string {
  return records
    .map(({ deploymentBlockNumber }) => BigInt(deploymentBlockNumber))
    .reduce((current, next) => (next < current ? next : current))
    .toString();
}

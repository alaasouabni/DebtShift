import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  computeMigrationId,
  executionPlanTypes,
  hashCanonicalText,
  type TokenReference,
} from '@debtshift/domain';
import { OneClickReadOnlyClient, verifyOneClickRouteAssets } from '@debtshift/intents';
import { compareRoutes, routeCandidateSchema, routePolicySchema } from '@debtshift/optimizer';
import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AaveV3ReadAdapter,
  buildAaveCollateralClaimAuthorization,
  discoverAaveUserReserves,
  ERC20_METADATA_ABI,
  readAaveReserveTokenAddresses,
} from './aave-v3.js';
import { loadFoundryArtifact, type FoundryArtifact } from './artifacts.js';
import { ChainlinkOracleFreshnessReader } from './chainlink-oracle.js';
import { type LocalAnvilChain, startAnvil } from './local-chain.js';
import {
  buildMorphoAuthorizationPair,
  encodeMorphoAuthorizationPair,
  MORPHO_BLUE_READ_ABI,
  MorphoBlueReadAdapter,
  morphoAuthorizationTypedData,
} from './morpho-blue.js';
import { MorphoMarketDiscoveryClient, type DiscoveredMorphoMarket } from './morpho-discovery.js';

const BASE_CHAIN_ID = 8_453;
const ARBITRUM_CHAIN_ID = 42_161;
const FORK_BORROWER_PRIVATE_KEY =
  '0x229fd969e094ca4cfc3db7ec738d91e87097030765eef8768c6a34e41bcf018f' as const;

const AAVE_POOL = getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
const AAVE_DATA_PROVIDER = getAddress('0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A');
const BASE_MORPHO_LIQUIDITY_HOLDER = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
const BASE_WETH = getAddress('0x4200000000000000000000000000000000000006');
const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');

const ARBITRUM_MORPHO = getAddress('0x6c247b1F6182318877311737BaC0844bAa518F5e');
const ARBITRUM_WETH = getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
const ARBITRUM_USDC = getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
const APPROVED_MORPHO_ORACLE = getAddress('0x282FEB10549fde52bD61A6979424Ddf18A4971A2');
const ARBITRUM_ETH_USD_FEED = getAddress('0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612');
const ARBITRUM_USDC_USD_FEED = getAddress('0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3');
const ARBITRUM_SEQUENCER_FEED = getAddress('0xFdB631F5EE196F0ed6FAa767959853A9F217697D');
const TRANSPORT_SINK = getAddress('0x000000000000000000000000000000000000dEaD');

const SOURCE_COLLATERAL = {
  chainId: BASE_CHAIN_ID,
  address: BASE_WETH,
  decimals: 18,
  symbol: 'WETH',
  providerAssetId: 'nep141:base-0x4200000000000000000000000000000000000006.omft.near',
} as const satisfies TokenReference;
const SOURCE_DEBT = {
  chainId: BASE_CHAIN_ID,
  address: BASE_USDC,
  decimals: 6,
  symbol: 'USDC',
  providerAssetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
} as const satisfies TokenReference;
const DESTINATION_COLLATERAL = {
  chainId: ARBITRUM_CHAIN_ID,
  address: ARBITRUM_WETH,
  decimals: 18,
  symbol: 'WETH',
  providerAssetId: 'nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near',
} as const satisfies TokenReference;
const DESTINATION_DEBT = {
  chainId: ARBITRUM_CHAIN_ID,
  address: ARBITRUM_USDC,
  decimals: 6,
  symbol: 'USDC',
  providerAssetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
} as const satisfies TokenReference;

const WETH_ABI = [
  ...ERC20_METADATA_ABI,
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

const AAVE_POSITION_ABI = [
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'borrow',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'referralCode', type: 'uint16' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const baseForkRpcUrl = process.env.BASE_FORK_RPC_URL;
const arbitrumForkRpcUrl = process.env.ARBITRUM_FORK_RPC_URL;
const runForkProof =
  baseForkRpcUrl === undefined || arbitrumForkRpcUrl === undefined ? describe.skip : describe;

runForkProof('automatically discovered Base Aave to Arbitrum Morpho mainnet-fork proof', () => {
  const borrower = privateKeyToAccount(FORK_BORROWER_PRIVATE_KEY);
  let sourceFork: LocalAnvilChain;
  let destinationFork: LocalAnvilChain;
  let sourcePublic: PublicClient;
  let destinationPublic: PublicClient;
  let sourceWallet: WalletClient;
  let destinationWallet: WalletClient;

  beforeAll(async () => {
    [sourceFork, destinationFork] = await Promise.all([
      startAnvil({
        chainId: BASE_CHAIN_ID,
        port: 19_576,
        forkUrl: requiredBaseForkRpcUrl(),
      }),
      startAnvil({
        chainId: ARBITRUM_CHAIN_ID,
        port: 19_577,
        forkUrl: requiredArbitrumForkRpcUrl(),
      }),
    ]);
    sourcePublic = sourceFork.publicClient;
    destinationPublic = destinationFork.publicClient;
    sourceWallet = createWalletClient({
      account: borrower,
      chain: sourceFork.chain,
      transport: http(sourceFork.rpcUrl),
    });
    destinationWallet = createWalletClient({
      account: borrower,
      chain: destinationFork.chain,
      transport: http(destinationFork.rpcUrl),
    });
    await Promise.all([
      createTestClient({
        chain: sourceFork.chain,
        mode: 'anvil',
        transport: http(sourceFork.rpcUrl),
      }).setBalance({ address: borrower.address, value: parseEther('100') }),
      createTestClient({
        chain: destinationFork.chain,
        mode: 'anvil',
        transport: http(destinationFork.rpcUrl),
      }).setBalance({ address: borrower.address, value: parseEther('100') }),
    ]);
  }, 90_000);

  afterAll(async () => {
    await Promise.all([sourceFork?.stop(), destinationFork?.stop()]);
  }, 15_000);

  it('discovers, selects, and executes the winning route without real funds', async () => {
    const [sourcePinned, destinationPinned] = await Promise.all([
      sourcePublic.getBlock({ blockTag: 'latest' }),
      destinationPublic.getBlock({ blockTag: 'latest' }),
    ]);
    if (sourcePinned.hash === null || destinationPinned.hash === null) {
      throw new Error('The upstream fork origins must be mined blocks.');
    }

    const transactions: Record<string, Hex> = {};
    transactions.wrapSource = await write(
      sourceWallet,
      sourcePublic,
      BASE_WETH,
      WETH_ABI,
      'deposit',
      [],
      parseEther('10'),
    );
    transactions.approveAave = await write(
      sourceWallet,
      sourcePublic,
      BASE_WETH,
      ERC20_METADATA_ABI,
      'approve',
      [AAVE_POOL, parseEther('10')],
    );
    transactions.supplyAave = await write(
      sourceWallet,
      sourcePublic,
      AAVE_POOL,
      AAVE_POSITION_ABI,
      'supply',
      [BASE_WETH, parseEther('10'), borrower.address, 0],
    );
    transactions.borrowAave = await write(
      sourceWallet,
      sourcePublic,
      AAVE_POOL,
      AAVE_POSITION_ABI,
      'borrow',
      [BASE_USDC, 1_000n * 10n ** 6n, 2n, 0, borrower.address],
    );

    const discoveredSource = await discoverAaveUserReserves(
      sourcePublic,
      { chainId: BASE_CHAIN_ID, pool: AAVE_POOL, dataProvider: AAVE_DATA_PROVIDER },
      borrower.address,
    );
    expect(
      discoveredSource.reserves.some(
        (reserve) => reserve.asset === BASE_WETH && BigInt(reserve.collateralUnits) > 0n,
      ),
    ).toBe(true);
    expect(
      discoveredSource.reserves.some(
        (reserve) => reserve.asset === BASE_USDC && BigInt(reserve.variableDebtUnits) > 0n,
      ),
    ).toBe(true);

    const aave = new AaveV3ReadAdapter(sourcePublic, {
      chainId: BASE_CHAIN_ID,
      pool: AAVE_POOL,
      dataProvider: AAVE_DATA_PROVIDER,
      collateralAsset: SOURCE_COLLATERAL,
      debtAsset: SOURCE_DEBT,
    });
    const sourceTestClient = createTestClient({
      chain: sourceFork.chain,
      mode: 'anvil',
      transport: http(sourceFork.rpcUrl),
    });
    await sourceTestClient.increaseTime({ seconds: 3_600 });
    await sourceTestClient.mine({ blocks: 1 });

    await sourceTestClient.setBalance({
      address: BASE_MORPHO_LIQUIDITY_HOLDER,
      value: parseEther('1'),
    });
    await sourceTestClient.impersonateAccount({ address: BASE_MORPHO_LIQUIDITY_HOLDER });
    const liquidityWallet = createWalletClient({
      account: BASE_MORPHO_LIQUIDITY_HOLDER,
      chain: sourceFork.chain,
      transport: http(sourceFork.rpcUrl),
    });
    transactions.fundForkVault = await write(
      liquidityWallet,
      sourcePublic,
      BASE_USDC,
      ERC20_TRANSFER_ABI,
      'transfer',
      [borrower.address, 1_100n * 10n ** 6n],
    );
    await sourceTestClient.stopImpersonatingAccount({ address: BASE_MORPHO_LIQUIDITY_HOLDER });

    const sourcePosition = await aave.readPosition(borrower.address);
    if (sourcePosition === undefined) throw new Error('Fork source position was not discovered.');
    const maximumRepayUnits = BigInt(sourcePosition.debtUnits) + 1n * 10n ** 6n;

    const oneClick = new OneClickReadOnlyClient({
      baseUrl: 'https://1click.chaindefuser.com',
      requestTimeoutMs: 15_000,
    });
    const catalog = await oneClick.getTokenCatalogObservation();
    const transportAssets = verifyOneClickRouteAssets(catalog.tokens, [
      SOURCE_COLLATERAL,
      SOURCE_DEBT,
      DESTINATION_COLLATERAL,
      DESTINATION_DEBT,
    ]);

    const discovery = await new MorphoMarketDiscoveryClient({
      requestTimeoutMs: 15_000,
    }).discoverMarkets({
      chainId: ARBITRUM_CHAIN_ID,
      loanToken: ARBITRUM_USDC,
      collateralToken: ARBITRUM_WETH,
      listed: true,
    });
    const approvedMarkets = discovery.markets.filter(
      (market) => market.oracle === APPROVED_MORPHO_ORACLE,
    );
    expect(approvedMarkets.length).toBeGreaterThan(0);

    const freshness = new ChainlinkOracleFreshnessReader(destinationPublic, {
      morphoOracle: APPROVED_MORPHO_ORACLE,
      feeds: [
        { address: ARBITRUM_ETH_USD_FEED, maximumAgeSeconds: 90_000 },
        { address: ARBITRUM_USDC_USD_FEED, maximumAgeSeconds: 90_000 },
      ],
      sequencerUptimeFeed: {
        address: ARBITRUM_SEQUENCER_FEED,
        recoveryGraceSeconds: 3_600,
      },
    });
    const morpho = new MorphoBlueReadAdapter(
      destinationPublic,
      { chainId: ARBITRUM_CHAIN_ID, morpho: ARBITRUM_MORPHO },
      freshness,
    );
    const marketObservations = await Promise.all(
      approvedMarkets.map(async (indexed) => ({
        indexed,
        observed: await morpho.readMarket(indexed.marketId, maximumRepayUnits),
      })),
    );
    for (const { indexed, observed } of marketObservations) {
      assertIndexedMarket(indexed, observed.params);
    }

    const evaluatedAt = new Date(
      Math.max(
        Date.parse(sourcePosition.block.observedAt),
        ...marketObservations.map(({ observed }) => Date.parse(observed.snapshot.block.observedAt)),
      ),
    ).toISOString();
    const minimumDestinationCollateral = parseEther('9.99');
    const candidates = marketObservations.map(({ observed }) => {
      const deliveredLoanUnits =
        (minimumDestinationCollateral * BigInt(observed.snapshot.oracle.priceMantissa)) /
        10n ** 36n;
      const protocolCapacity =
        (deliveredLoanUnits * BigInt(observed.snapshot.lltvBps ?? 0)) / 10_000n;
      const policyCapacity = (deliveredLoanUnits * 6_000n) / 10_000n;
      const liquidityCapacity = (BigInt(observed.availableBorrowUnits) * 10_000n) / 10_500n;
      const candidateId = `live-morpho:${observed.marketId}`;
      return routeCandidateSchema.parse({
        candidateId,
        market: observed.snapshot,
        requestedBorrowUnits: maximumRepayUnits.toString(),
        principalDebtValueUsdMicro: sourcePosition.debtUnits,
        targetDebtValueUsdMicro: maximumRepayUnits.toString(),
        deliveredCollateralValueUsdMicro: deliveredLoanUnits.toString(),
        costs: {
          sourceGasUsdMicro: '0',
          destinationGasUsdMicro: '0',
          transportFeeUsdMicro: '0',
          slippageUsdMicro: '0',
          solverFeeUsdMicro: '0',
          protocolFeeUsdMicro: '0',
          collateralSwapCostUsdMicro: '0',
        },
        carryingCostAprBps: 0,
        tailLossEstimateUsdMicro: '0',
        settlementRiskCostUsdMicro: '0',
        dependencyRiskCostUsdMicro: '0',
        estimatedSettlementSeconds: 300,
        settlementTimeP95Seconds: 1_800,
        rateProjection: {
          kind: 'DIRECT_PROJECTION',
          currentBorrowAprBps: observed.currentBorrowAprBps,
          projectedBorrowAprBps: observed.projectedBorrowAprBps,
          provenance: `pinned-arbitrum-fork:${observed.blockNumber}`,
        },
        assetRouteSupported: true,
        adapterVersionApproved: true,
        transportMinimumMet: true,
        financing: {
          evaluatedAt,
          settlementAsset: DESTINATION_DEBT,
          sourcePayoff: {
            asset: SOURCE_DEBT,
            amountUnits: maximumRepayUnits.toString(),
            settlementAmountUnits: maximumRepayUnits.toString(),
            conversion: {
              quoteHash: hashCanonicalText(`debtshift.mainnet-fork-parity.v1:${maximumRepayUnits}`),
              provider: 'MAINNET_FORK_DETERMINISTIC_PARITY',
              inputAsset: SOURCE_DEBT,
              outputAsset: DESTINATION_DEBT,
              amountInUnits: maximumRepayUnits.toString(),
              amountOutUnits: maximumRepayUnits.toString(),
              expiresAt: new Date(Date.parse(evaluatedAt) + 3_600_000).toISOString(),
            },
          },
          costs: [],
          solverFee: {
            asset: DESTINATION_DEBT,
            amountUnits: '0',
            signedCapUnits: '0',
          },
          externalFunding: [],
          capacities: {
            protocolUnits: protocolCapacity.toString(),
            policyUnits: policyCapacity.toString(),
            liquidityUnits: liquidityCapacity.toString(),
            signedUnits: maximumRepayUnits.toString(),
          },
        },
      });
    });
    const policy = routePolicySchema.parse({
      evaluatedAt,
      horizonDays: 90,
      maxAllInCostUsdMicro: '1',
      minAprReductionBps: 0,
      maxPositionSnapshotAgeSeconds: 86_400,
      maxMarketSnapshotAgeSeconds: 86_400,
      maxOracleAgeSeconds: 86_400,
      minimumLiquidityBufferBps: 500,
      stressCollateralDropBps: 2_000,
      stressTargetAprIncreaseBps: 200,
      requirePositiveNetBenefit: true,
      safetyPolicy: {
        kind: 'MAX_LTV_BPS',
        maximumLtvBps: 7_000,
        stressMaximumLtvBps: 6_000,
      },
    });
    const comparison = compareRoutes({ sourcePosition, candidates, policy });
    const selectedEvaluation = comparison.evaluations.find(
      (evaluation) => evaluation.candidateId === comparison.selectedCandidateId,
    );
    if (selectedEvaluation === undefined || !selectedEvaluation.eligible) {
      throw new Error('Automatic discovery produced no eligible mainnet-fork route.');
    }
    const selectedMarket = marketObservations.find(
      ({ observed }) => `live-morpho:${observed.marketId}` === comparison.selectedCandidateId,
    )?.observed;
    if (selectedMarket === undefined) throw new Error('Selected Morpho market was not observed.');

    const [collateralReserveTokens, debtReserveTokens] = await Promise.all([
      readAaveReserveTokenAddresses(sourcePublic, AAVE_DATA_PROVIDER, BASE_WETH),
      readAaveReserveTokenAddresses(sourcePublic, AAVE_DATA_PROVIDER, BASE_USDC),
    ]);
    const [
      vaultArtifact,
      escrowArtifact,
      aaveSourceArtifact,
      sourceAdapterArtifact,
      morphoTargetArtifact,
      destinationAdapterArtifact,
    ] = await Promise.all([
      loadFoundryArtifact('LiquidityVault'),
      loadFoundryArtifact('MigrationEscrow'),
      loadFoundryArtifact('AaveV3SourceLending'),
      loadFoundryArtifact('SourceAdapter'),
      loadFoundryArtifact('MorphoBlueTargetLending'),
      loadFoundryArtifact('DestinationAdapter'),
    ]);

    const vault = await deploy(sourceWallet, sourcePublic, vaultArtifact, [borrower.address]);
    const sourceEscrow = await deploy(sourceWallet, sourcePublic, escrowArtifact, [
      borrower.address,
    ]);
    const aaveSource = await deploy(sourceWallet, sourcePublic, aaveSourceArtifact, [
      borrower.address,
      AAVE_POOL,
      collateralReserveTokens.aToken,
      debtReserveTokens.variableDebtToken,
      BASE_WETH,
      BASE_USDC,
    ]);
    const sourceAdapter = await deploy(sourceWallet, sourcePublic, sourceAdapterArtifact, [
      borrower.address,
      vault,
      aaveSource,
      sourceEscrow,
    ]);
    const destinationEscrow = await deploy(destinationWallet, destinationPublic, escrowArtifact, [
      borrower.address,
    ]);
    const morphoTarget = await deploy(destinationWallet, destinationPublic, morphoTargetArtifact, [
      borrower.address,
      ARBITRUM_MORPHO,
      selectedMarket.params,
    ]);
    const destinationAdapter = await deploy(
      destinationWallet,
      destinationPublic,
      destinationAdapterArtifact,
      [borrower.address, morphoTarget, destinationEscrow],
    );

    await write(
      sourceWallet,
      sourcePublic,
      aaveSource,
      aaveSourceArtifact.abi,
      'setSourceAdapter',
      [sourceAdapter],
    );
    await write(
      destinationWallet,
      destinationPublic,
      morphoTarget,
      morphoTargetArtifact.abi,
      'setDestinationAdapter',
      [destinationAdapter],
    );
    await write(sourceWallet, sourcePublic, vault, vaultArtifact.abi, 'setAsset', [
      BASE_USDC,
      true,
    ]);
    await write(sourceWallet, sourcePublic, vault, vaultArtifact.abi, 'setAdapter', [
      sourceAdapter,
      true,
    ]);
    await write(sourceWallet, sourcePublic, sourceEscrow, escrowArtifact.abi, 'setDepositor', [
      sourceAdapter,
      true,
    ]);
    await write(
      destinationWallet,
      destinationPublic,
      destinationEscrow,
      escrowArtifact.abi,
      'setOperator',
      [destinationAdapter, true],
    );
    await write(
      destinationWallet,
      destinationPublic,
      destinationAdapter,
      destinationAdapterArtifact.abi,
      'setPlanDomain',
      [BASE_CHAIN_ID, sourceAdapter, true],
    );
    await write(sourceWallet, sourcePublic, BASE_USDC, ERC20_METADATA_ABI, 'approve', [
      vault,
      maximumRepayUnits,
    ]);
    await write(sourceWallet, sourcePublic, vault, vaultArtifact.abi, 'deposit', [
      BASE_USDC,
      maximumRepayUnits,
    ]);

    const sourceLatest = await sourcePublic.getBlock({ blockTag: 'latest' });
    const deadline = sourceLatest.timestamp + 1_800n;
    const nonce = 1n;
    const intentHash = hashCanonicalText('debtshift.discovered-mainnet-fork-intent.v1');
    const routeHash = hashCanonicalText(
      JSON.stringify({
        sourceSnapshotId: sourcePosition.snapshotId,
        selectedCandidateId: comparison.selectedCandidateId,
        discoveryRequestHash: discovery.requestHash,
        catalogResponseHash: catalog.responseHash,
      }),
    );
    const transportQuoteHash = hashCanonicalText(
      `debtshift.simulated-1click-mainnet-fork.v1:${routeHash}`,
    );
    const migrationId = computeMigrationId(intentHash, transportQuoteHash, nonce);
    const plan = {
      intentHash,
      migrationId,
      borrower: borrower.address,
      sourcePositionId: hashCanonicalText(
        `debtshift.discovered-mainnet-fork-position.v1:${sourcePosition.snapshotId}`,
      ),
      routeHash,
      transportQuoteHash,
      sourceRepaymentMax: maximumRepayUnits,
      sourceCollateralMin: parseEther('10'),
      targetDebtMax: maximumRepayUnits,
      minDestinationCollateral: minimumDestinationCollateral,
      principalMax: maximumRepayUnits,
      feeMax: 0n,
      destinationReceiver: destinationEscrow,
      transportRefundReceiver: sourceEscrow,
      refundReceiver: borrower.address,
      payoutReceiver: borrower.address,
      deadline,
      nonce,
    } as const;
    const typedPlan = {
      domain: {
        name: 'DebtShift',
        version: '2',
        chainId: BASE_CHAIN_ID,
        verifyingContract: sourceAdapter,
      },
      types: executionPlanTypes,
      primaryType: 'ExecutionPlan',
      message: plan,
    } as const;
    const planHash = hashTypedData(typedPlan);
    const signature = await borrower.signTypedData(typedPlan);
    expect(
      await sourcePublic.readContract({
        address: sourceAdapter,
        abi: sourceAdapterArtifact.abi,
        functionName: 'executionPlanHash',
        args: [plan],
      }),
    ).toBe(planHash);

    const analysisHash = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, uint256'), [
        planHash,
        BigInt(sourcePosition.debtUnits),
      ]),
    );
    const sourceFeasibility = {
      planHash,
      analysisHash,
      externalFundingEvidenceHash: `0x${'00'.repeat(32)}`,
      liquidityAsset: BASE_USDC,
      solverPrincipalUnits: maximumRepayUnits,
      solverFeeUnits: 0n,
      capitalizedCostUnits: 0n,
      totalRequiredUnits: maximumRepayUnits,
      confirmedExternalFundingUnits: 0n,
      maximumSafeBorrowingCapacityUnits: maximumRepayUnits,
      requiredDestinationBorrowUnits: maximumRepayUnits,
      fundingShortfallUnits: 0n,
      sequence: 1n,
      evaluatedAt: sourceLatest.timestamp,
      validUntil: deadline,
    } as const;
    await write(sourceWallet, sourcePublic, vault, vaultArtifact.abi, 'recordFeasibility', [
      migrationId,
      sourceFeasibility,
    ]);
    const sourceFeasibilityHash = await sourcePublic.readContract({
      address: vault,
      abi: vaultArtifact.abi,
      functionName: 'latestFeasibilityHash',
      args: [migrationId],
    });
    await write(sourceWallet, sourcePublic, BASE_USDC, ERC20_METADATA_ABI, 'approve', [
      vault,
      maximumRepayUnits,
    ]);
    await write(sourceWallet, sourcePublic, vault, vaultArtifact.abi, 'reserve', [
      migrationId,
      BASE_USDC,
      sourceAdapter,
      planHash,
      sourceFeasibilityHash,
      maximumRepayUnits,
      0n,
      deadline,
    ]);
    const collateralAuthorization = buildAaveCollateralClaimAuthorization(
      collateralReserveTokens.aToken,
      aaveSource,
      parseEther('10'),
    );
    transactions.authorizeSource = await sendPrepared(
      sourceWallet,
      sourcePublic,
      collateralAuthorization,
    );
    transactions.closeSource = await write(
      sourceWallet,
      sourcePublic,
      sourceAdapter,
      sourceAdapterArtifact.abi,
      'closeSource',
      [plan, signature],
    );
    expect(await aave.readPosition(borrower.address)).toBeUndefined();

    const reservation = await sourcePublic.readContract({
      address: vault,
      abi: vaultArtifact.abi,
      functionName: 'reservations',
      args: [migrationId],
    });
    const actualReceivable = Array.isArray(reservation) ? reservation[8] : undefined;
    if (typeof actualReceivable !== 'bigint') throw new Error('Expected a source receivable.');
    const postSourceBlock = await sourcePublic.getBlock({ blockTag: 'latest' });
    await write(sourceWallet, sourcePublic, vault, vaultArtifact.abi, 'recordFeasibility', [
      migrationId,
      {
        ...sourceFeasibility,
        solverPrincipalUnits: actualReceivable,
        totalRequiredUnits: actualReceivable,
        requiredDestinationBorrowUnits: actualReceivable,
        sequence: 2n,
        evaluatedAt: postSourceBlock.timestamp,
      },
    ]);

    transactions.dispatchToSimulatedOneClick = await write(
      sourceWallet,
      sourcePublic,
      sourceEscrow,
      escrowArtifact.abi,
      'release',
      [migrationId, BASE_WETH, borrower.address, parseEther('10')],
    );
    transactions.simulatedOneClickCustody = await write(
      sourceWallet,
      sourcePublic,
      BASE_WETH,
      ERC20_TRANSFER_ABI,
      'transfer',
      [TRANSPORT_SINK, parseEther('10')],
    );
    transactions.wrapDestination = await write(
      destinationWallet,
      destinationPublic,
      ARBITRUM_WETH,
      WETH_ABI,
      'deposit',
      [],
      minimumDestinationCollateral,
    );
    await write(
      destinationWallet,
      destinationPublic,
      ARBITRUM_WETH,
      ERC20_METADATA_ABI,
      'approve',
      [destinationEscrow, minimumDestinationCollateral],
    );
    transactions.registerSimulatedDelivery = await write(
      destinationWallet,
      destinationPublic,
      destinationEscrow,
      escrowArtifact.abi,
      'assign',
      [migrationId, ARBITRUM_WETH, borrower.address, minimumDestinationCollateral],
    );

    const destinationBlock = await destinationPublic.getBlock({ blockTag: 'latest' });
    const destinationFeasibility = {
      planHash,
      analysisHash,
      externalFundingEvidenceHash: `0x${'00'.repeat(32)}`,
      settlementAsset: ARBITRUM_USDC,
      solverPrincipalUnits: actualReceivable,
      solverFeeUnits: 0n,
      capitalizedCostUnits: 0n,
      totalRequiredUnits: actualReceivable,
      confirmedExternalFundingUnits: 0n,
      maximumSafeBorrowingCapacityUnits: maximumRepayUnits,
      requiredDestinationBorrowUnits: actualReceivable,
      fundingShortfallUnits: 0n,
      sequence: 1n,
      evaluatedAt: destinationBlock.timestamp,
      validUntil: deadline,
    } as const;
    await write(
      destinationWallet,
      destinationPublic,
      destinationAdapter,
      destinationAdapterArtifact.abi,
      'recordFeasibility',
      [migrationId, destinationFeasibility],
    );
    const destinationFeasibilityHash = await destinationPublic.readContract({
      address: destinationAdapter,
      abi: destinationAdapterArtifact.abi,
      functionName: 'latestFeasibilityHash',
      args: [migrationId],
    });
    const morphoNonce = await destinationPublic.readContract({
      address: ARBITRUM_MORPHO,
      abi: MORPHO_BLUE_READ_ABI,
      functionName: 'nonce',
      args: [borrower.address],
    });
    const authorizationPair = buildMorphoAuthorizationPair(
      borrower.address,
      morphoTarget,
      morphoNonce,
      deadline,
    );
    const [enableSignature, disableSignature] = await Promise.all([
      borrower.signTypedData(
        morphoAuthorizationTypedData(ARBITRUM_CHAIN_ID, ARBITRUM_MORPHO, authorizationPair.enable),
      ),
      borrower.signTypedData(
        morphoAuthorizationTypedData(ARBITRUM_CHAIN_ID, ARBITRUM_MORPHO, authorizationPair.disable),
      ),
    ]);
    const payoutBefore = await destinationPublic.readContract({
      address: ARBITRUM_USDC,
      abi: WETH_ABI,
      functionName: 'balanceOf',
      args: [borrower.address],
    });
    transactions.openDestination = await write(
      destinationWallet,
      destinationPublic,
      destinationAdapter,
      destinationAdapterArtifact.abi,
      'openDestination',
      [
        plan,
        signature,
        {
          sourceChainId: BigInt(BASE_CHAIN_ID),
          sourceAdapter,
          collateralUnits: minimumDestinationCollateral,
          borrowUnits: actualReceivable,
          feasibilityHash: destinationFeasibilityHash,
          fundingEvidenceHash: `0x${'00'.repeat(32)}`,
          solverPrincipalUnits: actualReceivable,
          solverFeeUnits: 0n,
          capitalizedCostUnits: 0n,
          capitalizedCostReceiver: '0x0000000000000000000000000000000000000000',
          lendingAuthorization: encodeMorphoAuthorizationPair(
            authorizationPair,
            enableSignature,
            disableSignature,
          ),
        },
      ],
    );

    const targetPosition = await morpho.readPosition(selectedMarket.marketId, borrower.address);
    expect(BigInt(targetPosition.collateralUnits)).toBe(minimumDestinationCollateral);
    expect(BigInt(targetPosition.debtUnits)).toBeGreaterThanOrEqual(actualReceivable);
    expect(
      await destinationPublic.readContract({
        address: ARBITRUM_USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [borrower.address],
      }),
    ).toBe(payoutBefore + actualReceivable);

    transactions.settleSourceVault = await write(
      sourceWallet,
      sourcePublic,
      vault,
      vaultArtifact.abi,
      'settle',
      [migrationId, borrower.address, 0n],
    );
    const settledReservation = await sourcePublic.readContract({
      address: vault,
      abi: vaultArtifact.abi,
      functionName: 'reservations',
      args: [migrationId],
    });
    expect(Array.isArray(settledReservation) ? settledReservation[6] : undefined).toBe(3);

    const residualBalances = await Promise.all([
      destinationPublic.readContract({
        address: ARBITRUM_WETH,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [morphoTarget],
      }),
      destinationPublic.readContract({
        address: ARBITRUM_USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [morphoTarget],
      }),
      destinationPublic.readContract({
        address: ARBITRUM_WETH,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationAdapter],
      }),
      destinationPublic.readContract({
        address: ARBITRUM_USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationAdapter],
      }),
      destinationPublic.readContract({
        address: ARBITRUM_WETH,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationEscrow],
      }),
      destinationPublic.readContract({
        address: ARBITRUM_USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationEscrow],
      }),
    ]);
    expect(residualBalances).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);

    await writeProofReport({
      status: 'PASSED',
      mainnetExecutionEnabled: false,
      borrower: borrower.address,
      sourceBlock: {
        chainId: BASE_CHAIN_ID,
        number: sourcePinned.number.toString(),
        hash: sourcePinned.hash,
      },
      destinationBlock: {
        chainId: ARBITRUM_CHAIN_ID,
        number: destinationPinned.number.toString(),
        hash: destinationPinned.hash,
      },
      discovery: {
        provider: discovery.provider,
        requestHash: discovery.requestHash,
        responseHashes: discovery.responseHashes,
        inspectedMarkets: discovery.markets.map(serializeDiscoveredMarket),
        selectedCandidateId: comparison.selectedCandidateId,
        evaluations: comparison.evaluations,
      },
      transport: {
        providerCatalog: 'NEAR_INTENTS_1CLICK',
        catalogResponseHash: catalog.responseHash,
        assets: transportAssets.map(({ assetId, contractAddress, decimals }) => ({
          assetId,
          contractAddress,
          decimals,
        })),
        executionBoundary: 'SIMULATED_1CLICK_BOUNDARY',
        inputCollateralUnits: parseEther('10').toString(),
        deliveredCollateralUnits: minimumDestinationCollateral.toString(),
      },
      source: {
        before: sourcePosition,
        after: null,
        actualRepaidUnits: actualReceivable.toString(),
      },
      destination: {
        marketId: selectedMarket.marketId,
        collateralUnits: targetPosition.collateralUnits,
        debtUnits: targetPosition.debtUnits,
        ltvBps: targetPosition.ltvBps,
      },
      reconciliation: {
        sourceVaultSettled: true,
        destinationResidualBalances: residualBalances.map((value) => value.toString()),
      },
      localForkTransactions: transactions,
      warning:
        'These hashes exist only inside disposable local forks and are not public mainnet explorer receipts.',
    });
  }, 300_000);
});

function requiredBaseForkRpcUrl(): string {
  if (baseForkRpcUrl === undefined) throw new Error('BASE_FORK_RPC_URL is required.');
  return baseForkRpcUrl;
}

function requiredArbitrumForkRpcUrl(): string {
  if (arbitrumForkRpcUrl === undefined) throw new Error('ARBITRUM_FORK_RPC_URL is required.');
  return arbitrumForkRpcUrl;
}

function assertIndexedMarket(
  indexed: DiscoveredMorphoMarket,
  params: {
    readonly loanToken: Address;
    readonly collateralToken: Address;
    readonly oracle: Address;
    readonly irm: Address;
    readonly lltv: bigint;
  },
): void {
  expect(params.loanToken).toBe(indexed.loanToken);
  expect(params.collateralToken).toBe(indexed.collateralToken);
  expect(params.oracle).toBe(indexed.oracle);
  expect(params.irm).toBe(indexed.irm);
  expect(params.lltv.toString()).toBe(indexed.lltvWad);
}

async function deploy(
  wallet: WalletClient,
  publicClient: PublicClient,
  artifact: FoundryArtifact,
  args: readonly unknown[],
): Promise<Address> {
  const account = wallet.account;
  if (account === undefined) throw new Error('A fork deployment requires an account.');
  const hash = await wallet.deployContract({
    account,
    chain: wallet.chain,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || receipt.contractAddress == null) {
    throw new Error(`Fork deployment ${hash} failed.`);
  }
  return getAddress(receipt.contractAddress);
}

async function write(
  wallet: WalletClient,
  publicClient: PublicClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  value = 0n,
): Promise<Hex> {
  const account = wallet.account;
  if (account === undefined) throw new Error('A fork transaction requires an account.');
  const data = encodeFunctionData({ abi, functionName, args });
  const accountAddress = typeof account === 'string' ? account : account.address;
  await publicClient.call({ account: accountAddress, to: address, data, value });
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: address,
    data,
    value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(
      `Fork ${functionName} transaction ${hash} reverted after using ${receipt.gasUsed} gas.`,
    );
  }
  return hash;
}

async function sendPrepared(
  wallet: WalletClient,
  publicClient: PublicClient,
  transaction: { readonly to: Address; readonly data: Hex; readonly value: 0n },
): Promise<Hex> {
  const account = wallet.account;
  if (account === undefined) throw new Error('A fork transaction requires an account.');
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Fork transaction ${hash} reverted.`);
  return hash;
}

function serializeDiscoveredMarket(market: DiscoveredMorphoMarket) {
  return {
    chainId: market.chainId,
    marketId: market.marketId,
    loanToken: market.loanToken,
    collateralToken: market.collateralToken,
    oracle: market.oracle,
    irm: market.irm,
    lltvWad: market.lltvWad,
    creationBlockNumber: market.creationBlockNumber,
  };
}

async function writeProofReport(report: unknown): Promise<void> {
  const configuredPath = process.env.MAINNET_FORK_PROOF_REPORT_PATH;
  if (configuredPath === undefined || configuredPath.trim().length === 0) return;
  const path = resolve(configuredPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

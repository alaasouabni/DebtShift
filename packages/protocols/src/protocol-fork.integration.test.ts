import {
  encodeAbiParameters,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeMigrationId, executionPlanTypes } from '@debtshift/domain';

import {
  AaveV3ReadAdapter,
  buildAaveCollateralClaimAuthorization,
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

/**
 * Immutable Base mainnet fork evidence. These values are test fixtures, not
 * production defaults. Runtime deployments must supply the validated live
 * market registry instead.
 *
 * Address provenance:
 * - Aave address book: src/AaveV3Base.sol
 * - Morpho address registry and public market API
 * - Chainlink Base feed registry
 */
const BASE_CHAIN_ID = 8453;
const PINNED_BASE_BLOCK = 55_600_000n;
const PINNED_BASE_BLOCK_HASH =
  '0xc22ea6ebea74eb93bf081cee853c017b276a6264012407e56e01c0233467f542' as const;
const AAVE_POOL = getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
const AAVE_DATA_PROVIDER = getAddress('0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A');
const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
const WETH = getAddress('0x4200000000000000000000000000000000000006');
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const WETH_USDC_MARKET =
  '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda' as const;
const MORPHO_ORACLE = getAddress('0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4');
const ETH_USD_FEED = getAddress('0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70');
const USDC_USD_FEED = getAddress('0x7e860098F58bBFC8648a4311b374B1D669a2bc6B');
const BASE_SEQUENCER_FEED = getAddress('0xBCF85224fc0756B9Fa45aA7892530B47e10b6433');

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

const forkRpcUrl = process.env.BASE_FORK_RPC_URL;
const runForkTests = forkRpcUrl === undefined ? describe.skip : describe;

runForkTests('pinned Aave V3 and Morpho Blue Base fork', () => {
  // A fixed test-only key derived from the pinned block hash avoids well-known Anvil addresses that
  // may already contain contract bytecode in mainnet state and therefore trigger EIP-1271 routing.
  const borrower = privateKeyToAccount(PINNED_BASE_BLOCK_HASH);
  let fork: LocalAnvilChain;
  let wallet: WalletClient;
  let publicClient: PublicClient;

  beforeAll(async () => {
    fork = await startAnvil({
      chainId: BASE_CHAIN_ID,
      port: 19_575,
      forkUrl: requiredForkRpcUrl(),
      forkBlockNumber: PINNED_BASE_BLOCK,
    });
    publicClient = fork.publicClient;
    wallet = createWalletClient({
      account: borrower,
      chain: fork.chain,
      transport: http(fork.rpcUrl),
    });
    const testClient = createTestClient({
      chain: fork.chain,
      mode: 'anvil',
      transport: http(fork.rpcUrl),
    });
    await testClient.setBalance({ address: borrower.address, value: parseEther('100') });
  }, 60_000);

  afterAll(async () => fork?.stop(), 10_000);

  it('opens, observes, and closes Aave before opening and observing Morpho', async () => {
    const pinnedBlock = await publicClient.getBlock({ blockNumber: PINNED_BASE_BLOCK });
    expect(pinnedBlock.hash).toBe(PINNED_BASE_BLOCK_HASH);
    expect((await publicClient.getCode({ address: borrower.address })) ?? '0x').toBe('0x');

    await write(wallet, publicClient, WETH, WETH_ABI, 'deposit', [], parseEther('10'));
    await write(wallet, publicClient, WETH, ERC20_METADATA_ABI, 'approve', [
      AAVE_POOL,
      parseEther('10'),
    ]);
    await write(wallet, publicClient, AAVE_POOL, AAVE_POSITION_ABI, 'supply', [
      WETH,
      parseEther('10'),
      borrower.address,
      0,
    ]);
    await write(wallet, publicClient, AAVE_POOL, AAVE_POSITION_ABI, 'borrow', [
      USDC,
      1_000n * 10n ** 6n,
      2n,
      0,
      borrower.address,
    ]);

    const aave = new AaveV3ReadAdapter(publicClient, {
      chainId: BASE_CHAIN_ID,
      pool: AAVE_POOL,
      dataProvider: AAVE_DATA_PROVIDER,
      collateralAsset: { chainId: BASE_CHAIN_ID, address: WETH, decimals: 18, symbol: 'WETH' },
      debtAsset: { chainId: BASE_CHAIN_ID, address: USDC, decimals: 6, symbol: 'USDC' },
    });
    const initialAavePosition = await aave.readPosition(borrower.address);
    expect(initialAavePosition).toBeDefined();
    expect(BigInt(initialAavePosition?.collateralUnits ?? 0n)).toBeGreaterThanOrEqual(
      parseEther('10'),
    );
    expect(BigInt(initialAavePosition?.debtUnits ?? 0n)).toBeGreaterThanOrEqual(1_000n * 10n ** 6n);

    const testClient = createTestClient({
      chain: fork.chain,
      mode: 'anvil',
      transport: http(fork.rpcUrl),
    });
    await testClient.increaseTime({ seconds: 3_600 });
    await testClient.mine({ blocks: 1 });

    // A bounded buffer from existing fork liquidity covers accrued interest.
    // Impersonation and balance mutation exist only inside this disposable fork.
    await testClient.setBalance({ address: MORPHO, value: parseEther('1') });
    await testClient.impersonateAccount({ address: MORPHO });
    const morphoLiquidityWallet = createWalletClient({
      account: MORPHO,
      chain: fork.chain,
      transport: http(fork.rpcUrl),
    });
    await write(morphoLiquidityWallet, publicClient, USDC, ERC20_TRANSFER_ABI, 'transfer', [
      borrower.address,
      1_100n * 10n ** 6n,
    ]);
    await testClient.stopImpersonatingAccount({ address: MORPHO });

    const accruedAavePosition = await aave.readPosition(borrower.address);
    const accruedDebtUnits = BigInt(accruedAavePosition?.debtUnits ?? 0n);
    expect(accruedDebtUnits).toBeGreaterThan(BigInt(initialAavePosition?.debtUnits ?? 0n));
    const maximumRepayUnits = accruedDebtUnits + 1n * 10n ** 6n;

    const freshness = new ChainlinkOracleFreshnessReader(publicClient, {
      morphoOracle: MORPHO_ORACLE,
      feeds: [
        { address: ETH_USD_FEED, maximumAgeSeconds: 90_000 },
        { address: USDC_USD_FEED, maximumAgeSeconds: 90_000 },
      ],
      sequencerUptimeFeed: { address: BASE_SEQUENCER_FEED, recoveryGraceSeconds: 3_600 },
    });
    const morpho = new MorphoBlueReadAdapter(
      publicClient,
      { chainId: BASE_CHAIN_ID, morpho: MORPHO },
      freshness,
    );
    const market = await morpho.readMarket(WETH_USDC_MARKET, maximumRepayUnits);
    expect(market.params.loanToken).toBe(USDC);
    expect(market.params.collateralToken).toBe(WETH);
    expect(market.params.oracle).toBe(MORPHO_ORACLE);
    expect(BigInt(market.availableBorrowUnits)).toBeGreaterThan(maximumRepayUnits);

    const [collateralReserveTokens, debtReserveTokens] = await Promise.all([
      readAaveReserveTokenAddresses(publicClient, AAVE_DATA_PROVIDER, WETH),
      readAaveReserveTokenAddresses(publicClient, AAVE_DATA_PROVIDER, USDC),
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
    const vault = await deploy(wallet, publicClient, vaultArtifact, [borrower.address]);
    const sourceEscrow = await deploy(wallet, publicClient, escrowArtifact, [borrower.address]);
    const aaveSource = await deploy(wallet, publicClient, aaveSourceArtifact, [
      borrower.address,
      AAVE_POOL,
      collateralReserveTokens.aToken,
      debtReserveTokens.variableDebtToken,
      WETH,
      USDC,
    ]);
    const sourceAdapter = await deploy(wallet, publicClient, sourceAdapterArtifact, [
      borrower.address,
      vault,
      aaveSource,
      sourceEscrow,
    ]);
    const destinationEscrow = await deploy(wallet, publicClient, escrowArtifact, [
      borrower.address,
    ]);
    const morphoTarget = await deploy(wallet, publicClient, morphoTargetArtifact, [
      borrower.address,
      MORPHO,
      market.params,
    ]);
    const destinationAdapter = await deploy(wallet, publicClient, destinationAdapterArtifact, [
      borrower.address,
      morphoTarget,
      destinationEscrow,
    ]);
    await write(wallet, publicClient, aaveSource, aaveSourceArtifact.abi, 'setSourceAdapter', [
      sourceAdapter,
    ]);
    await write(
      wallet,
      publicClient,
      morphoTarget,
      morphoTargetArtifact.abi,
      'setDestinationAdapter',
      [destinationAdapter],
    );
    await write(wallet, publicClient, vault, vaultArtifact.abi, 'setAsset', [USDC, true]);
    await write(wallet, publicClient, vault, vaultArtifact.abi, 'setAdapter', [
      sourceAdapter,
      true,
    ]);
    await write(wallet, publicClient, sourceEscrow, escrowArtifact.abi, 'setDepositor', [
      sourceAdapter,
      true,
    ]);
    await write(wallet, publicClient, destinationEscrow, escrowArtifact.abi, 'setOperator', [
      destinationAdapter,
      true,
    ]);
    await write(
      wallet,
      publicClient,
      destinationAdapter,
      destinationAdapterArtifact.abi,
      'setPlanDomain',
      [BASE_CHAIN_ID, sourceAdapter, true],
    );
    await write(wallet, publicClient, USDC, ERC20_METADATA_ABI, 'approve', [
      vault,
      maximumRepayUnits,
    ]);
    await write(wallet, publicClient, vault, vaultArtifact.abi, 'deposit', [
      USDC,
      maximumRepayUnits,
    ]);

    const latestBlock = await publicClient.getBlock({ blockTag: 'latest' });
    const deadline = latestBlock.timestamp + 1_800n;
    const nonce = 1n;
    const intentHash = keccak256(stringToHex('debtshift.base-fork-aave-intent.v1'));
    const transportQuoteHash = keccak256(stringToHex('debtshift.base-fork-quote.v1'));
    const migrationId = computeMigrationId(intentHash, transportQuoteHash, nonce);
    const plan = {
      intentHash,
      migrationId,
      borrower: borrower.address,
      sourcePositionId: keccak256(stringToHex('debtshift.base-fork-position.v1')),
      routeHash: keccak256(stringToHex('debtshift.base-fork-route.v1')),
      transportQuoteHash,
      sourceRepaymentMax: maximumRepayUnits,
      sourceCollateralMin: parseEther('10'),
      targetDebtMax: maximumRepayUnits,
      minDestinationCollateral: parseEther('10'),
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
    const contractPlanHash = await publicClient.readContract({
      address: sourceAdapter,
      abi: sourceAdapterArtifact.abi,
      functionName: 'executionPlanHash',
      args: [plan],
    });
    expect(contractPlanHash).toBe(planHash);
    const analysisHash = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, uint256'), [planHash, accruedDebtUnits]),
    );
    const feasibility = {
      planHash,
      analysisHash,
      externalFundingEvidenceHash: `0x${'00'.repeat(32)}`,
      liquidityAsset: USDC,
      solverPrincipalUnits: maximumRepayUnits,
      solverFeeUnits: 0n,
      capitalizedCostUnits: 0n,
      totalRequiredUnits: maximumRepayUnits,
      confirmedExternalFundingUnits: 0n,
      maximumSafeBorrowingCapacityUnits: maximumRepayUnits,
      requiredDestinationBorrowUnits: maximumRepayUnits,
      fundingShortfallUnits: 0n,
      sequence: 1n,
      evaluatedAt: latestBlock.timestamp,
      validUntil: deadline,
    } as const;
    await write(wallet, publicClient, vault, vaultArtifact.abi, 'recordFeasibility', [
      migrationId,
      feasibility,
    ]);
    const feasibilityHash = await publicClient.readContract({
      address: vault,
      abi: vaultArtifact.abi,
      functionName: 'latestFeasibilityHash',
      args: [migrationId],
    });
    await write(wallet, publicClient, USDC, ERC20_METADATA_ABI, 'approve', [
      vault,
      maximumRepayUnits,
    ]);
    await write(wallet, publicClient, vault, vaultArtifact.abi, 'reserve', [
      migrationId,
      USDC,
      sourceAdapter,
      planHash,
      feasibilityHash,
      maximumRepayUnits,
      0n,
      deadline,
    ]);

    const collateralAuthorization = buildAaveCollateralClaimAuthorization(
      collateralReserveTokens.aToken,
      aaveSource,
      parseEther('10'),
    );
    await sendPrepared(wallet, publicClient, collateralAuthorization);
    await write(wallet, publicClient, sourceAdapter, sourceAdapterArtifact.abi, 'closeSource', [
      plan,
      signature,
    ]);

    expect(await aave.readPosition(borrower.address)).toBeUndefined();
    const [escrowCollateral, reservation, moduleATokens, moduleDebtAsset] = await Promise.all([
      publicClient.readContract({
        address: sourceEscrow,
        abi: escrowArtifact.abi,
        functionName: 'balances',
        args: [migrationId, WETH],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultArtifact.abi,
        functionName: 'reservations',
        args: [migrationId],
      }),
      publicClient.readContract({
        address: collateralReserveTokens.aToken,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [aaveSource],
      }),
      publicClient.readContract({
        address: USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [aaveSource],
      }),
    ]);
    expect(escrowCollateral).toBe(parseEther('10'));
    expect(Array.isArray(reservation) ? reservation[6] : undefined).toBe(2);
    const actualReceivable = Array.isArray(reservation) ? reservation[8] : undefined;
    expect(actualReceivable).toBeTypeOf('bigint');
    if (typeof actualReceivable !== 'bigint') throw new Error('Expected a vault receivable.');
    expect(actualReceivable).toBeGreaterThan(accruedDebtUnits);
    expect(actualReceivable).toBeLessThanOrEqual(maximumRepayUnits);
    expect(moduleATokens).toBe(0n);
    expect(moduleDebtAsset).toBe(0n);

    const postSourceBlock = await publicClient.getBlock({ blockTag: 'latest' });
    const postSourceFeasibility = {
      ...feasibility,
      solverPrincipalUnits: actualReceivable,
      totalRequiredUnits: actualReceivable,
      requiredDestinationBorrowUnits: actualReceivable,
      sequence: 2n,
      evaluatedAt: postSourceBlock.timestamp,
    } as const;
    await write(wallet, publicClient, vault, vaultArtifact.abi, 'recordFeasibility', [
      migrationId,
      postSourceFeasibility,
    ]);

    // This single-chain fixture stands in for transport by moving the exact isolated collateral
    // between independent source and destination escrows before the destination adapter can use it.
    await write(wallet, publicClient, sourceEscrow, escrowArtifact.abi, 'release', [
      migrationId,
      WETH,
      borrower.address,
      parseEther('10'),
    ]);
    await write(wallet, publicClient, WETH, ERC20_METADATA_ABI, 'approve', [
      destinationEscrow,
      parseEther('10'),
    ]);
    await write(wallet, publicClient, destinationEscrow, escrowArtifact.abi, 'assign', [
      migrationId,
      WETH,
      borrower.address,
      parseEther('10'),
    ]);

    const destinationFeasibility = {
      planHash,
      analysisHash,
      externalFundingEvidenceHash: `0x${'00'.repeat(32)}`,
      settlementAsset: USDC,
      solverPrincipalUnits: actualReceivable,
      solverFeeUnits: 0n,
      capitalizedCostUnits: 0n,
      totalRequiredUnits: actualReceivable,
      confirmedExternalFundingUnits: 0n,
      maximumSafeBorrowingCapacityUnits: maximumRepayUnits,
      requiredDestinationBorrowUnits: actualReceivable,
      fundingShortfallUnits: 0n,
      sequence: 1n,
      evaluatedAt: postSourceBlock.timestamp,
      validUntil: deadline,
    } as const;
    await write(
      wallet,
      publicClient,
      destinationAdapter,
      destinationAdapterArtifact.abi,
      'recordFeasibility',
      [migrationId, destinationFeasibility],
    );
    const destinationFeasibilityHash = await publicClient.readContract({
      address: destinationAdapter,
      abi: destinationAdapterArtifact.abi,
      functionName: 'latestFeasibilityHash',
      args: [migrationId],
    });
    const morphoNonce = await publicClient.readContract({
      address: MORPHO,
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
        morphoAuthorizationTypedData(BASE_CHAIN_ID, MORPHO, authorizationPair.enable),
      ),
      borrower.signTypedData(
        morphoAuthorizationTypedData(BASE_CHAIN_ID, MORPHO, authorizationPair.disable),
      ),
    ]);
    const lendingAuthorization = encodeMorphoAuthorizationPair(
      authorizationPair,
      enableSignature,
      disableSignature,
    );
    const payoutBalanceBefore = await publicClient.readContract({
      address: USDC,
      abi: WETH_ABI,
      functionName: 'balanceOf',
      args: [borrower.address],
    });
    const openTerms = {
      sourceChainId: BigInt(BASE_CHAIN_ID),
      sourceAdapter,
      collateralUnits: parseEther('10'),
      borrowUnits: actualReceivable,
      feasibilityHash: destinationFeasibilityHash,
      fundingEvidenceHash: `0x${'00'.repeat(32)}`,
      solverPrincipalUnits: actualReceivable,
      solverFeeUnits: 0n,
      capitalizedCostUnits: 0n,
      capitalizedCostReceiver: '0x0000000000000000000000000000000000000000',
      lendingAuthorization,
    } as const;
    await write(
      wallet,
      publicClient,
      destinationAdapter,
      destinationAdapterArtifact.abi,
      'openDestination',
      [plan, signature, openTerms],
    );

    const targetPosition = await morpho.readPosition(WETH_USDC_MARKET, borrower.address);
    expect(BigInt(targetPosition.collateralUnits)).toBe(parseEther('10'));
    expect(BigInt(targetPosition.debtUnits)).toBeGreaterThanOrEqual(actualReceivable);
    expect(targetPosition.ltvBps).toBeLessThan(targetPosition.market.snapshot.lltvBps ?? 0);
    expect(
      await publicClient.readContract({
        address: MORPHO,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'isAuthorized',
        args: [borrower.address, morphoTarget],
      }),
    ).toBe(false);
    expect(
      await publicClient.readContract({
        address: MORPHO,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'nonce',
        args: [borrower.address],
      }),
    ).toBe(morphoNonce + 2n);
    expect(
      await publicClient.readContract({
        address: USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [borrower.address],
      }),
    ).toBe(payoutBalanceBefore + actualReceivable);

    const residualBalances = await Promise.all([
      publicClient.readContract({
        address: WETH,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [morphoTarget],
      }),
      publicClient.readContract({
        address: USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [morphoTarget],
      }),
      publicClient.readContract({
        address: WETH,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationAdapter],
      }),
      publicClient.readContract({
        address: USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationAdapter],
      }),
      publicClient.readContract({
        address: WETH,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationEscrow],
      }),
      publicClient.readContract({
        address: USDC,
        abi: WETH_ABI,
        functionName: 'balanceOf',
        args: [destinationEscrow],
      }),
    ]);
    expect(residualBalances).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);

    await write(wallet, publicClient, vault, vaultArtifact.abi, 'settle', [
      migrationId,
      borrower.address,
      0n,
    ]);
    const settledReservation = await publicClient.readContract({
      address: vault,
      abi: vaultArtifact.abi,
      functionName: 'reservations',
      args: [migrationId],
    });
    expect(Array.isArray(settledReservation) ? settledReservation[6] : undefined).toBe(3);
  }, 120_000);
});

function requiredForkRpcUrl(): string {
  if (forkRpcUrl === undefined) throw new Error('BASE_FORK_RPC_URL is required for fork tests.');
  return forkRpcUrl;
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
): Promise<void> {
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
}

async function sendPrepared(
  wallet: WalletClient,
  publicClient: PublicClient,
  transaction: { readonly to: Address; readonly data: Hex; readonly value: 0n } | undefined,
): Promise<void> {
  if (transaction === undefined) throw new Error('Expected a prepared fork transaction.');
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
}

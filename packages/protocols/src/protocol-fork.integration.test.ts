import {
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  maxUint256,
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
  AAVE_POOL_WRITE_ABI,
  AaveV3ReadAdapter,
  buildAaveBorrowerCloseTransactions,
  ERC20_METADATA_ABI,
} from './aave-v3.js';
import { ChainlinkOracleFreshnessReader } from './chainlink-oracle.js';
import { type LocalAnvilChain, startAnvil } from './local-chain.js';
import { DEFAULT_ANVIL_BORROWER_KEY } from './local-deployment.js';
import { buildMorphoOpenPositionTransactions, MorphoBlueReadAdapter } from './morpho-blue.js';

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
  const borrower = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
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
  }, 60_000);

  afterAll(async () => fork?.stop(), 10_000);

  it('opens, observes, and closes Aave before opening and observing Morpho', async () => {
    const pinnedBlock = await publicClient.getBlock({ blockNumber: PINNED_BASE_BLOCK });
    expect(pinnedBlock.hash).toBe(PINNED_BASE_BLOCK_HASH);

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
      100n * 10n ** 6n,
    ]);
    await testClient.stopImpersonatingAccount({ address: MORPHO });

    const exactClose = buildAaveBorrowerCloseTransactions(
      {
        pool: AAVE_POOL,
        collateralAsset: { chainId: BASE_CHAIN_ID, address: WETH, decimals: 18 },
        debtAsset: { chainId: BASE_CHAIN_ID, address: USDC, decimals: 6 },
      },
      {
        borrower: borrower.address,
        debtUnits: BigInt(initialAavePosition?.debtUnits ?? 0n),
        collateralUnits: parseEther('10'),
        collateralReceiver: borrower.address,
      },
    );
    await sendPrepared(wallet, publicClient, exactClose[0]);
    await sendPrepared(wallet, publicClient, exactClose[1]);
    const accruedResidual = await aave.readPosition(borrower.address);
    expect(BigInt(accruedResidual?.debtUnits ?? 0n)).toBeGreaterThan(0n);
    expect(BigInt(accruedResidual?.debtUnits ?? 0n)).toBeLessThan(
      BigInt(initialAavePosition?.debtUnits ?? 0n),
    );

    const boundedMaximumRepay = BigInt(accruedResidual?.debtUnits ?? 0n) + 1n * 10n ** 6n;
    await write(wallet, publicClient, USDC, ERC20_METADATA_ABI, 'approve', [
      AAVE_POOL,
      boundedMaximumRepay,
    ]);
    await write(wallet, publicClient, AAVE_POOL, AAVE_POOL_WRITE_ABI, 'repay', [
      USDC,
      boundedMaximumRepay,
      2n,
      borrower.address,
    ]);
    await write(wallet, publicClient, AAVE_POOL, AAVE_POOL_WRITE_ABI, 'withdraw', [
      WETH,
      maxUint256,
      borrower.address,
    ]);
    expect(await aave.readPosition(borrower.address)).toBeUndefined();

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
    const market = await morpho.readMarket(WETH_USDC_MARKET, 1_000n * 10n ** 6n);
    expect(market.params.loanToken).toBe(USDC);
    expect(market.params.collateralToken).toBe(WETH);
    expect(market.params.oracle).toBe(MORPHO_ORACLE);
    expect(BigInt(market.availableBorrowUnits)).toBeGreaterThan(1_000n * 10n ** 6n);

    const target = buildMorphoOpenPositionTransactions(MORPHO, market.params, {
      caller: borrower.address,
      borrower: borrower.address,
      debtReceiver: borrower.address,
      collateralUnits: parseEther('5'),
      borrowUnits: 1_000n * 10n ** 6n,
    });
    expect(target.requiresMorphoAuthorization).toBe(false);
    for (const transaction of target.transactions) {
      await sendPrepared(wallet, publicClient, transaction);
    }

    const targetPosition = await morpho.readPosition(WETH_USDC_MARKET, borrower.address);
    expect(BigInt(targetPosition.collateralUnits)).toBe(parseEther('5'));
    expect(BigInt(targetPosition.debtUnits)).toBeGreaterThanOrEqual(1_000n * 10n ** 6n);
    expect(targetPosition.ltvBps).toBeLessThan(targetPosition.market.snapshot.lltvBps ?? 0);
  }, 120_000);
});

function requiredForkRpcUrl(): string {
  if (forkRpcUrl === undefined) throw new Error('BASE_FORK_RPC_URL is required for fork tests.');
  return forkRpcUrl;
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

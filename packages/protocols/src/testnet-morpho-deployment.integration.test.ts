import {
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadFoundryArtifact,
  loadMorphoTestnetArtifact,
  type FoundryArtifact,
} from './artifacts.js';
import { startAnvil, type LocalAnvilChain } from './local-chain.js';
import { DEFAULT_ANVIL_BORROWER_KEY, DEFAULT_ANVIL_DEPLOYER_KEY } from './local-deployment.js';
import {
  deployTestnetMorphoMarket,
  verifyTestnetMorphoDeployment,
} from './testnet-morpho-deployment.js';

const runDeploymentTests =
  process.env.RUN_EVM_DEPLOYMENT_TESTS === 'true' ? describe : describe.skip;

type TestWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

runDeploymentTests('canonical testnet Morpho deployment and attestation', () => {
  const deployer = privateKeyToAccount(DEFAULT_ANVIL_DEPLOYER_KEY);
  const owner = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
  let local: LocalAnvilChain;
  let wallet: TestWallet;
  let tokenArtifact: FoundryArtifact;
  let feedArtifact: FoundryArtifact;
  let collateralToken: Address;
  let loanToken: Address;
  let collateralFeed: Address;
  let loanFeed: Address;
  let manifest: Awaited<ReturnType<typeof deployTestnetMorphoMarket>>;

  beforeAll(async () => {
    local = await startAnvil({ chainId: 84_532, port: 19_587 });
    wallet = createWalletClient({
      account: deployer,
      chain: local.chain,
      transport: http(local.rpcUrl),
    });
    [tokenArtifact, feedArtifact] = await Promise.all([
      loadFoundryArtifact('TestToken'),
      loadMorphoTestnetArtifact('MutableFeed'),
    ]);
    collateralToken = await deploy(wallet, local.publicClient, tokenArtifact, [
      'Testnet Ether',
      'tWETH',
      18,
      deployer.address,
    ]);
    loanToken = await deploy(wallet, local.publicClient, tokenArtifact, [
      'Testnet USD',
      'tUSDC',
      6,
      deployer.address,
    ]);
    collateralFeed = await deploy(wallet, local.publicClient, feedArtifact, [8, 2_000e8]);
    loanFeed = await deploy(wallet, local.publicClient, feedArtifact, [8, 1e8]);
    await write(wallet, local.publicClient, tokenArtifact, loanToken, 'mint', [
      deployer.address,
      100_000_000n,
    ]);

    manifest = await deployTestnetMorphoMarket({
      sourceCommit: '1'.repeat(40),
      routeId: 'ethereum-sepolia-to-base-sepolia-v1',
      routeDependenciesHash: `0x${'ab'.repeat(32)}`,
      publicClient: local.publicClient,
      wallet,
      chainId: local.chain.id,
      confirmations: 1,
      owner: owner.address,
      collateralToken,
      loanToken,
      collateralFeed,
      loanFeed,
      collateralMaxPriceAgeSeconds: 3_600n,
      loanMaxPriceAgeSeconds: 90_000n,
      sequencerGracePeriodSeconds: 0n,
      lltv: 860_000_000_000_000_000n,
      seedLiquidityOwner: owner.address,
      seedLiquidityAssets: 50_000_000n,
      createdAt: '2026-11-13T14:00:00.000Z',
    });
  }, 120_000);

  afterAll(async () => {
    await local?.stop();
  });

  it('proves canonical source, exact deployment inputs, market configuration, and real liquidity', async () => {
    const report = await verifyTestnetMorphoDeployment({
      manifest,
      publicClient: local.publicClient,
      minimumAvailableLiquidityUnits: 50_000_000n,
      expectedRouteId: 'ethereum-sepolia-to-base-sepolia-v1',
      expectedRouteDependenciesHash: `0x${'ab'.repeat(32)}`,
    });

    expect(manifest.upstream.commit).toBe('339a885801972740eb27f51da110a4675b839d42');
    expect(manifest.configurationTransactions.length).toBeGreaterThanOrEqual(7);
    expect(report.owner).toBe(getAddress(owner.address));
    expect(report.availableLiquidityUnits).toBe('50000000');
    expect(BigInt(report.oraclePrice)).toBe(2_000n * 10n ** 24n);
    expect(report.workflowWriteSwitchEnabled).toBe(false);
  });

  it('fails closed when the reviewed route dependency binding differs', async () => {
    await expect(
      verifyTestnetMorphoDeployment({
        manifest,
        publicClient: local.publicClient,
        expectedRouteDependenciesHash: `0x${'cd'.repeat(32)}`,
      }),
    ).rejects.toThrow('route dependency binding does not match');
  });

  it('fails closed when canonical deployment input provenance is changed', async () => {
    const tampered = {
      ...manifest,
      contracts: {
        ...manifest.contracts,
        morpho: {
          ...manifest.contracts.morpho,
          deploymentTransactionInputHash: `0x${'ff'.repeat(32)}` as Hex,
        },
      },
    };
    await expect(
      verifyTestnetMorphoDeployment({
        manifest: tampered,
        publicClient: local.publicClient,
      }),
    ).rejects.toThrow('deployment provenance mismatch');
  });

  it('fails closed when a canonical configuration action is relabeled', async () => {
    const [first, ...rest] = manifest.configurationTransactions;
    const tampered = {
      ...manifest,
      configurationTransactions: [
        { ...first!, action: 'unrelated successful transaction' },
        ...rest,
      ],
    };
    await expect(
      verifyTestnetMorphoDeployment({
        manifest: tampered,
        publicClient: local.publicClient,
      }),
    ).rejects.toThrow('transaction provenance mismatch');
  });

  it('rejects a stale public feed before broadcasting a deployment transaction', async () => {
    await write(wallet, local.publicClient, feedArtifact, collateralFeed, 'setRound', [
      2_000e8,
      1n,
      1n,
    ]);
    const nonceBefore = await local.publicClient.getTransactionCount({ address: deployer.address });

    await expect(
      deployTestnetMorphoMarket({
        sourceCommit: '1'.repeat(40),
        routeId: 'ethereum-sepolia-to-base-sepolia-v1',
        routeDependenciesHash: `0x${'ab'.repeat(32)}`,
        publicClient: local.publicClient,
        wallet,
        chainId: local.chain.id,
        confirmations: 1,
        owner: owner.address,
        collateralToken,
        loanToken,
        collateralFeed,
        loanFeed,
        collateralMaxPriceAgeSeconds: 60n,
        loanMaxPriceAgeSeconds: 90_000n,
        sequencerGracePeriodSeconds: 0n,
        lltv: 860_000_000_000_000_000n,
        seedLiquidityOwner: owner.address,
        seedLiquidityAssets: 1n,
      }),
    ).rejects.toThrow('collateral feed is stale before deployment');
    expect(await local.publicClient.getTransactionCount({ address: deployer.address })).toBe(
      nonceBefore,
    );
  });
});

async function deploy(
  wallet: TestWallet,
  client: PublicClient,
  artifact: FoundryArtifact,
  args: readonly unknown[],
): Promise<Address> {
  const hash = await wallet.deployContract({
    account: wallet.account,
    chain: wallet.chain,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (
    receipt.status !== 'success' ||
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error(`Test dependency deployment reverted: ${hash}`);
  }
  return getAddress(receipt.contractAddress);
}

async function write(
  wallet: TestWallet,
  client: PublicClient,
  artifact: FoundryArtifact,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const simulation = await client.simulateContract({
    account: wallet.account,
    address,
    abi: artifact.abi,
    functionName,
    args,
  });
  const hash = await wallet.writeContract(simulation.request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
}

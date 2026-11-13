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

import { loadFoundryArtifact, type FoundryArtifact } from './artifacts.js';
import { startAnvil, type LocalAnvilChain } from './local-chain.js';
import { DEFAULT_ANVIL_BORROWER_KEY, DEFAULT_ANVIL_DEPLOYER_KEY } from './local-deployment.js';
import { morphoMarketId, type MorphoMarketParams } from './morpho-blue.js';
import {
  deployProductionDebtShift,
  verifyProductionDebtShiftDeployment,
} from './production-deployment.js';

const runDeploymentTests =
  process.env.RUN_EVM_DEPLOYMENT_TESTS === 'true' ? describe : describe.skip;

type TestWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

runDeploymentTests('production deployment manifest and read-only verification', () => {
  const owner = privateKeyToAccount(DEFAULT_ANVIL_DEPLOYER_KEY);
  const executor = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
  let source: LocalAnvilChain;
  let destination: LocalAnvilChain;
  let manifest: Awaited<ReturnType<typeof deployProductionDebtShift>>;

  beforeAll(async () => {
    source = await startAnvil({ chainId: 31_337, port: 19_585 });
    destination = await startAnvil({ chainId: 31_338, port: 19_586 });
    const sourceWallet = createWalletClient({
      account: owner,
      chain: source.chain,
      transport: http(source.rpcUrl),
    });
    const destinationWallet = createWalletClient({
      account: owner,
      chain: destination.chain,
      transport: http(destination.rpcUrl),
    });
    const [testToken, mockPool, dataProvider, mockMorpho] = await Promise.all([
      loadFoundryArtifact('TestToken'),
      loadFoundryArtifact('MockAaveV3Pool'),
      loadFoundryArtifact('MockAaveV3ProtocolDataProvider'),
      loadFoundryArtifact('MockMorphoBlue'),
    ]);
    const sourceDebt = await deploy(sourceWallet, source.publicClient, testToken, [
      'Source USD',
      'sUSDC',
      6,
      owner.address,
    ]);
    const sourceCollateral = await deploy(sourceWallet, source.publicClient, testToken, [
      'Source Ether',
      'sWETH',
      18,
      owner.address,
    ]);
    const aToken = await deploy(sourceWallet, source.publicClient, testToken, [
      'Aave Ether',
      'aWETH',
      18,
      owner.address,
    ]);
    const pool = await deploy(sourceWallet, source.publicClient, mockPool, [
      sourceCollateral,
      sourceDebt,
      aToken,
    ]);
    const provider = await deploy(sourceWallet, source.publicClient, dataProvider, [
      sourceCollateral,
      aToken,
      pool,
    ]);

    const destinationDebt = await deploy(destinationWallet, destination.publicClient, testToken, [
      'Destination USD',
      'dUSDC',
      6,
      owner.address,
    ]);
    const destinationCollateral = await deploy(
      destinationWallet,
      destination.publicClient,
      testToken,
      ['Destination Ether', 'dWETH', 18, owner.address],
    );
    const oracle = await deploy(destinationWallet, destination.publicClient, testToken, [
      'Oracle marker',
      'ORACLE',
      18,
      owner.address,
    ]);
    const irm = await deploy(destinationWallet, destination.publicClient, testToken, [
      'IRM marker',
      'IRM',
      18,
      owner.address,
    ]);
    const marketParams: MorphoMarketParams = {
      loanToken: destinationDebt,
      collateralToken: destinationCollateral,
      oracle,
      irm,
      lltv: 860_000_000_000_000_000n,
    };
    const morpho = await deploy(destinationWallet, destination.publicClient, mockMorpho, [
      marketParams,
    ]);
    manifest = await deployProductionDebtShift({
      environment: 'testnet',
      routeId: 'integration-aave-to-morpho-v1',
      routeConfigurationHash: `0x${'11'.repeat(32)}`,
      sourceCommit: '1'.repeat(40),
      owner: owner.address,
      executor: executor.address,
      source: {
        publicClient: source.publicClient,
        wallet: sourceWallet,
        chainId: source.chain.id,
        confirmations: 1,
        pool,
        dataProvider: provider,
        aToken,
        variableDebtToken: pool,
        collateralToken: sourceCollateral,
        debtToken: sourceDebt,
      },
      destination: {
        publicClient: destination.publicClient,
        wallet: destinationWallet,
        chainId: destination.chain.id,
        confirmations: 1,
        morpho,
        expectedMarketId: morphoMarketId(marketParams),
        marketParams,
      },
      createdAt: '2026-11-12T21:00:00.000Z',
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([source?.stop(), destination?.stop()]);
  });

  it('verifies canonical receipts, runtime hashes, bindings, roles, and disabled writes', async () => {
    const report = await verifyProductionDebtShiftDeployment({
      manifest,
      sourcePublicClient: source.publicClient,
      destinationPublicClient: destination.publicClient,
      minimumExecutorNativeBalanceWei: 1n,
    });

    expect(report.workflowWriteSwitchEnabled).toBe(false);
    expect(report.verifiedContractCount).toBe(7);
    expect(report.verifiedConfigurationTransactionCount).toBeGreaterThanOrEqual(10);
    expect(BigInt(report.sourceExecutorNativeBalanceWei)).toBeGreaterThan(0n);
  });

  it('fails closed when a recorded runtime code hash is changed', async () => {
    const tampered = {
      ...manifest,
      source: {
        ...manifest.source,
        contracts: {
          ...manifest.source.contracts,
          sourceAdapter: {
            ...manifest.source.contracts.sourceAdapter,
            runtimeCodeHash: `0x${'ff'.repeat(32)}` as Hex,
          },
        },
      },
    };
    await expect(
      verifyProductionDebtShiftDeployment({
        manifest: tampered,
        sourcePublicClient: source.publicClient,
        destinationPublicClient: destination.publicClient,
      }),
    ).rejects.toThrow('Runtime code hash mismatch');
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
    throw new Error(`Dependency deployment reverted: ${hash}`);
  }
  return getAddress(receipt.contractAddress);
}

import {
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  toHex,
  type Address,
  type Chain,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testnetVaultFundingManifestSchema } from '@debtshift/domain';

import { loadFoundryArtifact, type FoundryArtifact } from './artifacts.js';
import { startAnvil, type LocalAnvilChain } from './local-chain.js';
import { DEFAULT_ANVIL_BORROWER_KEY, DEFAULT_ANVIL_DEPLOYER_KEY } from './local-deployment.js';
import { fundTestnetLiquidityVault, verifyTestnetLiquidityVaultFunding } from './vault-funding.js';

const runDeploymentTests =
  process.env.RUN_EVM_DEPLOYMENT_TESTS === 'true' ? describe : describe.skip;
type TestWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

runDeploymentTests('testnet source vault funding', () => {
  const owner = privateKeyToAccount(DEFAULT_ANVIL_DEPLOYER_KEY);
  const funder = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
  let chain: LocalAnvilChain;
  let ownerWallet: TestWallet;
  let funderWallet: TestWallet;
  let token: Address;
  let vault: Address;
  let manifest: ReturnType<typeof testnetVaultFundingManifestSchema.parse>;

  beforeAll(async () => {
    chain = await startAnvil({ chainId: 31_337, port: 19_588 });
    ownerWallet = createWalletClient({
      account: owner,
      chain: chain.chain,
      transport: http(chain.rpcUrl),
    });
    funderWallet = createWalletClient({
      account: funder,
      chain: chain.chain,
      transport: http(chain.rpcUrl),
    });
    const [testToken, liquidityVault] = await Promise.all([
      loadFoundryArtifact('TestToken'),
      loadFoundryArtifact('LiquidityVault'),
    ]);
    token = await deploy(ownerWallet, chain.publicClient, testToken, [
      'Source USD',
      'sUSDC',
      6,
      owner.address,
    ]);
    vault = await deploy(ownerWallet, chain.publicClient, liquidityVault, [owner.address]);
    await write(ownerWallet, chain.publicClient, liquidityVault, vault, 'setAsset', [token, true]);
    await write(ownerWallet, chain.publicClient, testToken, token, 'mint', [
      funder.address,
      2_000_000n,
    ]);

    const evidence = await fundTestnetLiquidityVault({
      publicClient: chain.publicClient,
      wallet: funderWallet,
      chainId: chain.chain.id,
      confirmations: 1,
      vault,
      asset: token,
      amountUnits: 1_000_000n,
    });
    manifest = testnetVaultFundingManifestSchema.parse({
      schemaVersion: 1,
      environment: 'testnet',
      createdAt: '2026-11-13T18:00:00.000Z',
      sourceCommit: '1'.repeat(40),
      routeId: 'integration-aave-to-morpho-v1',
      routeConfigurationHash: `0x${'2'.repeat(64)}`,
      routeDependenciesHash: `0x${'3'.repeat(64)}`,
      evmDeploymentManifestHash: `0x${'4'.repeat(64)}`,
      workflowWriteSwitchEnabled: false,
      chainId: chain.chain.id,
      confirmations: 1,
      funder: funder.address,
      vault,
      asset: token,
      amountUnits: '1000000',
      ...evidence,
    });
    // Anvil models finalized as a lagging block tag. Advance far enough that
    // the funding receipts are verifiable through the same finalized reads
    // used on public testnet.
    await chain.publicClient.request({
      method: 'anvil_mine',
      params: ['0x80'],
    } as never);
  }, 60_000);

  afterAll(async () => {
    await chain?.stop();
  });

  it('funds with exact deltas, revokes allowance, and verifies finalized evidence', async () => {
    const report = await verifyTestnetLiquidityVaultFunding({
      manifest,
      publicClient: chain.publicClient,
    });

    expect(report.amountUnits).toBe('1000000');
    expect(report.currentVaultAllowanceUnits).toBe('0');
    expect(report.verifiedTransactionCount).toBe(3);
    expect(manifest.after.funderBalanceUnits).toBe('1000000');
    expect(manifest.after.vaultBalanceUnits).toBe('1000000');
  });

  it('rejects transaction-input drift and a newly introduced residual allowance', async () => {
    await expect(
      verifyTestnetLiquidityVaultFunding({
        manifest: {
          ...manifest,
          transactions: {
            ...manifest.transactions,
            deposit: {
              ...manifest.transactions.deposit,
              transactionInputHash: `0x${'f'.repeat(64)}`,
            },
          },
        },
        publicClient: chain.publicClient,
      }),
    ).rejects.toThrow('transaction evidence mismatch');

    const ownerAllowanceSlot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [funder.address, 6n]),
    );
    const vaultAllowanceSlot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [vault, ownerAllowanceSlot]),
    );
    await chain.publicClient.request({
      method: 'anvil_setStorageAt',
      params: [token, vaultAllowanceSlot, toHex(1n, { size: 32 })],
    } as never);
    const finalizedAtLatestClient = new Proxy(chain.publicClient, {
      get(target, property, receiver) {
        if (property !== 'getBlock') return Reflect.get(target, property, receiver);
        return (parameters: { readonly blockTag?: string }) =>
          parameters.blockTag === 'finalized'
            ? target.getBlock({ blockTag: 'latest' })
            : target.getBlock(parameters as never);
      },
    });
    await expect(
      verifyTestnetLiquidityVaultFunding({ manifest, publicClient: finalizedAtLatestClient }),
    ).rejects.toThrow('residual current allowance');
  });
});

async function deploy(
  wallet: TestWallet,
  publicClient: PublicClient,
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
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (
    receipt.status !== 'success' ||
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error('Test contract deployment failed.');
  }
  return receipt.contractAddress;
}

async function write(
  wallet: TestWallet,
  publicClient: PublicClient,
  artifact: Pick<FoundryArtifact, 'abi'>,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const simulation = await publicClient.simulateContract({
    account: wallet.account,
    address,
    abi: artifact.abi,
    functionName,
    args,
  });
  const hash = await wallet.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} failed.`);
}

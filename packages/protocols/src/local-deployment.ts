import {
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { computeMigrationId } from '@debtshift/domain';

import { loadFoundryArtifact, type FoundryArtifact } from './artifacts.js';

export const DEFAULT_ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const DEFAULT_ANVIL_BORROWER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const LOCAL_INTENT_HASH = `0x${'11'.repeat(32)}` as const;
export const LOCAL_TRANSPORT_QUOTE_HASH = `0x${'22'.repeat(32)}` as const;
export const LOCAL_PLAN_NONCE = 1n;
export const LOCAL_MIGRATION_ID = computeMigrationId(
  LOCAL_INTENT_HASH,
  LOCAL_TRANSPORT_QUOTE_HASH,
  LOCAL_PLAN_NONCE,
);

export interface SourceDeployment {
  readonly debtToken: Address;
  readonly collateralToken: Address;
  readonly lending: Address;
  readonly vault: Address;
  readonly escrow: Address;
  readonly adapter: Address;
}

export interface DestinationDeployment {
  readonly debtToken: Address;
  readonly collateralToken: Address;
  readonly lending: Address;
  readonly escrow: Address;
  readonly adapter: Address;
}

export interface LocalDebtShiftDeployment {
  readonly deployer: Address;
  readonly borrower: Address;
  readonly source: SourceDeployment;
  readonly destination: DestinationDeployment;
}

type LocalWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

export async function deployLocalDebtShift(
  sourceChain: Chain,
  sourcePublicClient: PublicClient,
  destinationChain: Chain,
  destinationPublicClient: PublicClient,
): Promise<LocalDebtShiftDeployment> {
  const deployerAccount = privateKeyToAccount(DEFAULT_ANVIL_DEPLOYER_KEY);
  const borrowerAccount = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
  const sourceDeployer = createWalletClient({
    account: deployerAccount,
    chain: sourceChain,
    transport: http(sourceChain.rpcUrls.default.http[0]),
  });
  const sourceBorrower = createWalletClient({
    account: borrowerAccount,
    chain: sourceChain,
    transport: http(sourceChain.rpcUrls.default.http[0]),
  });
  const destinationDeployer = createWalletClient({
    account: deployerAccount,
    chain: destinationChain,
    transport: http(destinationChain.rpcUrls.default.http[0]),
  });
  const artifacts = await loadArtifacts();

  const sourceDebtToken = await deploy(sourceDeployer, sourcePublicClient, artifacts.testToken, [
    'Source USD',
    'sUSDC',
    6,
    deployerAccount.address,
  ]);
  const sourceCollateralToken = await deploy(
    sourceDeployer,
    sourcePublicClient,
    artifacts.testToken,
    ['Source Ether', 'sWETH', 18, deployerAccount.address],
  );
  const sourceLending = await deploy(sourceDeployer, sourcePublicClient, artifacts.sourceLending, [
    sourceCollateralToken,
    sourceDebtToken,
  ]);
  const vault = await deploy(sourceDeployer, sourcePublicClient, artifacts.vault, [
    deployerAccount.address,
  ]);
  const sourceEscrow = await deploy(sourceDeployer, sourcePublicClient, artifacts.escrow, [
    deployerAccount.address,
  ]);
  const sourceAdapter = await deploy(sourceDeployer, sourcePublicClient, artifacts.sourceAdapter, [
    deployerAccount.address,
    vault,
    sourceLending,
    sourceEscrow,
  ]);

  await write(sourceDeployer, sourcePublicClient, artifacts.vault.abi, vault, 'setAsset', [
    sourceDebtToken,
    true,
  ]);
  await write(sourceDeployer, sourcePublicClient, artifacts.vault.abi, vault, 'setAdapter', [
    sourceAdapter,
    true,
  ]);
  await write(
    sourceDeployer,
    sourcePublicClient,
    artifacts.escrow.abi,
    sourceEscrow,
    'setDepositor',
    [sourceAdapter, true],
  );

  await write(
    sourceDeployer,
    sourcePublicClient,
    artifacts.testToken.abi,
    sourceDebtToken,
    'mint',
    [sourceLending, 100_000_000_000n],
  );
  await write(
    sourceDeployer,
    sourcePublicClient,
    artifacts.testToken.abi,
    sourceCollateralToken,
    'mint',
    [borrowerAccount.address, 10n * 10n ** 18n],
  );
  await write(
    sourceBorrower,
    sourcePublicClient,
    artifacts.testToken.abi,
    sourceCollateralToken,
    'approve',
    [sourceLending, 10n * 10n ** 18n],
  );
  await write(
    sourceBorrower,
    sourcePublicClient,
    artifacts.sourceLending.abi,
    sourceLending,
    'openPosition',
    [10n * 10n ** 18n, 10_000_000_000n],
  );
  await write(
    sourceDeployer,
    sourcePublicClient,
    artifacts.testToken.abi,
    sourceDebtToken,
    'mint',
    [deployerAccount.address, 20_000_000_000n],
  );
  await write(
    sourceDeployer,
    sourcePublicClient,
    artifacts.testToken.abi,
    sourceDebtToken,
    'approve',
    [vault, 20_000_000_000n],
  );
  await write(sourceDeployer, sourcePublicClient, artifacts.vault.abi, vault, 'deposit', [
    sourceDebtToken,
    20_000_000_000n,
  ]);

  const destinationDebtToken = await deploy(
    destinationDeployer,
    destinationPublicClient,
    artifacts.testToken,
    ['Destination USD', 'dUSDC', 6, deployerAccount.address],
  );
  const destinationCollateralToken = await deploy(
    destinationDeployer,
    destinationPublicClient,
    artifacts.testToken,
    ['Destination Ether', 'dWETH', 18, deployerAccount.address],
  );
  const targetLending = await deploy(
    destinationDeployer,
    destinationPublicClient,
    artifacts.targetLending,
    [destinationCollateralToken, destinationDebtToken, 18, 6, 2_000n * 10n ** 18n, 7_500],
  );
  const destinationEscrow = await deploy(
    destinationDeployer,
    destinationPublicClient,
    artifacts.escrow,
    [deployerAccount.address],
  );
  const destinationAdapter = await deploy(
    destinationDeployer,
    destinationPublicClient,
    artifacts.destinationAdapter,
    [deployerAccount.address, targetLending, destinationEscrow],
  );
  await write(
    destinationDeployer,
    destinationPublicClient,
    artifacts.escrow.abi,
    destinationEscrow,
    'setOperator',
    [destinationAdapter, true],
  );
  await write(
    destinationDeployer,
    destinationPublicClient,
    artifacts.destinationAdapter.abi,
    destinationAdapter,
    'setPlanDomain',
    [sourceChain.id, sourceAdapter, true],
  );
  await write(
    destinationDeployer,
    destinationPublicClient,
    artifacts.testToken.abi,
    destinationDebtToken,
    'mint',
    [targetLending, 100_000_000_000n],
  );

  return {
    deployer: deployerAccount.address,
    borrower: borrowerAccount.address,
    source: {
      debtToken: sourceDebtToken,
      collateralToken: sourceCollateralToken,
      lending: sourceLending,
      vault,
      escrow: sourceEscrow,
      adapter: sourceAdapter,
    },
    destination: {
      debtToken: destinationDebtToken,
      collateralToken: destinationCollateralToken,
      lending: targetLending,
      escrow: destinationEscrow,
      adapter: destinationAdapter,
    },
  };
}

async function deploy(
  wallet: LocalWallet,
  publicClient: PublicClient,
  artifact: FoundryArtifact,
  args: readonly unknown[],
): Promise<Address> {
  const transactionHash = await wallet.deployContract({
    account: wallet.account,
    chain: wallet.chain,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`Contract deployment reverted: ${transactionHash}`);
  }
  return receipt.contractAddress;
}

export async function write(
  wallet: LocalWallet,
  publicClient: PublicClient,
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<Hex> {
  const transactionHash = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address,
    abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== 'success') {
    throw new Error(`${functionName} reverted: ${transactionHash}`);
  }
  return transactionHash;
}

async function loadArtifacts() {
  const [
    testToken,
    sourceLending,
    targetLending,
    vault,
    escrow,
    sourceAdapter,
    destinationAdapter,
  ] = await Promise.all([
    loadFoundryArtifact('TestToken'),
    loadFoundryArtifact('MockSourceLending'),
    loadFoundryArtifact('MockTargetLending'),
    loadFoundryArtifact('TestLiquidityVault'),
    loadFoundryArtifact('MigrationEscrow'),
    loadFoundryArtifact('SourceAdapter'),
    loadFoundryArtifact('DestinationAdapter'),
  ]);
  return {
    testToken,
    sourceLending,
    targetLending,
    vault,
    escrow,
    sourceAdapter,
    destinationAdapter,
  };
}

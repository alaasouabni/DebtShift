import type { DebtShiftEvmDeploymentManifest } from '@debtshift/domain';
import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbiParameters,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';

import { loadFoundryArtifact, type FoundryArtifact } from './artifacts.js';
import { readAaveReserveTokenAddresses } from './aave-v3.js';
import { MORPHO_BLUE_READ_ABI, morphoMarketId, type MorphoMarketParams } from './morpho-blue.js';

type DeploymentWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

export interface ProductionDebtShiftDeploymentInput {
  readonly environment: 'testnet' | 'mainnet';
  readonly routeId: string;
  readonly routeConfigurationHash: Hex;
  readonly sourceCommit: string;
  readonly owner: Address;
  readonly executor: Address;
  readonly source: {
    readonly publicClient: PublicClient;
    readonly wallet: DeploymentWallet;
    readonly chainId: number;
    readonly confirmations: number;
    readonly pool: Address;
    readonly dataProvider: Address;
    readonly aToken: Address;
    readonly variableDebtToken: Address;
    readonly collateralToken: Address;
    readonly debtToken: Address;
  };
  readonly destination: {
    readonly publicClient: PublicClient;
    readonly wallet: DeploymentWallet;
    readonly chainId: number;
    readonly confirmations: number;
    readonly morpho: Address;
    readonly expectedMarketId: Hex;
    readonly marketParams: MorphoMarketParams;
  };
  readonly createdAt?: string;
}

export interface ProductionDeploymentVerificationInput {
  readonly manifest: DebtShiftEvmDeploymentManifest;
  readonly sourcePublicClient: PublicClient;
  readonly destinationPublicClient: PublicClient;
  readonly minimumVaultFreeLiquidityUnits?: bigint;
  readonly minimumExecutorNativeBalanceWei?: bigint;
}

export interface ProductionDeploymentVerificationReport {
  readonly verifiedAt: string;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sourceBlockNumber: string;
  readonly destinationBlockNumber: string;
  readonly sourceVaultFreeLiquidityUnits: string;
  readonly sourceExecutorNativeBalanceWei: string;
  readonly destinationExecutorNativeBalanceWei: string;
  readonly verifiedContractCount: number;
  readonly verifiedConfigurationTransactionCount: number;
  readonly workflowWriteSwitchEnabled: false;
}

interface DeploymentArtifacts {
  readonly vault: FoundryArtifact;
  readonly escrow: FoundryArtifact;
  readonly sourceLending: FoundryArtifact;
  readonly targetLending: FoundryArtifact;
  readonly sourceAdapter: FoundryArtifact;
  readonly destinationAdapter: FoundryArtifact;
}

type ContractRecord = DebtShiftEvmDeploymentManifest['source']['contracts']['liquidityVault'];
type ConfigurationRecord =
  DebtShiftEvmDeploymentManifest['source']['configurationTransactions'][number];

/**
 * Deploys only the DebtShift execution contracts around already validated Aave
 * and Morpho deployments. It never deploys tokens, lending mocks, or liquidity.
 * The caller must keep MAINNET_EXECUTION_ENABLED=false; this function records
 * that release invariant in the returned immutable manifest.
 */
export async function deployProductionDebtShift(
  input: ProductionDebtShiftDeploymentInput,
): Promise<DebtShiftEvmDeploymentManifest> {
  assertDeploymentInput(input);
  const artifacts = await loadProductionDeploymentArtifacts();
  const sourceContracts = await deploySource(input, artifacts);
  const destinationContracts = await deployDestination(
    input,
    artifacts,
    sourceContracts.adapter.address,
  );

  return {
    schemaVersion: 1,
    environment: input.environment,
    routeId: input.routeId,
    routeConfigurationHash: input.routeConfigurationHash,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    owner: getAddress(input.owner),
    executor: getAddress(input.executor),
    workflowWriteSwitchEnabled: false,
    source: {
      chainId: input.source.chainId,
      deploymentBlockNumber: minimumDeploymentBlock([
        sourceContracts.vault,
        sourceContracts.escrow,
        sourceContracts.lending,
        sourceContracts.adapter,
      ]),
      protocol: {
        kind: 'AAVE_V3',
        pool: getAddress(input.source.pool),
        dataProvider: getAddress(input.source.dataProvider),
        aToken: getAddress(input.source.aToken),
        variableDebtToken: getAddress(input.source.variableDebtToken),
      },
      collateralToken: getAddress(input.source.collateralToken),
      debtToken: getAddress(input.source.debtToken),
      contracts: {
        liquidityVault: sourceContracts.vault,
        migrationEscrow: sourceContracts.escrow,
        sourceLending: sourceContracts.lending,
        sourceAdapter: sourceContracts.adapter,
      },
      configurationTransactions: sourceContracts.configuration,
    },
    destination: {
      chainId: input.destination.chainId,
      deploymentBlockNumber: minimumDeploymentBlock([
        destinationContracts.escrow,
        destinationContracts.lending,
        destinationContracts.adapter,
      ]),
      protocol: {
        kind: 'MORPHO_BLUE',
        morpho: getAddress(input.destination.morpho),
        marketId: input.destination.expectedMarketId.toLowerCase() as Hex,
        oracle: getAddress(input.destination.marketParams.oracle),
        irm: getAddress(input.destination.marketParams.irm),
        lltv: input.destination.marketParams.lltv.toString(),
      },
      collateralToken: getAddress(input.destination.marketParams.collateralToken),
      debtToken: getAddress(input.destination.marketParams.loanToken),
      contracts: {
        migrationEscrow: destinationContracts.escrow,
        targetLending: destinationContracts.lending,
        destinationAdapter: destinationContracts.adapter,
      },
      configurationTransactions: destinationContracts.configuration,
    },
  };
}

/**
 * Read-only acceptance check for an already deployed manifest. It verifies
 * canonical deployment/configuration receipts, runtime code hashes, immutable
 * protocol bindings, roles, pause state, plan domain, and optional funding/gas
 * floors without constructing a wallet client or loading a private key.
 */
export async function verifyProductionDebtShiftDeployment({
  manifest,
  sourcePublicClient,
  destinationPublicClient,
  minimumVaultFreeLiquidityUnits = 0n,
  minimumExecutorNativeBalanceWei = 0n,
}: ProductionDeploymentVerificationInput): Promise<ProductionDeploymentVerificationReport> {
  const artifacts = await loadProductionDeploymentArtifacts();
  const [sourceChainId, destinationChainId, sourceBlockNumber, destinationBlockNumber] =
    await Promise.all([
      sourcePublicClient.getChainId(),
      destinationPublicClient.getChainId(),
      sourcePublicClient.getBlockNumber(),
      destinationPublicClient.getBlockNumber(),
    ]);
  if (
    sourceChainId !== manifest.source.chainId ||
    destinationChainId !== manifest.destination.chainId
  ) {
    throw new Error(
      `Deployment manifest chain mismatch: received ${sourceChainId}/${destinationChainId}.`,
    );
  }

  const sourceContractRecords = Object.values(manifest.source.contracts);
  const destinationContractRecords = Object.values(manifest.destination.contracts);
  await Promise.all([
    ...sourceContractRecords.map((record) => verifyContractRecord(sourcePublicClient, record)),
    ...destinationContractRecords.map((record) =>
      verifyContractRecord(destinationPublicClient, record),
    ),
    ...manifest.source.configurationTransactions.map((record) =>
      verifyConfigurationRecord(sourcePublicClient, record),
    ),
    ...manifest.destination.configurationTransactions.map((record) =>
      verifyConfigurationRecord(destinationPublicClient, record),
    ),
  ]);
  await assertDeployedCode(sourcePublicClient, [
    manifest.source.protocol.pool,
    manifest.source.protocol.dataProvider,
    manifest.source.protocol.aToken,
    manifest.source.protocol.variableDebtToken,
    manifest.source.collateralToken,
    manifest.source.debtToken,
  ]);
  await assertDeployedCode(destinationPublicClient, [
    manifest.destination.protocol.morpho,
    manifest.destination.protocol.oracle,
    manifest.destination.protocol.irm,
    manifest.destination.collateralToken,
    manifest.destination.debtToken,
  ]);

  const reserveTokens = await readAaveReserveTokenAddresses(
    sourcePublicClient,
    manifest.source.protocol.dataProvider,
    manifest.source.collateralToken,
  );
  assertSameAddress('Aave aToken', reserveTokens.aToken, manifest.source.protocol.aToken);
  assertSameAddress(
    'Aave variable-debt token',
    reserveTokens.variableDebtToken,
    manifest.source.protocol.variableDebtToken,
  );
  const rawMarketParams = await destinationPublicClient.readContract({
    address: manifest.destination.protocol.morpho,
    abi: MORPHO_BLUE_READ_ABI,
    functionName: 'idToMarketParams',
    args: [manifest.destination.protocol.marketId],
  });
  const actualMarketParams: MorphoMarketParams = {
    loanToken: getAddress(rawMarketParams[0]),
    collateralToken: getAddress(rawMarketParams[1]),
    oracle: getAddress(rawMarketParams[2]),
    irm: getAddress(rawMarketParams[3]),
    lltv: rawMarketParams[4],
  };
  assertSameAddress(
    'Morpho loan token',
    actualMarketParams.loanToken,
    manifest.destination.debtToken,
  );
  assertSameAddress(
    'Morpho collateral token',
    actualMarketParams.collateralToken,
    manifest.destination.collateralToken,
  );
  assertSameAddress(
    'Morpho oracle',
    actualMarketParams.oracle,
    manifest.destination.protocol.oracle,
  );
  assertSameAddress('Morpho IRM', actualMarketParams.irm, manifest.destination.protocol.irm);
  if (
    actualMarketParams.lltv.toString() !== manifest.destination.protocol.lltv ||
    morphoMarketId(actualMarketParams).toLowerCase() !==
      manifest.destination.protocol.marketId.toLowerCase()
  ) {
    throw new Error('Morpho market parameters no longer match the deployment manifest.');
  }

  const source = manifest.source.contracts;
  const destination = manifest.destination.contracts;
  const planDomain = keccak256(
    encodeAbiParameters(parseAbiParameters('uint256, address'), [
      BigInt(manifest.source.chainId),
      source.sourceAdapter.address,
    ]),
  );
  const [
    sourceAdapterOwner,
    sourceAdapterVault,
    sourceAdapterLending,
    sourceAdapterEscrow,
    sourceAdapterExecutor,
    sourcePaused,
    sourceLendingOwner,
    sourceLendingPool,
    sourceLendingAToken,
    sourceLendingVariableDebtToken,
    sourceLendingAdapter,
    vaultOwner,
    vaultOperator,
    vaultVerifier,
    vaultAdapter,
    vaultAsset,
    sourceEscrowOwner,
    sourceEscrowOperator,
    sourceEscrowDepositor,
    destinationAdapterOwner,
    destinationAdapterLending,
    destinationAdapterEscrow,
    destinationAdapterExecutor,
    destinationAdapterVerifier,
    destinationPlanDomain,
    destinationPaused,
    targetLendingOwner,
    targetLendingMorpho,
    targetLendingAdapter,
    targetMarketId,
    destinationEscrowOwner,
    destinationEscrowExecutor,
    destinationEscrowAdapter,
    sourceVaultFreeLiquidityUnits,
    sourceExecutorNativeBalanceWei,
    destinationExecutorNativeBalanceWei,
  ] = await Promise.all([
    readAddress(
      sourcePublicClient,
      artifacts.sourceAdapter,
      source.sourceAdapter.address,
      'owner',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceAdapter,
      source.sourceAdapter.address,
      'vault',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceAdapter,
      source.sourceAdapter.address,
      'lending',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceAdapter,
      source.sourceAdapter.address,
      'escrow',
      [],
    ),
    readBoolean(
      sourcePublicClient,
      artifacts.sourceAdapter,
      source.sourceAdapter.address,
      'executors',
      [manifest.executor],
    ),
    readBoolean(
      sourcePublicClient,
      artifacts.sourceAdapter,
      source.sourceAdapter.address,
      'paused',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceLending,
      source.sourceLending.address,
      'owner',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceLending,
      source.sourceLending.address,
      'pool',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceLending,
      source.sourceLending.address,
      'aToken',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceLending,
      source.sourceLending.address,
      'variableDebtToken',
      [],
    ),
    readAddress(
      sourcePublicClient,
      artifacts.sourceLending,
      source.sourceLending.address,
      'sourceAdapter',
      [],
    ),
    readAddress(sourcePublicClient, artifacts.vault, source.liquidityVault.address, 'owner', []),
    readBoolean(sourcePublicClient, artifacts.vault, source.liquidityVault.address, 'operators', [
      manifest.executor,
    ]),
    readBoolean(sourcePublicClient, artifacts.vault, source.liquidityVault.address, 'verifiers', [
      manifest.executor,
    ]),
    readBoolean(sourcePublicClient, artifacts.vault, source.liquidityVault.address, 'adapters', [
      source.sourceAdapter.address,
    ]),
    readBoolean(sourcePublicClient, artifacts.vault, source.liquidityVault.address, 'assets', [
      manifest.source.debtToken,
    ]),
    readAddress(sourcePublicClient, artifacts.escrow, source.migrationEscrow.address, 'owner', []),
    readBoolean(sourcePublicClient, artifacts.escrow, source.migrationEscrow.address, 'operators', [
      manifest.executor,
    ]),
    readBoolean(
      sourcePublicClient,
      artifacts.escrow,
      source.migrationEscrow.address,
      'depositors',
      [source.sourceAdapter.address],
    ),
    readAddress(
      destinationPublicClient,
      artifacts.destinationAdapter,
      destination.destinationAdapter.address,
      'owner',
      [],
    ),
    readAddress(
      destinationPublicClient,
      artifacts.destinationAdapter,
      destination.destinationAdapter.address,
      'lending',
      [],
    ),
    readAddress(
      destinationPublicClient,
      artifacts.destinationAdapter,
      destination.destinationAdapter.address,
      'escrow',
      [],
    ),
    readBoolean(
      destinationPublicClient,
      artifacts.destinationAdapter,
      destination.destinationAdapter.address,
      'executors',
      [manifest.executor],
    ),
    readBoolean(
      destinationPublicClient,
      artifacts.destinationAdapter,
      destination.destinationAdapter.address,
      'verifiers',
      [manifest.executor],
    ),
    readBoolean(
      destinationPublicClient,
      artifacts.destinationAdapter,
      destination.destinationAdapter.address,
      'planDomains',
      [planDomain],
    ),
    readBoolean(
      destinationPublicClient,
      artifacts.destinationAdapter,
      destination.destinationAdapter.address,
      'paused',
      [],
    ),
    readAddress(
      destinationPublicClient,
      artifacts.targetLending,
      destination.targetLending.address,
      'owner',
      [],
    ),
    readAddress(
      destinationPublicClient,
      artifacts.targetLending,
      destination.targetLending.address,
      'morpho',
      [],
    ),
    readAddress(
      destinationPublicClient,
      artifacts.targetLending,
      destination.targetLending.address,
      'destinationAdapter',
      [],
    ),
    readHex(
      destinationPublicClient,
      artifacts.targetLending,
      destination.targetLending.address,
      'marketId',
      [],
    ),
    readAddress(
      destinationPublicClient,
      artifacts.escrow,
      destination.migrationEscrow.address,
      'owner',
      [],
    ),
    readBoolean(
      destinationPublicClient,
      artifacts.escrow,
      destination.migrationEscrow.address,
      'operators',
      [manifest.executor],
    ),
    readBoolean(
      destinationPublicClient,
      artifacts.escrow,
      destination.migrationEscrow.address,
      'operators',
      [destination.destinationAdapter.address],
    ),
    readBigInt(
      sourcePublicClient,
      artifacts.vault,
      source.liquidityVault.address,
      'freeLiquidity',
      [manifest.source.debtToken],
    ),
    sourcePublicClient.getBalance({ address: manifest.executor }),
    destinationPublicClient.getBalance({ address: manifest.executor }),
  ]);
  const addressBindings: readonly [string, Address, Address][] = [
    ['source adapter owner', sourceAdapterOwner, manifest.owner],
    ['source adapter vault', sourceAdapterVault, source.liquidityVault.address],
    ['source adapter lending', sourceAdapterLending, source.sourceLending.address],
    ['source adapter escrow', sourceAdapterEscrow, source.migrationEscrow.address],
    ['source lending owner', sourceLendingOwner, manifest.owner],
    ['source lending pool', sourceLendingPool, manifest.source.protocol.pool],
    ['source lending aToken', sourceLendingAToken, manifest.source.protocol.aToken],
    [
      'source lending variable debt',
      sourceLendingVariableDebtToken,
      manifest.source.protocol.variableDebtToken,
    ],
    ['source lending adapter', sourceLendingAdapter, source.sourceAdapter.address],
    ['liquidity vault owner', vaultOwner, manifest.owner],
    ['source escrow owner', sourceEscrowOwner, manifest.owner],
    ['destination adapter owner', destinationAdapterOwner, manifest.owner],
    ['destination adapter lending', destinationAdapterLending, destination.targetLending.address],
    ['destination adapter escrow', destinationAdapterEscrow, destination.migrationEscrow.address],
    ['target lending owner', targetLendingOwner, manifest.owner],
    ['target lending Morpho', targetLendingMorpho, manifest.destination.protocol.morpho],
    ['target lending adapter', targetLendingAdapter, destination.destinationAdapter.address],
    ['destination escrow owner', destinationEscrowOwner, manifest.owner],
  ];
  for (const [label, actual, expected] of addressBindings) {
    assertSameAddress(label, actual, expected);
  }
  if (targetMarketId.toLowerCase() !== manifest.destination.protocol.marketId.toLowerCase()) {
    throw new Error('Target module market ID does not match the deployment manifest.');
  }
  if (
    sourcePaused ||
    destinationPaused ||
    !sourceAdapterExecutor ||
    !vaultOperator ||
    !vaultVerifier ||
    !vaultAdapter ||
    !vaultAsset ||
    !sourceEscrowOperator ||
    !sourceEscrowDepositor ||
    !destinationAdapterExecutor ||
    !destinationAdapterVerifier ||
    !destinationPlanDomain ||
    !destinationEscrowExecutor ||
    !destinationEscrowAdapter
  ) {
    throw new Error('Deployment roles, pause state, or plan-domain allowlist are not ready.');
  }
  if (sourceVaultFreeLiquidityUnits < minimumVaultFreeLiquidityUnits) {
    throw new Error(
      `Source vault has ${sourceVaultFreeLiquidityUnits} free units; ${minimumVaultFreeLiquidityUnits} required.`,
    );
  }
  if (
    sourceExecutorNativeBalanceWei < minimumExecutorNativeBalanceWei ||
    destinationExecutorNativeBalanceWei < minimumExecutorNativeBalanceWei
  ) {
    throw new Error('Executor native gas balance is below the configured readiness floor.');
  }
  return {
    verifiedAt: new Date().toISOString(),
    sourceChainId,
    destinationChainId,
    sourceBlockNumber: sourceBlockNumber.toString(),
    destinationBlockNumber: destinationBlockNumber.toString(),
    sourceVaultFreeLiquidityUnits: sourceVaultFreeLiquidityUnits.toString(),
    sourceExecutorNativeBalanceWei: sourceExecutorNativeBalanceWei.toString(),
    destinationExecutorNativeBalanceWei: destinationExecutorNativeBalanceWei.toString(),
    verifiedContractCount: sourceContractRecords.length + destinationContractRecords.length,
    verifiedConfigurationTransactionCount:
      manifest.source.configurationTransactions.length +
      manifest.destination.configurationTransactions.length,
    workflowWriteSwitchEnabled: false,
  };
}

async function deploySource(
  input: ProductionDebtShiftDeploymentInput,
  artifacts: DeploymentArtifacts,
) {
  const { publicClient, wallet, confirmations } = input.source;
  const vault = await deployTracked(
    wallet,
    publicClient,
    confirmations,
    'LiquidityVault',
    artifacts.vault,
    [input.owner],
  );
  const escrow = await deployTracked(
    wallet,
    publicClient,
    confirmations,
    'MigrationEscrow',
    artifacts.escrow,
    [input.owner],
  );
  const lending = await deployTracked(
    wallet,
    publicClient,
    confirmations,
    'AaveV3SourceLending',
    artifacts.sourceLending,
    [
      input.owner,
      input.source.pool,
      input.source.aToken,
      input.source.variableDebtToken,
      input.source.collateralToken,
      input.source.debtToken,
    ],
  );
  const adapter = await deployTracked(
    wallet,
    publicClient,
    confirmations,
    'SourceAdapter',
    artifacts.sourceAdapter,
    [input.owner, vault.address, lending.address, escrow.address],
  );
  const configuration: ConfigurationRecord[] = [];
  configuration.push(
    await writeTracked(
      wallet,
      publicClient,
      confirmations,
      'bind Aave source module to source adapter',
      artifacts.sourceLending.abi,
      lending.address,
      'setSourceAdapter',
      [adapter.address],
    ),
    await writeTracked(
      wallet,
      publicClient,
      confirmations,
      'allow source debt asset in liquidity vault',
      artifacts.vault.abi,
      vault.address,
      'setAsset',
      [input.source.debtToken, true],
    ),
    await writeTracked(
      wallet,
      publicClient,
      confirmations,
      'allow source adapter in liquidity vault',
      artifacts.vault.abi,
      vault.address,
      'setAdapter',
      [adapter.address, true],
    ),
    await writeTracked(
      wallet,
      publicClient,
      confirmations,
      'allow source adapter deposits into source escrow',
      artifacts.escrow.abi,
      escrow.address,
      'setDepositor',
      [adapter.address, true],
    ),
  );
  if (!isAddressEqual(input.owner, input.executor)) {
    configuration.push(
      await writeTracked(
        wallet,
        publicClient,
        confirmations,
        'allow executor as liquidity vault operator',
        artifacts.vault.abi,
        vault.address,
        'setOperator',
        [input.executor, true],
      ),
      await writeTracked(
        wallet,
        publicClient,
        confirmations,
        'allow executor as liquidity vault verifier',
        artifacts.vault.abi,
        vault.address,
        'setVerifier',
        [input.executor, true],
      ),
      await writeTracked(
        wallet,
        publicClient,
        confirmations,
        'allow executor on source adapter',
        artifacts.sourceAdapter.abi,
        adapter.address,
        'setExecutor',
        [input.executor, true],
      ),
      await writeTracked(
        wallet,
        publicClient,
        confirmations,
        'allow executor on source escrow',
        artifacts.escrow.abi,
        escrow.address,
        'setOperator',
        [input.executor, true],
      ),
    );
  }
  return { vault, escrow, lending, adapter, configuration };
}

async function deployDestination(
  input: ProductionDebtShiftDeploymentInput,
  artifacts: DeploymentArtifacts,
  sourceAdapter: Address,
) {
  const { publicClient, wallet, confirmations } = input.destination;
  const escrow = await deployTracked(
    wallet,
    publicClient,
    confirmations,
    'MigrationEscrow',
    artifacts.escrow,
    [input.owner],
  );
  const lending = await deployTracked(
    wallet,
    publicClient,
    confirmations,
    'MorphoBlueTargetLending',
    artifacts.targetLending,
    [input.owner, input.destination.morpho, input.destination.marketParams],
  );
  const adapter = await deployTracked(
    wallet,
    publicClient,
    confirmations,
    'DestinationAdapter',
    artifacts.destinationAdapter,
    [input.owner, lending.address, escrow.address],
  );
  const configuration: ConfigurationRecord[] = [];
  configuration.push(
    await writeTracked(
      wallet,
      publicClient,
      confirmations,
      'bind Morpho target module to destination adapter',
      artifacts.targetLending.abi,
      lending.address,
      'setDestinationAdapter',
      [adapter.address],
    ),
    await writeTracked(
      wallet,
      publicClient,
      confirmations,
      'allow destination adapter on destination escrow',
      artifacts.escrow.abi,
      escrow.address,
      'setOperator',
      [adapter.address, true],
    ),
    await writeTracked(
      wallet,
      publicClient,
      confirmations,
      'allow signed source plan domain on destination adapter',
      artifacts.destinationAdapter.abi,
      adapter.address,
      'setPlanDomain',
      [input.source.chainId, sourceAdapter, true],
    ),
  );
  if (!isAddressEqual(input.owner, input.executor)) {
    configuration.push(
      await writeTracked(
        wallet,
        publicClient,
        confirmations,
        'allow executor on destination adapter',
        artifacts.destinationAdapter.abi,
        adapter.address,
        'setExecutor',
        [input.executor, true],
      ),
      await writeTracked(
        wallet,
        publicClient,
        confirmations,
        'allow executor as destination feasibility verifier',
        artifacts.destinationAdapter.abi,
        adapter.address,
        'setVerifier',
        [input.executor, true],
      ),
      await writeTracked(
        wallet,
        publicClient,
        confirmations,
        'allow executor on destination escrow',
        artifacts.escrow.abi,
        escrow.address,
        'setOperator',
        [input.executor, true],
      ),
    );
  }
  return { escrow, lending, adapter, configuration };
}

async function deployTracked(
  wallet: DeploymentWallet,
  client: PublicClient,
  confirmations: number,
  artifactName: string,
  artifact: FoundryArtifact,
  args: readonly unknown[],
): Promise<ContractRecord> {
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
  const code = await client.getCode({ address: receipt.contractAddress });
  if (code === undefined || code === '0x') {
    throw new Error(`${artifactName} deployment has no runtime bytecode.`);
  }
  return {
    artifact: artifactName,
    address: receipt.contractAddress,
    deploymentTransactionHash,
    deploymentBlockNumber: receipt.blockNumber.toString(),
    deploymentBlockHash: receipt.blockHash,
    runtimeCodeHash: keccak256(code),
  };
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
): Promise<ConfigurationRecord> {
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
    action,
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
  };
}

function assertDeploymentInput(input: ProductionDebtShiftDeploymentInput): void {
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) {
    throw new Error('Production deployment requires a full lowercase Git source commit.');
  }
  if (input.source.chainId === input.destination.chainId) {
    throw new Error('Production source and destination deployment chains must differ.');
  }
  if (
    input.source.confirmations < 1 ||
    input.destination.confirmations < 1 ||
    !Number.isInteger(input.source.confirmations) ||
    !Number.isInteger(input.destination.confirmations)
  ) {
    throw new Error('Deployment confirmations must be positive integers.');
  }
  if (
    input.source.wallet.account === undefined ||
    input.destination.wallet.account === undefined ||
    !isAddressEqual(input.source.wallet.account.address, input.owner) ||
    !isAddressEqual(input.destination.wallet.account.address, input.owner)
  ) {
    throw new Error(
      'The deployment signer must equal the configured contract owner on both chains.',
    );
  }
  if (isAddressEqual(input.source.collateralToken, input.source.debtToken)) {
    throw new Error('Production source collateral and debt tokens must differ.');
  }
  if (
    isAddressEqual(
      input.destination.marketParams.collateralToken,
      input.destination.marketParams.loanToken,
    )
  ) {
    throw new Error('Production destination collateral and debt tokens must differ.');
  }
  const derivedMarketId = morphoMarketId(input.destination.marketParams);
  if (derivedMarketId.toLowerCase() !== input.destination.expectedMarketId.toLowerCase()) {
    throw new Error('Morpho market parameters do not derive the expected allowlisted market ID.');
  }
}

function minimumDeploymentBlock(records: readonly ContractRecord[]): string {
  return records
    .map(({ deploymentBlockNumber }) => BigInt(deploymentBlockNumber))
    .reduce((minimum, current) => (current < minimum ? current : minimum))
    .toString();
}

async function loadProductionDeploymentArtifacts(): Promise<DeploymentArtifacts> {
  const [vault, escrow, sourceLending, targetLending, sourceAdapter, destinationAdapter] =
    await Promise.all([
      loadFoundryArtifact('LiquidityVault'),
      loadFoundryArtifact('MigrationEscrow'),
      loadFoundryArtifact('AaveV3SourceLending'),
      loadFoundryArtifact('MorphoBlueTargetLending'),
      loadFoundryArtifact('SourceAdapter'),
      loadFoundryArtifact('DestinationAdapter'),
    ]);
  return { vault, escrow, sourceLending, targetLending, sourceAdapter, destinationAdapter };
}

async function verifyContractRecord(client: PublicClient, record: ContractRecord): Promise<void> {
  const [receipt, code] = await Promise.all([
    client.getTransactionReceipt({ hash: record.deploymentTransactionHash }),
    client.getCode({ address: record.address }),
  ]);
  if (
    receipt.status !== 'success' ||
    receipt.blockNumber.toString() !== record.deploymentBlockNumber ||
    receipt.blockHash.toLowerCase() !== record.deploymentBlockHash.toLowerCase() ||
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined ||
    !isAddressEqual(receipt.contractAddress, record.address)
  ) {
    throw new Error(`Deployment receipt mismatch for ${record.artifact} at ${record.address}.`);
  }
  if (code === undefined || code === '0x' || keccak256(code) !== record.runtimeCodeHash) {
    throw new Error(`Runtime code hash mismatch for ${record.artifact} at ${record.address}.`);
  }
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error(`Deployment block is no longer canonical for ${record.artifact}.`);
  }
}

async function verifyConfigurationRecord(
  client: PublicClient,
  record: ConfigurationRecord,
): Promise<void> {
  const receipt = await client.getTransactionReceipt({ hash: record.transactionHash });
  if (
    receipt.status !== 'success' ||
    receipt.blockNumber.toString() !== record.blockNumber ||
    receipt.blockHash.toLowerCase() !== record.blockHash.toLowerCase()
  ) {
    throw new Error(`Configuration receipt mismatch for ${record.action}.`);
  }
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error(`Configuration block is no longer canonical for ${record.action}.`);
  }
}

async function assertDeployedCode(
  client: PublicClient,
  addresses: readonly Address[],
): Promise<void> {
  await Promise.all(
    [...new Set(addresses.map((address) => getAddress(address)))].map(async (address) => {
      const code = await client.getCode({ address });
      if (code === undefined || code === '0x') {
        throw new Error(`Expected deployed protocol or asset code at ${address}.`);
      }
    }),
  );
}

async function readAddress(
  client: PublicClient,
  artifact: FoundryArtifact,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<Address> {
  const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
  if (typeof result !== 'string') throw new Error(`Unexpected ${functionName} address response.`);
  return getAddress(result);
}

async function readBoolean(
  client: PublicClient,
  artifact: FoundryArtifact,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<boolean> {
  const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
  if (typeof result !== 'boolean') throw new Error(`Unexpected ${functionName} boolean response.`);
  return result;
}

async function readBigInt(
  client: PublicClient,
  artifact: FoundryArtifact,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<bigint> {
  const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
  if (typeof result !== 'bigint') throw new Error(`Unexpected ${functionName} integer response.`);
  return result;
}

async function readHex(
  client: PublicClient,
  artifact: FoundryArtifact,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<Hex> {
  const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error(`Unexpected ${functionName} bytes32 response.`);
  }
  return result as Hex;
}

function assertSameAddress(label: string, actual: Address, expected: Address): void {
  if (!isAddressEqual(actual, expected)) throw new Error(`${label} does not match the manifest.`);
}

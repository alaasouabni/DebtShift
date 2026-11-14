import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  parseDebtShiftEvmDeploymentManifest,
  parseLiveMarketConfiguration,
  parsePublicTestnetRouteDependencies,
  parseTestnetMorphoDeploymentManifest,
  testnetVaultFundingManifestSchema,
} from '../packages/domain/dist/index.js';
import {
  fundTestnetLiquidityVault,
  VAULT_FUNDING_TOKEN_ABI,
  verifyProductionDebtShiftDeployment,
  verifyTestnetMorphoDeployment,
} from '../packages/protocols/dist/index.js';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

assertFundingAuthorization();

const workspaceRoot = resolve('.');
const sourceCommit = cleanSourceCommit(workspaceRoot);
const deploymentManifestPath = resolve(required('DEPLOYMENT_MANIFEST_PATH'));
const morphoManifestPath = resolve(required('TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH'));
const routePath = resolve(required('LIVE_MARKET_CONFIG_PATH'));
const dependenciesPath = resolve(
  process.env.PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH ??
    'config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json',
);
const outputPath = resolve(required('VAULT_FUNDING_MANIFEST_PATH'));
const [deploymentJson, morphoJson, routeJson, dependenciesJson] = await Promise.all([
  readFile(deploymentManifestPath, 'utf8'),
  readFile(morphoManifestPath, 'utf8'),
  readFile(routePath, 'utf8'),
  readFile(dependenciesPath, 'utf8'),
]);
const deployment = parseDebtShiftEvmDeploymentManifest(deploymentJson);
const morpho = parseTestnetMorphoDeploymentManifest(morphoJson);
const route = parseLiveMarketConfiguration(routeJson);
const dependencies = parsePublicTestnetRouteDependencies(dependenciesJson);
const routeConfigurationHash = keccak256(stringToHex(JSON.stringify(route)));
const routeDependenciesHash = keccak256(stringToHex(dependenciesJson));
const deploymentManifestHash = keccak256(stringToHex(deploymentJson));

assertManifestBindings({
  sourceCommit,
  deployment,
  morpho,
  route,
  dependencies,
  routeConfigurationHash,
  routeDependenciesHash,
});

const fundingAmount = requiredPositiveBigInt('VAULT_FUNDING_AMOUNT_UNITS');
const reviewedFundingAmount = requiredPositiveBigInt('MINIMUM_VAULT_FUNDING_UNITS');
if (fundingAmount !== reviewedFundingAmount) {
  throw new Error(
    'VAULT_FUNDING_AMOUNT_UNITS must exactly equal the reviewed MINIMUM_VAULT_FUNDING_UNITS.',
  );
}
const minimumNativeBalance = requiredPositiveBigInt('MINIMUM_VAULT_FUNDER_NATIVE_BALANCE_WEI');
const minimumMorphoLiquidity = requiredPositiveBigInt('DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS');
if (minimumMorphoLiquidity < BigInt(dependencies.destination.minimumSeedLiquidityUnits)) {
  throw new Error(
    `DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS must be at least ${dependencies.destination.minimumSeedLiquidityUnits}.`,
  );
}
const minimumExecutorNativeBalance = requiredPositiveBigInt('MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI');
const confirmations = requiredPositiveInteger('SOURCE_FINALITY_CONFIRMATIONS');
const borrower = getAddress(required('PUBLIC_TESTNET_BORROWER_ADDRESS'));
const deployer = getAddress(required('PUBLIC_TESTNET_DEPLOYER_ADDRESS'));
const funder = getAddress(required('PUBLIC_TESTNET_VAULT_FUNDER_ADDRESS'));
const executor = getAddress(required('PUBLIC_TESTNET_EXECUTOR_ADDRESS'));
assertOperationalIdentities({ borrower, deployer, funder, executor, deployment });

const sourceRpcUrl = requiredUrl('SOURCE_RPC_URL');
const destinationRpcUrl = requiredUrl('DESTINATION_RPC_URL');
const sourceClient = publicClient(
  deployment.source.chainId,
  'DebtShift testnet vault funding source',
  sourceRpcUrl,
);
const destinationClient = publicClient(
  deployment.destination.chainId,
  'DebtShift testnet vault funding destination',
  destinationRpcUrl,
);

const [morphoReport, deploymentReport] = await Promise.all([
  verifyTestnetMorphoDeployment({
    manifest: morpho,
    publicClient: destinationClient,
    expectedRouteId: deployment.routeId,
    expectedRouteDependenciesHash: routeDependenciesHash,
    minimumAvailableLiquidityUnits: minimumMorphoLiquidity,
  }),
  verifyProductionDebtShiftDeployment({
    manifest: deployment,
    sourcePublicClient: sourceClient,
    destinationPublicClient: destinationClient,
    minimumExecutorNativeBalanceWei: minimumExecutorNativeBalance,
  }),
]);
const finalizedBlock = await sourceClient.getBlock({ blockTag: 'finalized' });
const [nativeBalance, debtBalance] = await Promise.all([
  sourceClient.getBalance({ address: funder, blockNumber: finalizedBlock.number }),
  sourceClient.readContract({
    address: deployment.source.debtToken,
    abi: VAULT_FUNDING_TOKEN_ABI,
    functionName: 'balanceOf',
    args: [funder],
    blockNumber: finalizedBlock.number,
  }),
]);
if (nativeBalance < minimumNativeBalance) {
  throw new Error(
    `Vault funder has ${nativeBalance} native wei; ${minimumNativeBalance} required.`,
  );
}
if (debtBalance < fundingAmount) {
  throw new Error(`Vault funder has ${debtBalance} debt units; ${fundingAmount} required.`);
}

const account = privateKeyToAccount(requiredPrivateKey('VAULT_FUNDER_PRIVATE_KEY'));
if (account.address.toLowerCase() !== funder.toLowerCase()) {
  throw new Error('VAULT_FUNDER_PRIVATE_KEY does not derive PUBLIC_TESTNET_VAULT_FUNDER_ADDRESS.');
}
const sourceChain = chain(
  deployment.source.chainId,
  'DebtShift testnet vault funding source',
  sourceRpcUrl,
);
const wallet = createWalletClient({ account, chain: sourceChain, transport: http(sourceRpcUrl) });

await mkdir(dirname(outputPath), { recursive: true });
const manifestFile = await open(outputPath, 'wx');
let manifest;
try {
  const evidence = await fundTestnetLiquidityVault({
    publicClient: sourceClient,
    wallet,
    chainId: deployment.source.chainId,
    confirmations,
    vault: deployment.source.contracts.liquidityVault.address,
    asset: deployment.source.debtToken,
    amountUnits: fundingAmount,
  });
  manifest = testnetVaultFundingManifestSchema.parse({
    schemaVersion: 1,
    environment: 'testnet',
    createdAt: new Date().toISOString(),
    sourceCommit,
    routeId: deployment.routeId,
    routeConfigurationHash,
    routeDependenciesHash,
    evmDeploymentManifestHash: deploymentManifestHash,
    workflowWriteSwitchEnabled: false,
    chainId: deployment.source.chainId,
    confirmations,
    funder,
    vault: deployment.source.contracts.liquidityVault.address,
    asset: deployment.source.debtToken,
    amountUnits: fundingAmount.toString(),
    ...evidence,
  });
  await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
} finally {
  await manifestFile.close();
}

console.log(
  JSON.stringify({
    status: 'TESTNET_SOURCE_VAULT_FUNDED_WITH_ALLOWANCE_REVOKED',
    manifestPath: outputPath,
    deploymentManifestPath,
    morphoManifestPath,
    routePath,
    dependenciesPath,
    routeId: manifest.routeId,
    routeDependenciesHash,
    chainId: manifest.chainId,
    funder: manifest.funder,
    vault: manifest.vault,
    asset: manifest.asset,
    amountUnits: manifest.amountUnits,
    transactionHashes: [
      manifest.transactions.approveExact.transactionHash,
      manifest.transactions.deposit.transactionHash,
      manifest.transactions.revokeAllowance.transactionHash,
    ],
    morphoAvailableLiquidityUnits: morphoReport.availableLiquidityUnits,
    vaultFreeLiquidityUnits: manifest.after.vaultFreeLiquidityUnits,
    deploymentVerifiedContractCount: deploymentReport.verifiedContractCount,
    workflowWriteSwitchEnabled: false,
  }),
);

function assertFundingAuthorization() {
  if ((process.env.MAINNET_EXECUTION_ENABLED ?? 'false') !== 'false') {
    throw new Error('Testnet vault funding requires MAINNET_EXECUTION_ENABLED=false.');
  }
  if (process.env.DEBTSHIFT_DEPLOYMENT_ENVIRONMENT !== 'testnet') {
    throw new Error('Testnet vault funding requires DEBTSHIFT_DEPLOYMENT_ENVIRONMENT=testnet.');
  }
  if (process.env.DEBTSHIFT_TESTNET_VAULT_FUNDING_APPROVED !== 'true') {
    throw new Error(
      'Set DEBTSHIFT_TESTNET_VAULT_FUNDING_APPROVED=true only after reviewing the exact funder, vault, asset, amount, gas exposure, and manifests.',
    );
  }
}

function assertManifestBindings(input) {
  const { deployment, morpho, route, dependencies } = input;
  if (
    deployment.environment !== 'testnet' ||
    deployment.workflowWriteSwitchEnabled ||
    deployment.sourceCommit !== input.sourceCommit ||
    deployment.routeId !== dependencies.routeId ||
    morpho.routeId !== dependencies.routeId ||
    deployment.routeConfigurationHash.toLowerCase() !==
      input.routeConfigurationHash.toLowerCase() ||
    deployment.routeDependenciesHash?.toLowerCase() !== input.routeDependenciesHash.toLowerCase() ||
    morpho.routeDependenciesHash.toLowerCase() !== input.routeDependenciesHash.toLowerCase()
  ) {
    throw new Error(
      'Funding inputs do not bind the current commit and selected testnet manifests.',
    );
  }
  const bindings = [
    ['source chain', deployment.source.chainId, dependencies.source.chainId],
    ['destination chain', deployment.destination.chainId, dependencies.destination.chainId],
    ['Aave pool', deployment.source.protocol.pool, dependencies.source.pool],
    [
      'Aave data provider',
      deployment.source.protocol.dataProvider,
      dependencies.source.dataProvider,
    ],
    [
      'source collateral',
      deployment.source.collateralToken,
      dependencies.source.collateralAsset.address,
    ],
    ['source debt', deployment.source.debtToken, dependencies.source.debtAsset.address],
    ['route source debt', route.source.debtAsset.address, deployment.source.debtToken],
    [
      'route source collateral',
      route.source.collateralAsset.address,
      deployment.source.collateralToken,
    ],
    ['Morpho singleton', deployment.destination.protocol.morpho, morpho.contracts.morpho.address],
    ['Morpho market', deployment.destination.protocol.marketId, morpho.market.id],
    ['Morpho oracle', deployment.destination.protocol.oracle, morpho.contracts.oracle.address],
    ['destination debt', deployment.destination.debtToken, morpho.tokens.loan.address],
    [
      'destination collateral',
      deployment.destination.collateralToken,
      morpho.tokens.collateral.address,
    ],
    ['route Morpho singleton', route.destination.morpho, deployment.destination.protocol.morpho],
    ['route Morpho market', route.destination.marketId, deployment.destination.protocol.marketId],
  ];
  for (const [label, actual, expected] of bindings) {
    if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(`${label} does not match the selected testnet deployment.`);
    }
  }
}

function assertOperationalIdentities({ borrower, deployer, funder, executor, deployment }) {
  if (
    deployer.toLowerCase() !== deployment.owner.toLowerCase() ||
    executor.toLowerCase() !== deployment.executor.toLowerCase()
  ) {
    throw new Error('Reviewed deployer or executor does not match the EVM deployment manifest.');
  }
  const identities = [borrower, deployer, funder, executor].map((value) => value.toLowerCase());
  if (new Set(identities).size !== identities.length) {
    throw new Error('Borrower, deployer, vault funder, and executor must remain distinct.');
  }
}

function publicClient(chainId, name, rpcUrl) {
  return createPublicClient({
    chain: chain(chainId, name, rpcUrl),
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
  });
}

function chain(chainId, name, rpcUrl) {
  return defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function cleanSourceCommit(workspace) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('The funding source commit is not a full lowercase Git SHA-1.');
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: workspace,
    encoding: 'utf8',
  }).trim();
  if (dirty.length !== 0) throw new Error('Testnet vault funding requires a clean Git worktree.');
  return sourceCommit;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function requiredUrl(name) {
  const value = required(name);
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  return url.toString();
}

function requiredPrivateKey(name) {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte EVM key.`);
  return value;
}

function requiredPositiveBigInt(name) {
  const value = required(name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  return BigInt(value);
}

function requiredPositiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`${name} must be an integer from 1 through 1000.`);
  }
  return value;
}

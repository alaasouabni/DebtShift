import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseDebtShiftEvmDeploymentManifest,
  parseLiveMarketConfiguration,
  parsePublicTestnetRouteDependencies,
  parseTestnetMorphoDeploymentManifest,
  parseTestnetVaultFundingManifest,
} from '../packages/domain/dist/index.js';
import {
  verifyProductionDebtShiftDeployment,
  verifyTestnetLiquidityVaultFunding,
  verifyTestnetMorphoDeployment,
} from '../packages/protocols/dist/index.js';
import { createPublicClient, defineChain, getAddress, http, keccak256, stringToHex } from 'viem';

assertReadOnlyEnvironment();

const deploymentManifestPath = resolve(required('DEPLOYMENT_MANIFEST_PATH'));
const morphoManifestPath = resolve(required('TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH'));
const fundingManifestPath = resolve(required('VAULT_FUNDING_MANIFEST_PATH'));
const routePath = resolve(required('LIVE_MARKET_CONFIG_PATH'));
const dependenciesPath = resolve(
  process.env.PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH ??
    'config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json',
);
const [deploymentJson, morphoJson, fundingJson, routeJson, dependenciesJson] = await Promise.all([
  readFile(deploymentManifestPath, 'utf8'),
  readFile(morphoManifestPath, 'utf8'),
  readFile(fundingManifestPath, 'utf8'),
  readFile(routePath, 'utf8'),
  readFile(dependenciesPath, 'utf8'),
]);
const deployment = parseDebtShiftEvmDeploymentManifest(deploymentJson);
const morpho = parseTestnetMorphoDeploymentManifest(morphoJson);
const funding = parseTestnetVaultFundingManifest(fundingJson);
const route = parseLiveMarketConfiguration(routeJson);
const dependencies = parsePublicTestnetRouteDependencies(dependenciesJson);
const routeConfigurationHash = keccak256(stringToHex(JSON.stringify(route)));
const routeDependenciesHash = keccak256(stringToHex(dependenciesJson));
const deploymentManifestHash = keccak256(stringToHex(deploymentJson));
const expectedFundingAmount = requiredPositiveBigInt('VAULT_FUNDING_AMOUNT_UNITS');
const reviewedFundingAmount = requiredPositiveBigInt('MINIMUM_VAULT_FUNDING_UNITS');
const expectedConfirmations = requiredPositiveInteger('SOURCE_FINALITY_CONFIRMATIONS');
const expectedFunder = getAddress(required('PUBLIC_TESTNET_VAULT_FUNDER_ADDRESS'));
const minimumMorphoLiquidity = requiredPositiveBigInt('DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS');
if (minimumMorphoLiquidity < BigInt(dependencies.destination.minimumSeedLiquidityUnits)) {
  throw new Error(
    `DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS must be at least ${dependencies.destination.minimumSeedLiquidityUnits}.`,
  );
}
const minimumExecutorNativeBalance = requiredPositiveBigInt('MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI');

if (expectedFundingAmount !== reviewedFundingAmount) {
  throw new Error(
    'VAULT_FUNDING_AMOUNT_UNITS must exactly equal the reviewed MINIMUM_VAULT_FUNDING_UNITS.',
  );
}
assertManifestBindings({
  deployment,
  morpho,
  funding,
  route,
  dependencies,
  routeConfigurationHash,
  routeDependenciesHash,
  deploymentManifestHash,
  expectedFundingAmount,
  expectedConfirmations,
  expectedFunder,
});
assertOperationalIdentities(deployment, expectedFunder);

const sourceRpcUrl = requiredUrl('SOURCE_RPC_URL');
const destinationRpcUrl = requiredUrl('DESTINATION_RPC_URL');
const sourceClient = publicClient(
  deployment.source.chainId,
  'DebtShift testnet vault funding verification source',
  sourceRpcUrl,
);
const destinationClient = publicClient(
  deployment.destination.chainId,
  'DebtShift testnet vault funding verification destination',
  destinationRpcUrl,
);
const [morphoReport, deploymentReport, fundingReport] = await Promise.all([
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
    minimumVaultFreeLiquidityUnits: expectedFundingAmount,
    minimumExecutorNativeBalanceWei: minimumExecutorNativeBalance,
  }),
  verifyTestnetLiquidityVaultFunding({ manifest: funding, publicClient: sourceClient }),
]);

console.log(
  JSON.stringify(
    {
      status: 'TESTNET_SOURCE_VAULT_FUNDING_READY',
      deploymentManifestPath,
      morphoManifestPath,
      fundingManifestPath,
      routePath,
      dependenciesPath,
      routeId: funding.routeId,
      routeConfigurationHash,
      routeDependenciesHash,
      deploymentManifestHash,
      funder: funding.funder,
      vault: funding.vault,
      asset: funding.asset,
      morphoReport,
      deploymentReport,
      fundingReport,
      workflowWriteSwitchEnabled: false,
    },
    null,
    2,
  ),
);

function assertReadOnlyEnvironment() {
  if ((process.env.MAINNET_EXECUTION_ENABLED ?? 'false') !== 'false') {
    throw new Error(
      'Read-only testnet vault verification requires MAINNET_EXECUTION_ENABLED=false.',
    );
  }
  if (process.env.DEBTSHIFT_DEPLOYMENT_ENVIRONMENT !== 'testnet') {
    throw new Error(
      'Read-only testnet vault verification requires DEBTSHIFT_DEPLOYMENT_ENVIRONMENT=testnet.',
    );
  }
}

function assertManifestBindings(input) {
  const { deployment, morpho, funding, route, dependencies } = input;
  if (
    deployment.environment !== 'testnet' ||
    deployment.workflowWriteSwitchEnabled ||
    funding.workflowWriteSwitchEnabled ||
    deployment.sourceCommit !== funding.sourceCommit ||
    deployment.routeId !== dependencies.routeId ||
    morpho.routeId !== dependencies.routeId ||
    funding.routeId !== dependencies.routeId ||
    deployment.routeConfigurationHash.toLowerCase() !==
      input.routeConfigurationHash.toLowerCase() ||
    funding.routeConfigurationHash.toLowerCase() !== input.routeConfigurationHash.toLowerCase() ||
    deployment.routeDependenciesHash?.toLowerCase() !== input.routeDependenciesHash.toLowerCase() ||
    morpho.routeDependenciesHash.toLowerCase() !== input.routeDependenciesHash.toLowerCase() ||
    funding.routeDependenciesHash.toLowerCase() !== input.routeDependenciesHash.toLowerCase() ||
    funding.evmDeploymentManifestHash.toLowerCase() !==
      input.deploymentManifestHash.toLowerCase() ||
    funding.amountUnits !== input.expectedFundingAmount.toString() ||
    funding.confirmations !== input.expectedConfirmations ||
    funding.funder.toLowerCase() !== input.expectedFunder.toLowerCase() ||
    funding.chainId !== deployment.source.chainId ||
    funding.vault.toLowerCase() !==
      deployment.source.contracts.liquidityVault.address.toLowerCase() ||
    funding.asset.toLowerCase() !== deployment.source.debtToken.toLowerCase()
  ) {
    throw new Error('Funding evidence does not bind the selected route and deployment manifests.');
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

function assertOperationalIdentities(deployment, funder) {
  const borrower = getAddress(required('PUBLIC_TESTNET_BORROWER_ADDRESS'));
  const deployer = getAddress(required('PUBLIC_TESTNET_DEPLOYER_ADDRESS'));
  const executor = getAddress(required('PUBLIC_TESTNET_EXECUTOR_ADDRESS'));
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
  const chain = defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
  });
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

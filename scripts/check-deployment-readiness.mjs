import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseDebtShiftEvmDeploymentManifest,
  parseLiveMarketConfiguration,
  parsePublicTestnetRouteDependencies,
  parseTestnetMorphoDeploymentManifest,
} from '../packages/domain/dist/index.js';
import {
  verifyProductionDebtShiftDeployment,
  verifyTestnetMorphoDeployment,
} from '../packages/protocols/dist/index.js';
import { createPublicClient, defineChain, http, keccak256, stringToHex } from 'viem';

if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
  throw new Error('Read-only deployment readiness requires MAINNET_EXECUTION_ENABLED=false.');
}
const manifestPath = resolve(required('DEPLOYMENT_MANIFEST_PATH'));
const routePath = resolve(
  process.env.LIVE_MARKET_CONFIG_PATH ??
    'config/routes/base-aave-v3-to-arbitrum-morpho-blue.v1.json',
);
const [manifestJson, routeJson] = await Promise.all([
  readFile(manifestPath, 'utf8'),
  readFile(routePath, 'utf8'),
]);
const manifest = parseDebtShiftEvmDeploymentManifest(manifestJson);
const route = parseLiveMarketConfiguration(routeJson);
const routeHash = keccak256(stringToHex(JSON.stringify(route)));
if (manifest.routeConfigurationHash !== routeHash) {
  throw new Error('Deployment manifest route hash does not match the selected route file.');
}
assertRouteBindings(manifest, route);
const testnetDependency = await loadTestnetDependency(manifest);

const sourceRpcUrl = requiredUrl('SOURCE_RPC_URL');
const destinationRpcUrl = requiredUrl('DESTINATION_RPC_URL');
const sourceClient = publicClient(
  manifest.source.chainId,
  'DebtShift source readiness',
  sourceRpcUrl,
);
const destinationClient = publicClient(
  manifest.destination.chainId,
  'DebtShift destination readiness',
  destinationRpcUrl,
);
const testnetMorphoReport =
  testnetDependency === null
    ? null
    : await verifyTestnetMorphoDeployment({
        manifest: testnetDependency.morphoManifest,
        publicClient: destinationClient,
        expectedRouteId: manifest.routeId,
        expectedRouteDependenciesHash: testnetDependency.routeDependenciesHash,
      });
const report = await verifyProductionDebtShiftDeployment({
  manifest,
  sourcePublicClient: sourceClient,
  destinationPublicClient: destinationClient,
  minimumVaultFreeLiquidityUnits: optionalUnsignedInteger('MINIMUM_VAULT_FREE_LIQUIDITY_UNITS'),
  minimumExecutorNativeBalanceWei: optionalUnsignedInteger('MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI'),
});
console.log(
  JSON.stringify({
    status: 'WRITE_DISABLED_DEPLOYMENT_READY',
    manifestPath,
    routePath,
    routeConfigurationHash: routeHash,
    routeDependenciesHash: manifest.routeDependenciesHash,
    testnetMorphoReport,
    ...report,
  }),
);

async function loadTestnetDependency(manifest) {
  if (manifest.environment !== 'testnet') return null;
  const morphoManifestPath = resolve(required('TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH'));
  const routeDependenciesPath = resolve(
    process.env.PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH ??
      'config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json',
  );
  const [morphoManifestJson, routeDependenciesJson] = await Promise.all([
    readFile(morphoManifestPath, 'utf8'),
    readFile(routeDependenciesPath, 'utf8'),
  ]);
  const morphoManifest = parseTestnetMorphoDeploymentManifest(morphoManifestJson);
  const routeDependencies = parsePublicTestnetRouteDependencies(routeDependenciesJson);
  const routeDependenciesHash = keccak256(stringToHex(routeDependenciesJson));
  if (
    manifest.routeDependenciesHash === null ||
    manifest.routeId !== routeDependencies.routeId ||
    morphoManifest.routeId !== routeDependencies.routeId ||
    manifest.routeDependenciesHash.toLowerCase() !== routeDependenciesHash.toLowerCase() ||
    morphoManifest.routeDependenciesHash.toLowerCase() !== routeDependenciesHash.toLowerCase() ||
    manifest.source.chainId !== routeDependencies.source.chainId ||
    manifest.destination.chainId !== routeDependencies.destination.chainId ||
    manifest.destination.protocol.morpho.toLowerCase() !==
      morphoManifest.contracts.morpho.address.toLowerCase() ||
    manifest.destination.protocol.marketId.toLowerCase() !== morphoManifest.market.id.toLowerCase()
  ) {
    throw new Error('Deployment manifests do not bind the selected testnet dependencies.');
  }
  return { morphoManifest, routeDependenciesHash, morphoManifestPath, routeDependenciesPath };
}

function assertRouteBindings(manifest, route) {
  const equal = (left, right) => left.toLowerCase() === right.toLowerCase();
  const bindings = [
    ['Aave pool', manifest.source.protocol.pool, route.source.pool],
    ['Aave data provider', manifest.source.protocol.dataProvider, route.source.dataProvider],
    ['source collateral', manifest.source.collateralToken, route.source.collateralAsset.address],
    ['source debt', manifest.source.debtToken, route.source.debtAsset.address],
    ['Morpho singleton', manifest.destination.protocol.morpho, route.destination.morpho],
    ['Morpho market', manifest.destination.protocol.marketId, route.destination.marketId],
    [
      'destination collateral',
      manifest.destination.collateralToken,
      route.destination.collateralAsset.address,
    ],
    ['destination debt', manifest.destination.debtToken, route.destination.debtAsset.address],
    ['Morpho oracle', manifest.destination.protocol.oracle, route.destination.morphoOracle],
  ];
  for (const [label, actual, expected] of bindings) {
    if (!equal(actual, expected)) throw new Error(`${label} does not match the selected route.`);
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

function optionalUnsignedInteger(name) {
  const value = process.env[name]?.trim() ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be an unsigned base-10 integer.`);
  }
  return BigInt(value);
}

import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  debtShiftEvmDeploymentManifestSchema,
  parsePublicTestnetRouteDependencies,
  parseLiveMarketConfiguration,
  parseTestnetMorphoDeploymentManifest,
} from '../packages/domain/dist/index.js';
import {
  deployProductionDebtShift,
  MORPHO_BLUE_READ_ABI,
  readAaveReserveTokenAddresses,
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

assertDeploymentAuthorization();

const workspaceRoot = resolve('.');
const sourceCommit = cleanSourceCommit(workspaceRoot);
const environment = requiredEnum('DEBTSHIFT_DEPLOYMENT_ENVIRONMENT', ['testnet', 'mainnet']);
const sourceRpcUrl = requiredUrl('SOURCE_RPC_URL');
const destinationRpcUrl = requiredUrl('DESTINATION_RPC_URL');
const sourceChainId = requiredPositiveInteger('SOURCE_CHAIN_ID');
const destinationChainId = requiredPositiveInteger('DESTINATION_CHAIN_ID');
const sourceConfirmations = optionalPositiveInteger('SOURCE_FINALITY_CONFIRMATIONS', 1);
const destinationConfirmations = optionalPositiveInteger('DESTINATION_FINALITY_CONFIRMATIONS', 1);
const routePath = resolve(
  process.env.LIVE_MARKET_CONFIG_PATH ??
    'config/routes/base-aave-v3-to-arbitrum-morpho-blue.v1.json',
);
const outputPath = resolve(
  process.env.DEPLOYMENT_MANIFEST_PATH ??
    `deployment/manifests/${environment}-${new Date().toISOString().replaceAll(':', '-')}.json`,
);
const routeJson = await readFile(routePath, 'utf8');
const route = parseLiveMarketConfiguration(routeJson);
const testnetDependency = await loadTestnetDependency(environment);
const routeId = selectedRouteId(environment, testnetDependency);
const routeDependenciesHash = testnetDependency?.routeDependenciesHash ?? null;
const account = privateKeyToAccount(requiredPrivateKey('DEPLOYER_PRIVATE_KEY'));
const owner = getAddress(process.env.DEPLOYMENT_OWNER ?? account.address);
const executor = getAddress(required('EXECUTOR_ADDRESS'));
if (owner !== account.address) {
  throw new Error(
    'DEPLOYMENT_OWNER must equal the deployment signer until contract configuration is complete.',
  );
}

const sourceChain = chain(sourceChainId, 'DebtShift source deployment', sourceRpcUrl);
const destinationChain = chain(
  destinationChainId,
  'DebtShift destination deployment',
  destinationRpcUrl,
);
const sourcePublic = createPublicClient({
  chain: sourceChain,
  transport: http(sourceRpcUrl, { timeout: 20_000, retryCount: 2 }),
});
const destinationPublic = createPublicClient({
  chain: destinationChain,
  transport: http(destinationRpcUrl, { timeout: 20_000, retryCount: 2 }),
});
const sourceWallet = createWalletClient({
  account,
  chain: sourceChain,
  transport: http(sourceRpcUrl),
});
const destinationWallet = createWalletClient({
  account,
  chain: destinationChain,
  transport: http(destinationRpcUrl),
});

const [
  actualSourceChainId,
  actualDestinationChainId,
  collateralReserveTokens,
  debtReserveTokens,
  rawMarketParams,
] = await Promise.all([
  sourcePublic.getChainId(),
  destinationPublic.getChainId(),
  readAaveReserveTokenAddresses(
    sourcePublic,
    route.source.dataProvider,
    route.source.collateralAsset.address,
  ),
  readAaveReserveTokenAddresses(
    sourcePublic,
    route.source.dataProvider,
    route.source.debtAsset.address,
  ),
  destinationPublic.readContract({
    address: route.destination.morpho,
    abi: MORPHO_BLUE_READ_ABI,
    functionName: 'idToMarketParams',
    args: [route.destination.marketId],
  }),
]);
if (actualSourceChainId !== sourceChainId || actualDestinationChainId !== destinationChainId) {
  throw new Error(
    `Deployment RPC chain mismatch: expected ${sourceChainId}/${destinationChainId}, received ${actualSourceChainId}/${actualDestinationChainId}.`,
  );
}
if (testnetDependency !== null) {
  assertTestnetDependencyBindings(testnetDependency, route, sourceChainId, destinationChainId);
  await verifyTestnetMorphoDeployment({
    manifest: testnetDependency.morphoManifest,
    publicClient: destinationPublic,
    expectedRouteId: routeId,
    expectedRouteDependenciesHash: testnetDependency.routeDependenciesHash,
  });
}
const marketParams = {
  loanToken: getAddress(rawMarketParams[0]),
  collateralToken: getAddress(rawMarketParams[1]),
  oracle: getAddress(rawMarketParams[2]),
  irm: getAddress(rawMarketParams[3]),
  lltv: rawMarketParams[4],
};

await mkdir(dirname(outputPath), { recursive: true });
const manifestFile = await open(outputPath, 'wx');
let manifest;
try {
  manifest = debtShiftEvmDeploymentManifestSchema.parse(
    await deployProductionDebtShift({
      environment,
      routeId,
      routeConfigurationHash: keccak256(stringToHex(JSON.stringify(route))),
      routeDependenciesHash,
      sourceCommit,
      owner,
      executor,
      source: {
        publicClient: sourcePublic,
        wallet: sourceWallet,
        chainId: sourceChainId,
        confirmations: sourceConfirmations,
        pool: route.source.pool,
        dataProvider: route.source.dataProvider,
        aToken: collateralReserveTokens.aToken,
        variableDebtToken: debtReserveTokens.variableDebtToken,
        collateralToken: route.source.collateralAsset.address,
        debtToken: route.source.debtAsset.address,
      },
      destination: {
        publicClient: destinationPublic,
        wallet: destinationWallet,
        chainId: destinationChainId,
        confirmations: destinationConfirmations,
        morpho: route.destination.morpho,
        expectedMarketId: route.destination.marketId,
        marketParams,
      },
    }),
  );
  await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
} finally {
  await manifestFile.close();
}
console.log(
  JSON.stringify({
    status: 'DEPLOYED_WITH_WORKFLOW_WRITES_DISABLED',
    environment,
    manifestPath: outputPath,
    sourceChainId,
    destinationChainId,
    sourceAdapter: manifest.source.contracts.sourceAdapter.address,
    destinationAdapter: manifest.destination.contracts.destinationAdapter.address,
    routeDependenciesHash: manifest.routeDependenciesHash,
  }),
);

async function loadTestnetDependency(environment) {
  if (environment !== 'testnet') return null;
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
    morphoManifest.routeId !== routeDependencies.routeId ||
    morphoManifest.routeDependenciesHash.toLowerCase() !== routeDependenciesHash.toLowerCase()
  ) {
    throw new Error('Testnet Morpho manifest does not bind the selected route dependencies.');
  }
  return {
    morphoManifest,
    routeDependencies,
    routeDependenciesHash,
    morphoManifestPath,
    routeDependenciesPath,
  };
}

function selectedRouteId(environment, testnetDependency) {
  const requested = process.env.DEBTSHIFT_ROUTE_ID?.trim();
  if (environment === 'testnet') {
    if (requested !== undefined && requested !== testnetDependency.morphoManifest.routeId) {
      throw new Error('DEBTSHIFT_ROUTE_ID does not match the reviewed testnet dependency route.');
    }
    return testnetDependency.morphoManifest.routeId;
  }
  return requested ?? 'base-aave-v3-weth-usdc-to-arbitrum-morpho-blue-weth-usdc-v1';
}

function assertTestnetDependencyBindings(dependency, route, sourceChainId, destinationChainId) {
  const { morphoManifest, routeDependencies } = dependency;
  if (
    sourceChainId !== routeDependencies.source.chainId ||
    destinationChainId !== routeDependencies.destination.chainId
  ) {
    throw new Error('Deployment chain IDs do not match the reviewed testnet dependencies.');
  }
  const bindings = [
    ['Aave pool', route.source.pool, routeDependencies.source.pool],
    ['Aave data provider', route.source.dataProvider, routeDependencies.source.dataProvider],
    [
      'source collateral',
      route.source.collateralAsset.address,
      routeDependencies.source.collateralAsset.address,
    ],
    ['source debt', route.source.debtAsset.address, routeDependencies.source.debtAsset.address],
    ['Morpho singleton', route.destination.morpho, morphoManifest.contracts.morpho.address],
    ['Morpho market', route.destination.marketId, morphoManifest.market.id],
    ['Morpho oracle', route.destination.morphoOracle, morphoManifest.contracts.oracle.address],
    [
      'destination collateral',
      route.destination.collateralAsset.address,
      routeDependencies.destination.collateralAsset.address,
    ],
    [
      'destination debt',
      route.destination.debtAsset.address,
      routeDependencies.destination.loanAsset.address,
    ],
    [
      'manifested Morpho collateral',
      morphoManifest.tokens.collateral.address,
      routeDependencies.destination.collateralAsset.address,
    ],
    [
      'manifested Morpho debt',
      morphoManifest.tokens.loan.address,
      routeDependencies.destination.loanAsset.address,
    ],
    [
      'manifested collateral feed',
      morphoManifest.feeds.collateral.address,
      routeDependencies.destination.collateralFeed.address,
    ],
    [
      'manifested loan feed',
      morphoManifest.feeds.loan.address,
      routeDependencies.destination.loanFeed.address,
    ],
  ];
  for (const [label, actual, expected] of bindings) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label} does not match the reviewed testnet dependency.`);
    }
  }
  const reviewedFeeds = new Map([
    [
      routeDependencies.destination.collateralFeed.address.toLowerCase(),
      routeDependencies.destination.collateralFeed.maximumAgeSeconds,
    ],
    [
      routeDependencies.destination.loanFeed.address.toLowerCase(),
      routeDependencies.destination.loanFeed.maximumAgeSeconds,
    ],
  ]);
  if (
    route.destination.morphoOracleFeeds.length !== reviewedFeeds.size ||
    route.destination.morphoOracleFeeds.some(
      ({ address, maximumAgeSeconds }) =>
        reviewedFeeds.get(address.toLowerCase()) !== maximumAgeSeconds,
    )
  ) {
    throw new Error('Morpho oracle feeds do not match the reviewed testnet dependencies.');
  }
  const priceBindings = [
    [
      'source collateral price',
      route.prices.sourceCollateralUsd,
      routeDependencies.source.collateralFeed,
    ],
    ['source debt price', route.prices.sourceDebtUsd, routeDependencies.source.debtFeed],
    ['source native price', route.prices.sourceNativeUsd, routeDependencies.source.collateralFeed],
    [
      'destination collateral price',
      route.prices.destinationCollateralUsd,
      routeDependencies.destination.collateralFeed,
    ],
    [
      'destination debt price',
      route.prices.destinationDebtUsd,
      routeDependencies.destination.loanFeed,
    ],
    [
      'destination native price',
      route.prices.destinationNativeUsd,
      routeDependencies.destination.collateralFeed,
    ],
  ];
  for (const [label, actual, expected] of priceBindings) {
    if (
      actual.address.toLowerCase() !== expected.address.toLowerCase() ||
      actual.maximumAgeSeconds !== expected.maximumAgeSeconds
    ) {
      throw new Error(`${label} does not match the reviewed testnet dependencies.`);
    }
  }
  if (
    route.source.sequencerUptimeFeed !== undefined ||
    route.destination.sequencerUptimeFeed !== undefined
  ) {
    throw new Error('Testnet route sequencer policy does not match the reviewed dependencies.');
  }
  if (
    morphoManifest.market.lltv !== routeDependencies.destination.lltv ||
    morphoManifest.feeds.collateralMaxPriceAgeSeconds !==
      routeDependencies.destination.collateralFeed.maximumAgeSeconds.toString() ||
    morphoManifest.feeds.loanMaxPriceAgeSeconds !==
      routeDependencies.destination.loanFeed.maximumAgeSeconds.toString() ||
    morphoManifest.feeds.sequencerUptime !== routeDependencies.destination.sequencerUptimeFeed ||
    morphoManifest.feeds.sequencerGracePeriodSeconds !==
      routeDependencies.destination.sequencerGracePeriodSeconds.toString()
  ) {
    throw new Error('Morpho market policy does not match the reviewed testnet dependencies.');
  }
}

function assertDeploymentAuthorization() {
  if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
    throw new Error('Contract deployment requires MAINNET_EXECUTION_ENABLED=false.');
  }
  if (process.env.DEBTSHIFT_DEPLOYMENT_APPROVED !== 'true') {
    throw new Error(
      'Set DEBTSHIFT_DEPLOYMENT_APPROVED=true only after reviewing the exact chains.',
    );
  }
  if (
    process.env.DEBTSHIFT_DEPLOYMENT_ENVIRONMENT === 'mainnet' &&
    process.env.MAINNET_CONTRACT_DEPLOYMENT_CONFIRMATION !==
      'DEPLOY_DEBTSHIFT_MAINNET_CONTRACTS_WITH_WRITES_DISABLED'
  ) {
    throw new Error(
      'Mainnet contract deployment requires the exact out-of-band confirmation value.',
    );
  }
}

function cleanSourceCommit(workspace) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('The deployment source commit is not a full Git SHA-1.');
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: workspace,
    encoding: 'utf8',
  }).trim();
  if (dirty.length !== 0) {
    throw new Error('EVM deployment requires a clean Git worktree.');
  }
  return sourceCommit;
}

function chain(id, name, rpcUrl) {
  return defineChain({
    id,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function requiredEnum(name, values) {
  const value = required(name);
  if (!values.includes(value)) throw new Error(`${name} must be one of ${values.join(', ')}.`);
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

function requiredPositiveInteger(name) {
  return parsePositiveInteger(name, required(name));
}

function optionalPositiveInteger(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : parsePositiveInteger(name, value);
}

function parsePositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

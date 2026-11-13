import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parsePublicTestnetRouteDependencies } from '../packages/domain/dist/index.js';
import {
  AAVE_DATA_PROVIDER_ABI,
  CHAINLINK_AGGREGATOR_V3_ABI,
  ChainlinkPriceReader,
  ERC20_METADATA_ABI,
  readAaveReserveTokenAddresses,
} from '../packages/protocols/dist/index.js';
import { createPublicClient, getAddress, http, isAddressEqual, keccak256, stringToHex } from 'viem';

const ROUTE_PATH = new URL(
  '../config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json',
  import.meta.url,
);
const ETHEREUM_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const MAX_REFERENCE_BYTES = 25_000_000;

const ADDRESS_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'pool', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPriceOracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'oracle', type: 'address' }],
  },
];
const AAVE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getAssetPrice',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'price', type: 'uint256' }],
  },
];
const RESERVE_TOKEN_ABI = [
  {
    type: 'function',
    name: 'UNDERLYING_ASSET_ADDRESS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'asset', type: 'address' }],
  },
];
const BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
];

if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
  throw new Error('Public-testnet route validation requires MAINNET_EXECUTION_ENABLED=false.');
}

const routeJson = await readFile(ROUTE_PATH, 'utf8');
const route = parsePublicTestnetRouteDependencies(routeJson);
const routeDependenciesHash = keccak256(stringToHex(routeJson));
const sourceRpcUrl = validatedRpcUrl(
  process.env.ETHEREUM_SEPOLIA_READ_RPC_URL ?? ETHEREUM_SEPOLIA_RPC,
  'ETHEREUM_SEPOLIA_READ_RPC_URL',
);
const destinationRpcUrl = validatedRpcUrl(
  process.env.BASE_SEPOLIA_READ_RPC_URL ?? BASE_SEPOLIA_RPC,
  'BASE_SEPOLIA_READ_RPC_URL',
);

const [provenance, sourceEvidence, destinationEvidence] = await Promise.all([
  verifyOfficialProvenance(route),
  inspectSource(route, sourceRpcUrl),
  inspectDestination(route, destinationRpcUrl),
]);

console.log(
  JSON.stringify(
    {
      routeId: route.routeId,
      routeDependenciesHash,
      environment: route.environment,
      status: route.status,
      workflowWriteSwitchEnabled: route.workflowWriteSwitchEnabled,
      checkedAt: new Date().toISOString(),
      provenance,
      source: sourceEvidence,
      destination: destinationEvidence,
      transport: route.transport,
      deploymentReady: false,
      remainingDeploymentInputs: [
        'funded source borrower signer and Aave Sepolia position',
        'funded Base Sepolia deployer/owner and real Circle test USDC seed liquidity',
        'reviewed canonical Morpho and DebtShift deployment manifests',
      ],
    },
    null,
    2,
  ),
);

async function verifyOfficialProvenance(configuration) {
  const manifestDocument = await fetchDocument(configuration.source.addressBook.manifestUrl);
  const manifest = parseJsonObject(manifestDocument.text, 'Aave address-book manifest');
  assertEqual('Aave address-book commit', manifest.commit, configuration.source.addressBook.commit);
  const aggregate = requireObject(manifest.aggregate, 'Aave address-book aggregate');
  assertEqual(
    'Aave address-book aggregate SHA-256',
    aggregate.sha256,
    configuration.source.addressBook.aggregateSha256,
  );
  if (!Array.isArray(manifest.modules)) throw new Error('Aave manifest modules are missing.');
  const moduleRecord = manifest.modules.find(
    (candidate) =>
      isRecord(candidate) && candidate.name === configuration.source.addressBook.moduleName,
  );
  if (!isRecord(moduleRecord)) throw new Error('Aave Sepolia module is missing from the manifest.');
  assertEqual(
    'Aave Sepolia module SHA-256',
    moduleRecord.sha256,
    configuration.source.addressBook.moduleSha256,
  );
  assertEqual(
    'Aave Sepolia module byte length',
    moduleRecord.bytes,
    configuration.source.addressBook.moduleBytes,
  );
  if (typeof moduleRecord.path !== 'string') throw new Error('Aave module path is invalid.');
  const moduleUrl = new URL(moduleRecord.path, configuration.source.addressBook.manifestUrl);
  const moduleDocument = await fetchDocument(moduleUrl.toString());
  assertEqual(
    'Aave Sepolia downloaded module SHA-256',
    moduleDocument.sha256,
    configuration.source.addressBook.moduleSha256,
  );
  assertEqual(
    'Aave Sepolia downloaded module byte length',
    moduleDocument.bytes,
    configuration.source.addressBook.moduleBytes,
  );
  const module = parseJsonObject(moduleDocument.text, 'Aave Sepolia module');
  verifyAaveModule(module, configuration.source);

  const [baseDocs, circleDocs, chainlinkDirectory, chainlinkRegistry, sequencerDocs] =
    await Promise.all([
      fetchDocument(configuration.destination.references.baseContractsUrl),
      fetchDocument(configuration.destination.references.circleUsdcUrl),
      fetchDocument(configuration.destination.references.chainlinkDirectoryUrl),
      fetchDocument(configuration.destination.references.chainlinkRegistryUrl),
      fetchDocument(configuration.destination.references.chainlinkSequencerFeedsUrl),
    ]);
  assertDocumentContains(
    'Base Sepolia WETH documentation',
    baseDocs.text,
    configuration.destination.collateralAsset.address,
  );
  assertDocumentContains(
    'Circle Base Sepolia USDC documentation',
    circleDocs.text,
    configuration.destination.loanAsset.address,
  );
  assertDocumentContains(
    'Chainlink Base Sepolia registry binding',
    chainlinkDirectory.text,
    configuration.destination.references.chainlinkRegistryUrl,
  );
  assertDocumentContains(
    'Chainlink Base Sepolia network binding',
    chainlinkDirectory.text,
    'Base Sepolia testnet',
  );
  if (/Base Sepolia/i.test(sequencerDocs.text)) {
    throw new Error(
      'Chainlink now lists Base Sepolia in its sequencer-feed documentation; review the null policy.',
    );
  }
  const registry = parseJsonArray(chainlinkRegistry.text, 'Chainlink Base Sepolia registry');
  verifyRegistryFeed(registry, configuration.destination.collateralFeed);
  verifyRegistryFeed(registry, configuration.destination.loanFeed);

  return {
    aaveAddressBook: {
      commit: configuration.source.addressBook.commit,
      manifestResponseSha256: manifestDocument.sha256,
      aggregateSha256: configuration.source.addressBook.aggregateSha256,
      moduleSha256: moduleDocument.sha256,
      moduleBytes: moduleDocument.bytes,
    },
    baseContractsResponseSha256: baseDocs.sha256,
    circleUsdcResponseSha256: circleDocs.sha256,
    chainlinkDirectoryResponseSha256: chainlinkDirectory.sha256,
    chainlinkRegistryResponseSha256: chainlinkRegistry.sha256,
    chainlinkSequencerDocumentationResponseSha256: sequencerDocs.sha256,
    baseSepoliaSequencerFeedListed: false,
  };
}

async function inspectSource(configuration, rpcUrl) {
  const source = configuration.source;
  const client = publicClient(source.chainId, source.network, rpcUrl);
  const [chainId, block] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: 'finalized' }),
  ]);
  assertEqual('Ethereum Sepolia RPC chain ID', chainId, source.chainId);
  if (block.hash === null) {
    throw new Error('Ethereum Sepolia finalized block has no canonical hash.');
  }
  const blockNumber = block.number;

  const [providerPool, providerOracle, collateral, debt, contracts] = await Promise.all([
    client.readContract({
      address: source.poolAddressesProvider,
      abi: ADDRESS_PROVIDER_ABI,
      functionName: 'getPool',
      blockNumber,
    }),
    client.readContract({
      address: source.poolAddressesProvider,
      abi: ADDRESS_PROVIDER_ABI,
      functionName: 'getPriceOracle',
      blockNumber,
    }),
    inspectAaveReserve(client, source, source.collateralAsset, blockNumber, 'collateral'),
    inspectAaveReserve(client, source, source.debtAsset, blockNumber, 'debt'),
    inspectContracts(
      client,
      [
        source.pool,
        source.poolAddressesProvider,
        source.dataProvider,
        source.oracle,
        source.faucet,
        source.collateralAsset.address,
        source.collateralAsset.aToken,
        source.collateralAsset.variableDebtToken,
        source.collateralAsset.oracle,
        source.debtAsset.address,
        source.debtAsset.aToken,
        source.debtAsset.variableDebtToken,
        source.debtAsset.oracle,
      ],
      blockNumber,
    ),
  ]);
  assertAddress('Aave provider pool', providerPool, source.pool);
  assertAddress('Aave provider oracle', providerOracle, source.oracle);
  if (debt.availableLiquidityUnits <= 0n) {
    throw new Error('Aave Sepolia debt reserve has no available test liquidity.');
  }

  return {
    chainId,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    blockTimestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
    pool: getAddress(source.pool),
    poolAddressesProvider: getAddress(source.poolAddressesProvider),
    oracle: getAddress(source.oracle),
    collateral: serializeBigInts(collateral),
    debt: serializeBigInts(debt),
    contracts,
  };
}

async function inspectAaveReserve(client, source, asset, blockNumber, role) {
  const reserveTokens = await readAaveReserveTokenAddresses(
    client,
    source.dataProvider,
    asset.address,
    blockNumber,
  );
  assertAddress(`${role} aToken`, reserveTokens.aToken, asset.aToken);
  assertAddress(
    `${role} variable debt token`,
    reserveTokens.variableDebtToken,
    asset.variableDebtToken,
  );
  const [metadata, configuration, paused, reserveData, price, aTokenUnderlying, debtUnderlying] =
    await Promise.all([
      readTokenMetadata(client, asset.address, blockNumber),
      client.readContract({
        address: source.dataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: 'getReserveConfigurationData',
        args: [asset.address],
        blockNumber,
      }),
      client.readContract({
        address: source.dataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: 'getPaused',
        args: [asset.address],
        blockNumber,
      }),
      client.readContract({
        address: source.dataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: 'getReserveData',
        args: [asset.address],
        blockNumber,
      }),
      client.readContract({
        address: source.oracle,
        abi: AAVE_ORACLE_ABI,
        functionName: 'getAssetPrice',
        args: [asset.address],
        blockNumber,
      }),
      client.readContract({
        address: asset.aToken,
        abi: RESERVE_TOKEN_ABI,
        functionName: 'UNDERLYING_ASSET_ADDRESS',
        blockNumber,
      }),
      client.readContract({
        address: asset.variableDebtToken,
        abi: RESERVE_TOKEN_ABI,
        functionName: 'UNDERLYING_ASSET_ADDRESS',
        blockNumber,
      }),
    ]);
  assertEqual(`${role} token decimals`, metadata.decimals, asset.decimals);
  assertEqual(`${role} token symbol`, metadata.symbol, asset.symbol);
  assertAddress(`${role} aToken underlying`, aTokenUnderlying, asset.address);
  assertAddress(`${role} debt-token underlying`, debtUnderlying, asset.address);
  const [
    configuredDecimals,
    ltv,
    liquidationThreshold,
    liquidationBonus,
    reserveFactor,
    usageAsCollateralEnabled,
    borrowingEnabled,
    stableBorrowRateEnabled,
    isActive,
    isFrozen,
  ] = configuration;
  assertEqual(`${role} configured decimals`, Number(configuredDecimals), asset.decimals);
  if (!isActive || isFrozen || paused) {
    throw new Error(`Aave Sepolia ${role} reserve is inactive, frozen, or paused.`);
  }
  if (role === 'collateral' && !usageAsCollateralEnabled) {
    throw new Error('Aave Sepolia collateral reserve is not enabled as collateral.');
  }
  if (role === 'debt' && !borrowingEnabled) {
    throw new Error('Aave Sepolia debt reserve is not borrowable.');
  }
  if (price <= 0n) throw new Error(`Aave Sepolia ${role} oracle price is not positive.`);
  const availableLiquidityUnits = await client.readContract({
    address: asset.address,
    abi: BALANCE_ABI,
    functionName: 'balanceOf',
    args: [asset.aToken],
    blockNumber,
  });
  return {
    asset: getAddress(asset.address),
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
    aToken: reserveTokens.aToken,
    variableDebtToken: reserveTokens.variableDebtToken,
    price,
    availableLiquidityUnits,
    totalATokenUnits: reserveData[2],
    totalVariableDebtUnits: reserveData[4],
    configuration: {
      ltv,
      liquidationThreshold,
      liquidationBonus,
      reserveFactor,
      usageAsCollateralEnabled,
      borrowingEnabled,
      stableBorrowRateEnabled,
      isActive,
      isFrozen,
      paused,
    },
  };
}

async function inspectDestination(configuration, rpcUrl) {
  const destination = configuration.destination;
  if (destination.sequencerUptimeFeed !== null || destination.sequencerGracePeriodSeconds !== 0) {
    throw new Error('Base Sepolia route must retain the reviewed null sequencer-feed policy.');
  }
  const client = publicClient(destination.chainId, destination.network, rpcUrl);
  const [chainId, block] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: 'finalized' }),
  ]);
  assertEqual('Base Sepolia RPC chain ID', chainId, destination.chainId);
  if (block.hash === null) throw new Error('Base Sepolia finalized block has no canonical hash.');
  const blockNumber = block.number;
  const blockObservedAt = new Date(Number(block.timestamp) * 1_000).toISOString();
  const [collateral, loan, collateralFeed, loanFeed, contracts] = await Promise.all([
    readTokenMetadata(client, destination.collateralAsset.address, blockNumber),
    readTokenMetadata(client, destination.loanAsset.address, blockNumber),
    inspectFeed(client, destination.collateralFeed, blockNumber, blockObservedAt),
    inspectFeed(client, destination.loanFeed, blockNumber, blockObservedAt),
    inspectContracts(
      client,
      [
        destination.collateralAsset.address,
        destination.loanAsset.address,
        destination.collateralFeed.address,
        destination.loanFeed.address,
      ],
      blockNumber,
    ),
  ]);
  assertToken('Base Sepolia collateral', collateral, destination.collateralAsset);
  assertToken('Base Sepolia loan', loan, destination.loanAsset);

  return {
    chainId,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    blockTimestamp: blockObservedAt,
    collateral,
    loan,
    collateralFeed,
    loanFeed,
    sequencerUptimeFeed: null,
    lltv: destination.lltv,
    minimumSeedLiquidityUnits: destination.minimumSeedLiquidityUnits,
    contracts,
  };
}

async function inspectFeed(client, feed, blockNumber, blockObservedAt) {
  const [description, observation] = await Promise.all([
    client.readContract({
      address: feed.address,
      abi: CHAINLINK_AGGREGATOR_V3_ABI,
      functionName: 'description',
      blockNumber,
    }),
    new ChainlinkPriceReader(client).readAtBlock(
      { address: feed.address, maximumAgeSeconds: feed.maximumAgeSeconds },
      blockNumber,
      blockObservedAt,
    ),
  ]);
  assertEqual(`${feed.registryPath} description`, description, feed.expectedDescription);
  assertEqual(`${feed.registryPath} decimals`, observation.decimals, feed.decimals);
  return serializeBigInts({
    address: getAddress(feed.address),
    description,
    heartbeatSeconds: feed.heartbeatSeconds,
    maximumAgeSeconds: feed.maximumAgeSeconds,
    answer: observation.answer,
    decimals: observation.decimals,
    updatedAt: observation.updatedAt,
  });
}

async function readTokenMetadata(client, address, blockNumber) {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({
      address,
      abi: ERC20_METADATA_ABI,
      functionName: 'name',
      blockNumber,
    }),
    client.readContract({
      address,
      abi: ERC20_METADATA_ABI,
      functionName: 'symbol',
      blockNumber,
    }),
    client.readContract({
      address,
      abi: ERC20_METADATA_ABI,
      functionName: 'decimals',
      blockNumber,
    }),
  ]);
  return { address: getAddress(address), name, symbol, decimals };
}

async function inspectContracts(client, addresses, blockNumber) {
  const unique = [...new Set(addresses.map((address) => getAddress(address)))];
  return Promise.all(
    unique.map(async (address) => {
      const code = await client.getCode({ address, blockNumber });
      if (code === undefined || code === '0x') {
        throw new Error(`Expected public-testnet contract bytecode at ${address}.`);
      }
      return { address, runtimeCodeHash: keccak256(code) };
    }),
  );
}

function verifyAaveModule(module, source) {
  assertEqual('Aave Sepolia chain ID', module.CHAIN_ID, source.chainId);
  assertAddress('Aave Sepolia pool', module.POOL, source.pool);
  assertAddress(
    'Aave Sepolia pool addresses provider',
    module.POOL_ADDRESSES_PROVIDER,
    source.poolAddressesProvider,
  );
  assertAddress(
    'Aave Sepolia data provider',
    module.AAVE_PROTOCOL_DATA_PROVIDER,
    source.dataProvider,
  );
  assertAddress('Aave Sepolia oracle', module.ORACLE, source.oracle);
  assertAddress('Aave Sepolia faucet', module.FAUCET, source.faucet);
  const assets = requireObject(module.ASSETS, 'Aave Sepolia assets');
  verifyAaveModuleAsset(requireObject(assets.WETH, 'Aave WETH asset'), source.collateralAsset);
  verifyAaveModuleAsset(requireObject(assets.USDC, 'Aave USDC asset'), source.debtAsset);
}

function verifyAaveModuleAsset(actual, expected) {
  assertAddress(`${expected.symbol} underlying`, actual.UNDERLYING, expected.address);
  assertAddress(`${expected.symbol} aToken`, actual.A_TOKEN, expected.aToken);
  assertAddress(
    `${expected.symbol} variable debt token`,
    actual.V_TOKEN,
    expected.variableDebtToken,
  );
  assertAddress(`${expected.symbol} oracle`, actual.ORACLE, expected.oracle);
  assertEqual(`${expected.symbol} decimals`, actual.decimals, expected.decimals);
}

function verifyRegistryFeed(registry, expected) {
  const matches = registry.filter(
    (candidate) => isRecord(candidate) && candidate.path === expected.registryPath,
  );
  if (matches.length !== 1) {
    throw new Error(`Chainlink registry path ${expected.registryPath} is missing or ambiguous.`);
  }
  const actual = matches[0];
  assertEqual(`${expected.registryPath} name`, actual.name, expected.expectedDescription);
  assertAddress(`${expected.registryPath} proxy`, actual.proxyAddress, expected.address);
  assertEqual(`${expected.registryPath} decimals`, actual.decimals, expected.decimals);
  assertEqual(`${expected.registryPath} heartbeat`, actual.heartbeat, expected.heartbeatSeconds);
}

async function fetchDocument(url) {
  validatedRpcUrl(url, 'public reference URL');
  const response = await fetch(url, {
    headers: { accept: 'application/json,text/html,text/plain;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Public reference ${url} returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_REFERENCE_BYTES) {
    throw new Error(`Public reference ${url} exceeds the response-size limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error(`Public reference ${url} exceeds the response-size limit.`);
  }
  return {
    text: new TextDecoder().decode(bytes),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function publicClient(chainId, name, rpcUrl) {
  const chain = {
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
  });
}

function validatedRpcUrl(value, label) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
  return parsed.toString();
}

function assertToken(label, actual, expected) {
  assertAddress(`${label} address`, actual.address, expected.address);
  assertEqual(`${label} symbol`, actual.symbol, expected.symbol);
  assertEqual(`${label} decimals`, actual.decimals, expected.decimals);
}

function assertAddress(label, actual, expected) {
  if (typeof actual !== 'string' || !isAddressEqual(getAddress(actual), getAddress(expected))) {
    throw new Error(`${label} does not match the reviewed route.`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label} does not match the reviewed route.`);
}

function assertDocumentContains(label, document, expected) {
  if (!document.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`${label} no longer contains the reviewed value.`);
  }
}

function parseJsonObject(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return requireObject(parsed, label);
}

function parseJsonArray(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array.`);
  return parsed;
}

function requireObject(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeBigInts(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );
}

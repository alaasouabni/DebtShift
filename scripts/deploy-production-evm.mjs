import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  debtShiftEvmDeploymentManifestSchema,
  parseLiveMarketConfiguration,
} from '../packages/domain/dist/index.js';
import {
  deployProductionDebtShift,
  MORPHO_BLUE_READ_ABI,
  readAaveReserveTokenAddresses,
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
const routeId =
  process.env.DEBTSHIFT_ROUTE_ID ?? 'base-aave-v3-weth-usdc-to-arbitrum-morpho-blue-weth-usdc-v1';
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

const [actualSourceChainId, actualDestinationChainId, reserveTokens, rawMarketParams] =
  await Promise.all([
    sourcePublic.getChainId(),
    destinationPublic.getChainId(),
    readAaveReserveTokenAddresses(
      sourcePublic,
      route.source.dataProvider,
      route.source.collateralAsset.address,
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
        aToken: reserveTokens.aToken,
        variableDebtToken: reserveTokens.variableDebtToken,
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
  }),
);

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

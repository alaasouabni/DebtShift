import { execFileSync } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { testnetMorphoDeploymentManifestSchema } from '../packages/domain/dist/index.js';
import { deployTestnetMorphoMarket } from '../packages/protocols/dist/index.js';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

assertDeploymentAuthorization();

const workspaceRoot = resolve('.');
const sourceCommit = cleanSourceCommit(workspaceRoot);
const rpcUrl = requiredUrl('DESTINATION_RPC_URL');
const chainId = requiredPositiveInteger('DESTINATION_CHAIN_ID');
const confirmations = optionalPositiveInteger('DESTINATION_FINALITY_CONFIRMATIONS', 1);
const account = privateKeyToAccount(requiredPrivateKey('DEPLOYER_PRIVATE_KEY'));
const owner = getAddress(process.env.MORPHO_OWNER ?? account.address);
const seedLiquidityOwner = getAddress(process.env.DESTINATION_MORPHO_LIQUIDITY_OWNER ?? owner);
const collateralToken = getAddress(required('DESTINATION_COLLATERAL_TOKEN_ADDRESS'));
const loanToken = getAddress(required('DESTINATION_DEBT_TOKEN_ADDRESS'));
const collateralFeed = getAddress(required('DESTINATION_COLLATERAL_CHAINLINK_FEED_ADDRESS'));
const loanFeed = getAddress(required('DESTINATION_DEBT_CHAINLINK_FEED_ADDRESS'));
const sequencerUptimeFeed = getAddress(
  process.env.DESTINATION_SEQUENCER_UPTIME_FEED_ADDRESS?.trim() || zeroAddress,
);
const maxPriceAgeSeconds = requiredPositiveBigInt('DESTINATION_ORACLE_MAX_AGE_SECONDS');
const sequencerGracePeriodSeconds = isZeroAddress(sequencerUptimeFeed)
  ? 0n
  : requiredPositiveBigInt('DESTINATION_SEQUENCER_GRACE_PERIOD_SECONDS');
const lltv = requiredPositiveBigInt('DESTINATION_MORPHO_LLTV');
const seedLiquidityAssets = requiredPositiveBigInt('DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS');
const minimumNativeBalanceWei = optionalPositiveBigInt('MINIMUM_DEPLOYER_NATIVE_BALANCE_WEI', 1n);
const outputPath = resolve(
  process.env.MORPHO_DEPLOYMENT_MANIFEST_PATH ??
    `deployment/manifests/testnet-morpho-${new Date().toISOString().replaceAll(':', '-')}.json`,
);
const chain = defineChain({
  id: chainId,
  name: 'DebtShift testnet Morpho deployment',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
});
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const [actualChainId, nativeBalance] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: account.address }),
]);
if (actualChainId !== chainId) {
  throw new Error(
    `Destination RPC chain mismatch: expected ${chainId}, received ${actualChainId}.`,
  );
}
if (nativeBalance < minimumNativeBalanceWei) {
  throw new Error(
    `Morpho deployer has ${nativeBalance} native wei; ${minimumNativeBalanceWei} required.`,
  );
}

await mkdir(dirname(outputPath), { recursive: true });
const manifestFile = await open(outputPath, 'wx');
let manifest;
try {
  manifest = testnetMorphoDeploymentManifestSchema.parse(
    await deployTestnetMorphoMarket({
      sourceCommit,
      publicClient,
      wallet,
      chainId,
      confirmations,
      owner,
      collateralToken,
      loanToken,
      collateralFeed,
      loanFeed,
      ...(isZeroAddress(sequencerUptimeFeed) ? {} : { sequencerUptimeFeed }),
      maxPriceAgeSeconds,
      sequencerGracePeriodSeconds,
      lltv,
      seedLiquidityOwner,
      seedLiquidityAssets,
    }),
  );
  await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
} finally {
  await manifestFile.close();
}
console.log(
  JSON.stringify({
    status: 'CANONICAL_TESTNET_MORPHO_DEPLOYED_WITH_WORKFLOW_WRITES_DISABLED',
    manifestPath: outputPath,
    chainId,
    upstreamCommit: manifest.upstream.commit,
    morpho: manifest.contracts.morpho.address,
    marketId: manifest.market.id,
    seededLiquidityUnits: manifest.market.seedLiquidityAssets,
  }),
);

function assertDeploymentAuthorization() {
  if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
    throw new Error('Testnet Morpho deployment requires MAINNET_EXECUTION_ENABLED=false.');
  }
  if (process.env.DEBTSHIFT_DEPLOYMENT_ENVIRONMENT !== 'testnet') {
    throw new Error('Testnet Morpho deployment requires DEBTSHIFT_DEPLOYMENT_ENVIRONMENT=testnet.');
  }
  if (process.env.DEBTSHIFT_TESTNET_MORPHO_DEPLOYMENT_APPROVED !== 'true') {
    throw new Error(
      'Set DEBTSHIFT_TESTNET_MORPHO_DEPLOYMENT_APPROVED=true only after reviewing the exact testnet, assets, feeds, LLTV, and seed liquidity.',
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
    throw new Error('Testnet Morpho deployment requires a clean Git worktree.');
  }
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

function requiredPositiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function optionalPositiveInteger(name, fallback) {
  return process.env[name]?.trim() ? requiredPositiveInteger(name) : fallback;
}

function requiredPositiveBigInt(name) {
  const value = required(name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  return BigInt(value);
}

function optionalPositiveBigInt(name, fallback) {
  return process.env[name]?.trim() ? requiredPositiveBigInt(name) : fallback;
}

function isZeroAddress(address) {
  return address.toLowerCase() === zeroAddress;
}

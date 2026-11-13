import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseTestnetMorphoDeploymentManifest } from '../packages/domain/dist/index.js';
import { verifyTestnetMorphoDeployment } from '../packages/protocols/dist/index.js';
import { createPublicClient, defineChain, http } from 'viem';

if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
  throw new Error('Read-only testnet Morpho readiness requires MAINNET_EXECUTION_ENABLED=false.');
}
const manifestPath = resolve(required('MORPHO_DEPLOYMENT_MANIFEST_PATH'));
const manifest = parseTestnetMorphoDeploymentManifest(await readFile(manifestPath, 'utf8'));
const rpcUrl = requiredUrl('DESTINATION_RPC_URL');
const chain = defineChain({
  id: manifest.chainId,
  name: 'DebtShift testnet Morpho readiness',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
});
const report = await verifyTestnetMorphoDeployment({
  manifest,
  publicClient,
  minimumAvailableLiquidityUnits: optionalPositiveBigInt(
    'MINIMUM_MORPHO_AVAILABLE_LIQUIDITY_UNITS',
    1n,
  ),
});
console.log(
  JSON.stringify({
    status: 'CANONICAL_TESTNET_MORPHO_READY',
    manifestPath,
    upstreamCommit: manifest.upstream.commit,
    morpho: manifest.contracts.morpho.address,
    ...report,
  }),
);

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

function optionalPositiveBigInt(name, fallback) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  return BigInt(value);
}

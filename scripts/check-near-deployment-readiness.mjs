import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseDebtShiftNearDeploymentManifest } from '../packages/domain/dist/index.js';
import { JsonRpcProvider } from 'near-api-js';

import { verifyNearDeploymentReadiness } from './lib/near-deployment-readiness.mjs';

if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
  throw new Error('Read-only NEAR deployment readiness requires MAINNET_EXECUTION_ENABLED=false.');
}
const manifestPath = resolve(required('NEAR_DEPLOYMENT_MANIFEST_PATH'));
const manifest = parseDebtShiftNearDeploymentManifest(await readFile(manifestPath, 'utf8'));
const configuredNetwork = process.env.NEAR_NETWORK?.trim();
if (configuredNetwork !== undefined && configuredNetwork !== manifest.network) {
  throw new Error('NEAR_NETWORK does not match the deployment manifest.');
}
assertOptionalBinding('NEAR_REGISTRY_ACCOUNT', manifest.registryAccount);
assertOptionalBinding('NEAR_REGISTRY_OWNER_ACCOUNT', manifest.ownerAccount);
assertOptionalBinding('NEAR_REGISTRY_WASM_SHA256', manifest.wasmSha256);

const rpcUrls = parseRpcUrls();
const report = await verifyNearDeploymentReadiness({
  manifest,
  rpcUrls,
  providerFactory: (rpcUrl) =>
    new JsonRpcProvider({ url: rpcUrl }, { retries: 1, wait: 200, backoff: 1 }),
});

console.log(
  JSON.stringify({
    status: 'WRITE_DISABLED_NEAR_DEPLOYMENT_READY',
    manifestPath,
    network: manifest.network,
    registryAccount: manifest.registryAccount,
    ownerAccount: manifest.ownerAccount,
    verifierAccounts: manifest.verifierAccounts,
    wasmSha256: manifest.wasmSha256,
    deployedCodeHash: manifest.deployedCodeHash,
    sourceCommit: manifest.sourceCommit,
    ...report,
  }),
);

function parseRpcUrls() {
  const primaryUrl = requiredHttpsUrl('NEAR_RPC_URL');
  let fallbacks;
  try {
    fallbacks = JSON.parse(process.env.NEAR_RPC_FALLBACK_URLS_JSON ?? '[]');
  } catch {
    throw new Error('NEAR_RPC_FALLBACK_URLS_JSON must be a JSON array.');
  }
  if (!Array.isArray(fallbacks) || fallbacks.length > 4) {
    throw new Error('NEAR_RPC_FALLBACK_URLS_JSON must contain at most four URLs.');
  }
  const urls = [primaryUrl, ...fallbacks.map((_, index) => requiredHttpsUrlAt(fallbacks, index))];
  if (new Set(urls).size !== urls.length) throw new Error('NEAR RPC URLs must be unique.');
  return urls;
}

function requiredHttpsUrlAt(values, index) {
  const value = values[index];
  if (typeof value !== 'string') throw new Error('Every NEAR RPC fallback must be a URL string.');
  return parseHttpsUrl(value, `NEAR RPC fallback ${index.toString()}`);
}

function requiredHttpsUrl(name) {
  return parseHttpsUrl(required(name), name);
}

function parseHttpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  return url.toString();
}

function assertOptionalBinding(name, expected) {
  const value = process.env[name]?.trim();
  if (value !== undefined && value.length > 0 && value !== expected) {
    throw new Error(`${name} does not match the deployment manifest.`);
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

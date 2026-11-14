import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  derivePublicTestnetLiveRoute,
  parsePublicTestnetLiveRoutePolicy,
  parsePublicTestnetRouteDependencies,
  parseTestnetMorphoDeploymentManifest,
} from '../packages/domain/dist/index.js';
import { keccak256, stringToHex } from 'viem';

if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
  throw new Error('Public-testnet route generation requires MAINNET_EXECUTION_ENABLED=false.');
}

const workspaceRoot = resolve('.');
const currentCommit = trackedSourceCommit(workspaceRoot);
const dependenciesPath = resolve(
  process.env.PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH ??
    'config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json',
);
const generationPolicyPath = resolve(
  process.env.PUBLIC_TESTNET_LIVE_ROUTE_POLICY_PATH ??
    'config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.policy.v1.json',
);
const morphoManifestPath = resolve(required('MORPHO_DEPLOYMENT_MANIFEST_PATH'));
const outputPath = resolve(
  process.env.PUBLIC_TESTNET_LIVE_ROUTE_OUTPUT_PATH ??
    'config/routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.v1.json',
);

const [dependenciesJson, generationPolicyJson, morphoManifestJson] = await Promise.all([
  readFile(dependenciesPath, 'utf8'),
  readFile(generationPolicyPath, 'utf8'),
  readFile(morphoManifestPath, 'utf8'),
]);
const dependencies = parsePublicTestnetRouteDependencies(dependenciesJson);
const generationPolicy = parsePublicTestnetLiveRoutePolicy(generationPolicyJson);
const morphoManifest = parseTestnetMorphoDeploymentManifest(morphoManifestJson);
const routeDependenciesHash = keccak256(stringToHex(dependenciesJson));
const generationPolicyHash = keccak256(stringToHex(generationPolicyJson));
if (morphoManifest.sourceCommit !== currentCommit) {
  throw new Error(
    'Morpho manifest source commit does not match the current tracked source commit.',
  );
}
const route = derivePublicTestnetLiveRoute({
  dependencies,
  routeDependenciesHash,
  morphoManifest,
  generationPolicy,
});
const routeConfigurationHash = keccak256(stringToHex(JSON.stringify(route)));

await mkdir(dirname(outputPath), { recursive: true });
const output = await open(outputPath, 'wx');
try {
  await output.writeFile(`${JSON.stringify(route, null, 2)}\n`, 'utf8');
} finally {
  await output.close();
}

console.log(
  JSON.stringify({
    status: 'WRITE_DISABLED_PUBLIC_TESTNET_ROUTE_GENERATED',
    routeId: dependencies.routeId,
    sourceCommit: currentCommit,
    routeDependenciesHash,
    generationPolicyHash,
    routeConfigurationHash,
    morphoManifestPath,
    dependenciesPath,
    generationPolicyPath,
    outputPath,
    workflowWriteSwitchEnabled: false,
    providerAssetIds: 'OMITTED_UNAVAILABLE_ON_TESTNET',
  }),
);

function trackedSourceCommit(workspace) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('The current source commit is not a full Git SHA-1.');
  }
  for (const args of [
    ['diff', '--quiet'],
    ['diff', '--cached', '--quiet'],
  ]) {
    try {
      execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
    } catch {
      throw new Error('Public-testnet route generation requires clean tracked source files.');
    }
  }
  return sourceCommit;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import {
  debtShiftNearDeploymentManifestSchema,
  nearAccountIdSchema,
} from '../packages/domain/dist/index.js';
import { Account, JsonRpcProvider, KeyPairSigner, actions } from 'near-api-js';

const EMPTY_CODE_HASH = '11111111111111111111111111111111';
const MAX_WASM_BYTES = 4 * 1024 * 1024;

assertDeploymentAuthorization();

const environment = requiredEnum('DEBTSHIFT_DEPLOYMENT_ENVIRONMENT', ['testnet', 'mainnet']);
const network = requiredEnum('NEAR_NETWORK', ['testnet', 'mainnet']);
if (environment !== network) {
  throw new Error('DEBTSHIFT_DEPLOYMENT_ENVIRONMENT and NEAR_NETWORK must match.');
}
const rpcUrl = requiredPublicRpcUrl('NEAR_RPC_URL');
const registryAccount = nearAccountIdSchema.parse(required('NEAR_REGISTRY_ACCOUNT'));
const ownerAccount = nearAccountIdSchema.parse(required('NEAR_REGISTRY_OWNER_ACCOUNT'));
const verifierAccounts = parseVerifierAccounts(required('NEAR_INITIAL_VERIFIERS_JSON'));
if (
  new Set([registryAccount, ownerAccount, ...verifierAccounts]).size !==
  verifierAccounts.length + 2
) {
  throw new Error('NEAR registry, owner, and verifier identities must be distinct.');
}
const deploymentPrivateKey = required('NEAR_DEPLOYER_PRIVATE_KEY');
const functionCallGas = requiredPositiveInteger(
  'NEAR_DEPLOYMENT_FUNCTION_CALL_GAS',
  '100000000000000',
);
const minimumDeployerBalance = requiredPositiveInteger(
  'NEAR_MINIMUM_DEPLOYER_BALANCE_YOCTO',
  '5000000000000000000000000',
);
const workspaceRoot = resolve('.');
const artifactPath = resolve(
  process.env.NEAR_REGISTRY_WASM_PATH ??
    'contracts/near/target/near/debtshift_registry/debtshift_registry.wasm',
);
const artifact = relative(workspaceRoot, artifactPath).replaceAll('\\', '/');
if (artifact.startsWith('../') || artifact === '..') {
  throw new Error('NEAR_REGISTRY_WASM_PATH must remain inside the repository workspace.');
}
const outputPath = resolve(
  process.env.NEAR_DEPLOYMENT_MANIFEST_PATH ??
    `deployment/manifests/near-${network}-${new Date().toISOString().replaceAll(':', '-')}.json`,
);
const sourceCommit = cleanSourceCommit(workspaceRoot);
const wasm = new Uint8Array(await readFile(artifactPath));
if (wasm.byteLength === 0 || wasm.byteLength > MAX_WASM_BYTES) {
  throw new Error('The NEAR registry WASM must be non-empty and no larger than 4 MiB.');
}
const wasmSha256 = `0x${createHash('sha256').update(wasm).digest('hex')}`;

const provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 1, wait: 200, backoff: 1 });
const actualNetwork = await provider.getNetworkId();
if (actualNetwork !== network) {
  throw new Error(`NEAR RPC network ${actualNetwork} does not match ${network}.`);
}
const signer = KeyPairSigner.fromSecretKey(deploymentPrivateKey);
const signerPublicKey = await signer.getPublicKey();
const accessKey = await provider.viewAccessKey({
  accountId: registryAccount,
  publicKey: signerPublicKey.toString(),
  finalityQuery: { finality: 'final' },
});
if (accessKey.permission !== 'FullAccess') {
  throw new Error('NEAR deployment requires a full-access key on the registry account.');
}
const accountState = await provider.viewAccount({
  accountId: registryAccount,
  blockQuery: { finality: 'final' },
});
if (accountState.amount < minimumDeployerBalance) {
  throw new Error('NEAR registry account balance is below the configured deployment minimum.');
}
if (accountState.code_hash !== EMPTY_CODE_HASH) {
  throw new Error(
    'NEAR registry account already has code; this deployer never overwrites contracts.',
  );
}
await Promise.all([
  provider.viewAccount({ accountId: ownerAccount, blockQuery: { finality: 'final' } }),
  ...verifierAccounts.map((accountId) =>
    provider.viewAccount({ accountId, blockQuery: { finality: 'final' } }),
  ),
]);

console.log(
  JSON.stringify({
    status: 'NEAR_DEPLOYMENT_PREFLIGHT_READY',
    network,
    registryAccount,
    ownerAccount,
    verifierCount: verifierAccounts.length,
    wasmSha256,
    sourceCommit,
  }),
);

const account = new Account(registryAccount, provider, signer);
const outcome = await account.signAndSendTransaction({
  receiverId: registryAccount,
  actions: [
    actions.deployContract(wasm),
    actions.functionCall(
      'new',
      { owner_id: ownerAccount, initial_verifiers: verifierAccounts },
      functionCallGas,
      0n,
    ),
  ],
  waitUntil: 'FINAL',
});
const transaction = await transactionRecord(provider, outcome);
console.log(
  JSON.stringify({
    status: 'NEAR_REGISTRY_CODE_AND_STATE_DEPLOYED',
    network,
    registryAccount,
    transactionHash: transaction.transactionHash,
    blockHeight: transaction.blockHeight,
    blockHash: transaction.blockHash,
  }),
);

const code = await provider.viewContractCode({
  contractId: registryAccount,
  blockQuery: { finality: 'final' },
});
const deployedWasmSha256 = `0x${createHash('sha256').update(code.code).digest('hex')}`;
if (deployedWasmSha256 !== wasmSha256) {
  throw new Error('Final NEAR contract code does not match the local registry artifact.');
}
const [actualOwner, pendingOwner, actualVerifiers, finalAccountState] = await Promise.all([
  view(provider, registryAccount, 'owner_id', {}),
  view(provider, registryAccount, 'pending_owner_id', {}),
  view(provider, registryAccount, 'list_verifiers', { from_index: 0, limit: 50 }),
  provider.viewAccount({ accountId: registryAccount, blockQuery: { finality: 'final' } }),
]);
if (actualOwner !== ownerAccount) throw new Error('Final NEAR registry owner does not match.');
if (pendingOwner !== null) throw new Error('New NEAR registry has a pending owner transfer.');
if (JSON.stringify(actualVerifiers) !== JSON.stringify(verifierAccounts)) {
  throw new Error('Final NEAR registry verifier set does not match.');
}

const manifest = debtShiftNearDeploymentManifestSchema.parse({
  schemaVersion: 1,
  environment,
  network,
  createdAt: new Date().toISOString(),
  sourceCommit,
  registryAccount,
  deployerAccount: registryAccount,
  ownerAccount,
  verifierAccounts,
  artifact,
  wasmSha256,
  deployedCodeHash: code.hash,
  deploymentTransaction: transaction,
  initializationTransaction: transaction,
  initialStorageUsage: finalAccountState.storage_usage.toString(),
  workflowWriteSwitchEnabled: false,
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});
console.log(
  JSON.stringify({
    status: 'NEAR_REGISTRY_DEPLOYED_WITH_WORKFLOW_WRITES_DISABLED',
    network,
    registryAccount,
    manifestPath: outputPath,
    wasmSha256,
    deployedCodeHash: code.hash,
  }),
);

function assertDeploymentAuthorization() {
  if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
    throw new Error('NEAR contract deployment requires MAINNET_EXECUTION_ENABLED=false.');
  }
  if (process.env.DEBTSHIFT_DEPLOYMENT_APPROVED !== 'true') {
    throw new Error(
      'Set DEBTSHIFT_DEPLOYMENT_APPROVED=true only after reviewing the exact NEAR account and network.',
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
    throw new Error('NEAR deployment requires a clean Git worktree.');
  }
  return sourceCommit;
}

async function transactionRecord(rpc, outcome) {
  if (outcome.final_execution_status !== 'FINAL') {
    throw new Error('NEAR deployment did not reach final execution status.');
  }
  const blockHash = outcome.transaction_outcome.block_hash;
  const block = await rpc.viewBlock({ blockId: blockHash });
  return {
    transactionHash: outcome.transaction.hash,
    signerAccount: outcome.transaction.signer_id,
    receiverAccount: outcome.transaction.receiver_id,
    blockHeight: block.header.height.toString(),
    blockHash,
  };
}

function view(rpc, contractId, method, args) {
  return rpc.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } });
}

function parseVerifierAccounts(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('NEAR_INITIAL_VERIFIERS_JSON must be a JSON array.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
    throw new Error('NEAR_INITIAL_VERIFIERS_JSON must contain between one and 64 accounts.');
  }
  const accounts = parsed.map((account) => nearAccountIdSchema.parse(account));
  if (new Set(accounts).size !== accounts.length) {
    throw new Error('NEAR initial verifier accounts must be unique.');
  }
  return accounts;
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

function requiredPublicRpcUrl(name) {
  const value = required(name);
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`);
  return url.toString();
}

function requiredPositiveInteger(name, defaultValue) {
  const value = process.env[name]?.trim() ?? defaultValue;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive base-10 integer.`);
  }
  return BigInt(value);
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assessPublicTestnetFundingReadiness,
  parsePublicTestnetRouteDependencies,
  publicTestnetFundingObservationSchema,
  publicTestnetFundingRequirementsSchema,
} from '../packages/domain/dist/index.js';
import { AaveV3ReadAdapter } from '../packages/protocols/dist/index.js';
import { JsonRpcProvider, PublicKey } from 'near-api-js';
import { createPublicClient, defineChain, getAddress, http, keccak256, stringToHex } from 'viem';

const DEFAULT_ROUTE_PATH =
  'config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json';
const DEFAULT_ETHEREUM_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEFAULT_BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const DEFAULT_NEAR_TESTNET_RPC = 'https://rpc.testnet.near.org';

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
];

if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
  throw new Error('Public-testnet funding readiness requires MAINNET_EXECUTION_ENABLED=false.');
}

const routePath = resolve(process.env.PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH ?? DEFAULT_ROUTE_PATH);
const routeJson = await readFile(routePath, 'utf8');
const route = parsePublicTestnetRouteDependencies(routeJson);
const routeDependenciesHash = keccak256(stringToHex(routeJson));
const morphoSeedMinimum = requiredPositiveAmount('DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS');
if (BigInt(morphoSeedMinimum) < BigInt(route.destination.minimumSeedLiquidityUnits)) {
  throw new Error(
    `DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS must be at least ${route.destination.minimumSeedLiquidityUnits}.`,
  );
}

const requirements = publicTestnetFundingRequirementsSchema.parse({
  schemaVersion: 1,
  routeId: route.routeId,
  routeDependenciesHash,
  environment: 'testnet',
  workflowWriteSwitchEnabled: false,
  evm: {
    borrower: required('PUBLIC_TESTNET_BORROWER_ADDRESS'),
    deployer: required('PUBLIC_TESTNET_DEPLOYER_ADDRESS'),
    vaultFunder: required('PUBLIC_TESTNET_VAULT_FUNDER_ADDRESS'),
    executor: required('PUBLIC_TESTNET_EXECUTOR_ADDRESS'),
    minimums: {
      borrowerSourceNativeBalanceWei: requiredPositiveAmount(
        'MINIMUM_BORROWER_SOURCE_NATIVE_BALANCE_WEI',
      ),
      borrowerCollateralUnits: requiredPositiveAmount('MINIMUM_AAVE_COLLATERAL_UNITS'),
      borrowerDebtUnits: requiredPositiveAmount('MINIMUM_AAVE_DEBT_UNITS'),
      deployerSourceNativeBalanceWei: requiredPositiveAmount(
        'MINIMUM_EVM_DEPLOYER_NATIVE_BALANCE_WEI',
      ),
      deployerDestinationNativeBalanceWei: requiredPositiveAmount(
        'MINIMUM_EVM_DEPLOYER_NATIVE_BALANCE_WEI',
      ),
      destinationMorphoSeedLiquidityUnits: morphoSeedMinimum,
      sourceVaultFundingUnits: requiredPositiveAmount('MINIMUM_VAULT_FUNDING_UNITS'),
      executorSourceNativeBalanceWei: requiredPositiveAmount('MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI'),
      executorDestinationNativeBalanceWei: requiredPositiveAmount(
        'MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI',
      ),
      executorSourceCollateralUnits: requiredPositiveAmount('MINIMUM_TRANSPORT_COLLATERAL_UNITS'),
      executorDestinationCollateralUnits: requiredPositiveAmount(
        'MINIMUM_TRANSPORT_COLLATERAL_UNITS',
      ),
    },
  },
  near: {
    network: 'testnet',
    registryAccount: required('NEAR_REGISTRY_ACCOUNT'),
    ownerAccount: required('NEAR_REGISTRY_OWNER_ACCOUNT'),
    verifierAccount: required('NEAR_VERIFIER_ACCOUNT'),
    registryDeploymentPublicKey: PublicKey.fromString(
      required('NEAR_REGISTRY_DEPLOYMENT_PUBLIC_KEY'),
    ).toString(),
    minimumRegistryBalanceYocto: requiredPositiveAmount('NEAR_MINIMUM_REGISTRY_BALANCE_YOCTO'),
    minimumVerifierBalanceYocto: requiredPositiveAmount('NEAR_MINIMUM_VERIFIER_BALANCE_YOCTO'),
  },
});

const sourceRpcUrl = credentialSafeHttpsUrl(
  process.env.ETHEREUM_SEPOLIA_READ_RPC_URL ?? DEFAULT_ETHEREUM_SEPOLIA_RPC,
  'ETHEREUM_SEPOLIA_READ_RPC_URL',
);
const destinationRpcUrl = credentialSafeHttpsUrl(
  process.env.BASE_SEPOLIA_READ_RPC_URL ?? DEFAULT_BASE_SEPOLIA_RPC,
  'BASE_SEPOLIA_READ_RPC_URL',
);
const nearRpcUrl = credentialSafeHttpsUrl(
  process.env.NEAR_TESTNET_READ_RPC_URL ?? DEFAULT_NEAR_TESTNET_RPC,
  'NEAR_TESTNET_READ_RPC_URL',
);

const sourceClient = evmClient(route.source.chainId, route.source.network, sourceRpcUrl);
const destinationClient = evmClient(
  route.destination.chainId,
  route.destination.network,
  destinationRpcUrl,
);
const nearProvider = new JsonRpcProvider(
  { url: nearRpcUrl },
  { retries: 1, wait: 200, backoff: 1 },
);

const [sourceObservation, destinationObservation, nearObservation] = await Promise.all([
  inspectSource(sourceClient, route, requirements),
  inspectDestination(destinationClient, route, requirements),
  inspectNear(nearProvider, requirements),
]);
const observation = publicTestnetFundingObservationSchema.parse({
  checkedAt: new Date().toISOString(),
  source: sourceObservation,
  destination: destinationObservation,
  near: nearObservation,
});
const assessment = assessPublicTestnetFundingReadiness(requirements, observation);

console.log(
  JSON.stringify(
    {
      status: assessment.ready
        ? 'PUBLIC_TESTNET_FUNDING_READY'
        : 'PUBLIC_TESTNET_FUNDING_NOT_READY',
      routeId: route.routeId,
      routeDependenciesHash,
      routePath,
      environment: 'testnet',
      workflowWriteSwitchEnabled: false,
      identities: {
        borrower: requirements.evm.borrower,
        deployer: requirements.evm.deployer,
        vaultFunder: requirements.evm.vaultFunder,
        executor: requirements.evm.executor,
        nearRegistry: requirements.near.registryAccount,
        nearOwner: requirements.near.ownerAccount,
        nearVerifier: requirements.near.verifierAccount,
      },
      observation,
      checks: assessment.checks,
      deficiencies: assessment.deficiencies,
    },
    null,
    2,
  ),
);
if (!assessment.ready) process.exitCode = 1;

async function inspectSource(client, dependency, expected) {
  const [chainId, block] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: 'finalized' }),
  ]);
  if (chainId !== dependency.source.chainId) {
    throw new Error(`Ethereum Sepolia RPC returned unexpected chain ${chainId}.`);
  }
  if (block.hash === null) throw new Error('Ethereum Sepolia finalized block has no hash.');

  const adapter = new AaveV3ReadAdapter(client, {
    chainId,
    pool: dependency.source.pool,
    dataProvider: dependency.source.dataProvider,
    collateralAsset: {
      chainId,
      address: dependency.source.collateralAsset.address,
      decimals: dependency.source.collateralAsset.decimals,
      symbol: dependency.source.collateralAsset.symbol,
    },
    debtAsset: {
      chainId,
      address: dependency.source.debtAsset.address,
      decimals: dependency.source.debtAsset.decimals,
      symbol: dependency.source.debtAsset.symbol,
    },
  });
  const [position, borrowerNative, deployerNative, vaultFunderDebt, executorNative, executorWeth] =
    await Promise.all([
      adapter.readPosition(expected.evm.borrower, block.number),
      client.getBalance({ address: expected.evm.borrower, blockNumber: block.number }),
      client.getBalance({ address: expected.evm.deployer, blockNumber: block.number }),
      tokenBalance(
        client,
        dependency.source.debtAsset.address,
        expected.evm.vaultFunder,
        block.number,
      ),
      client.getBalance({ address: expected.evm.executor, blockNumber: block.number }),
      tokenBalance(
        client,
        dependency.source.collateralAsset.address,
        expected.evm.executor,
        block.number,
      ),
    ]);
  return {
    chainId,
    block: evmBlock(block),
    borrower: {
      nativeWei: borrowerNative.toString(),
      positionExists: position !== undefined,
      collateralUnits: position?.collateralUnits ?? '0',
      debtUnits: position?.debtUnits ?? '0',
      healthFactorWad:
        position?.health.kind === 'AAVE_HEALTH_FACTOR' ? position.health.healthFactorWad : null,
    },
    deployer: { nativeWei: deployerNative.toString() },
    vaultFunderDebtUnits: vaultFunderDebt.toString(),
    executor: {
      nativeWei: executorNative.toString(),
      collateralUnits: executorWeth.toString(),
    },
  };
}

async function inspectDestination(client, dependency, expected) {
  const [chainId, block] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: 'finalized' }),
  ]);
  if (chainId !== dependency.destination.chainId) {
    throw new Error(`Base Sepolia RPC returned unexpected chain ${chainId}.`);
  }
  if (block.hash === null) throw new Error('Base Sepolia finalized block has no hash.');

  const [deployerNative, deployerLoan, executorNative, executorWeth] = await Promise.all([
    client.getBalance({ address: expected.evm.deployer, blockNumber: block.number }),
    tokenBalance(
      client,
      dependency.destination.loanAsset.address,
      expected.evm.deployer,
      block.number,
    ),
    client.getBalance({ address: expected.evm.executor, blockNumber: block.number }),
    tokenBalance(
      client,
      dependency.destination.collateralAsset.address,
      expected.evm.executor,
      block.number,
    ),
  ]);
  return {
    chainId,
    block: evmBlock(block),
    deployer: {
      nativeWei: deployerNative.toString(),
      loanUnits: deployerLoan.toString(),
    },
    executor: {
      nativeWei: executorNative.toString(),
      collateralUnits: executorWeth.toString(),
    },
  };
}

async function inspectNear(provider, expected) {
  const network = await provider.getNetworkId();
  if (network !== 'testnet') throw new Error(`NEAR RPC returned unexpected network ${network}.`);
  const [registry, owner, verifier] = await Promise.all([
    viewNearAccount(provider, expected.near.registryAccount),
    viewNearAccount(provider, expected.near.ownerAccount),
    viewNearAccount(provider, expected.near.verifierAccount),
  ]);
  let deploymentKeyPermission = 'MISSING';
  if (registry.exists) {
    const keyList = await provider.viewAccessKeyList({
      accountId: expected.near.registryAccount,
      finalityQuery: { finality: 'final' },
    });
    const selected = keyList.keys.find(
      ({ public_key: publicKey }) =>
        PublicKey.fromString(publicKey).toString() === expected.near.registryDeploymentPublicKey,
    );
    if (selected !== undefined) {
      deploymentKeyPermission =
        selected.access_key.permission === 'FullAccess' ? 'FULL_ACCESS' : 'FUNCTION_CALL';
    }
  }
  return {
    network,
    registry: {
      ...registry,
      codeHash: registry.codeHash,
      deploymentKeyPermission,
    },
    owner: { exists: owner.exists, balanceYocto: owner.balanceYocto },
    verifier: { exists: verifier.exists, balanceYocto: verifier.balanceYocto },
  };
}

async function viewNearAccount(provider, accountId) {
  try {
    const account = await provider.viewAccount({
      accountId,
      blockQuery: { finality: 'final' },
    });
    return {
      exists: true,
      balanceYocto: account.amount.toString(),
      codeHash: account.code_hash,
    };
  } catch (error) {
    if (error instanceof Error && error.constructor.name === 'AccountDoesNotExistError') {
      return { exists: false, balanceYocto: '0', codeHash: null };
    }
    throw error;
  }
}

function tokenBalance(client, token, account, blockNumber) {
  return client.readContract({
    address: getAddress(token),
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [account],
    blockNumber,
  });
}

function evmBlock(block) {
  if (block.hash === null) throw new Error('Finalized EVM block has no hash.');
  return {
    number: block.number.toString(),
    hash: block.hash,
    observedAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
  };
}

function evmClient(chainId, name, rpcUrl) {
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

function credentialSafeHttpsUrl(value, label) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
  return url.toString();
}

function requiredPositiveAmount(name) {
  const value = required(name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive base-10 integer in base units.`);
  }
  return value;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

import { describe, expect, it } from 'vitest';

import {
  parseDebtShiftEvmDeploymentManifest,
  parseDebtShiftNearDeploymentManifest,
} from './deployment-manifest.js';

describe('DebtShift EVM deployment manifest', () => {
  it('parses an explicit write-disabled two-chain deployment record', () => {
    const parsed = parseDebtShiftEvmDeploymentManifest(JSON.stringify(validManifest()));

    expect(parsed.workflowWriteSwitchEnabled).toBe(false);
    expect(parsed.source.contracts.sourceAdapter.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parsed.destination.protocol.kind).toBe('MORPHO_BLUE');
  });

  it('rejects enabled writes, same-chain deployments, and incomplete records', () => {
    expect(() =>
      parseDebtShiftEvmDeploymentManifest(
        JSON.stringify({ ...validManifest(), workflowWriteSwitchEnabled: true }),
      ),
    ).toThrow();
    expect(() =>
      parseDebtShiftEvmDeploymentManifest(
        JSON.stringify({
          ...validManifest(),
          destination: { ...validManifest().destination, chainId: 8453 },
        }),
      ),
    ).toThrow('Source and destination deployment chains must differ.');
    expect(() => parseDebtShiftEvmDeploymentManifest('{}')).toThrow();
    expect(() =>
      parseDebtShiftEvmDeploymentManifest(
        JSON.stringify({ ...validManifest(), sourceCommit: 'working-tree' }),
      ),
    ).toThrow();
  });
});

describe('DebtShift NEAR deployment manifest', () => {
  it('parses a source-bound, write-disabled registry deployment', () => {
    const parsed = parseDebtShiftNearDeploymentManifest(JSON.stringify(validNearManifest()));

    expect(parsed.network).toBe('testnet');
    expect(parsed.wasmSha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parsed.verifierAccounts).toEqual(['verifier.debtshift.testnet']);
    expect(parsed.workflowWriteSwitchEnabled).toBe(false);
  });

  it('rejects a network mismatch, duplicate verifiers, and transaction account drift', () => {
    expect(() =>
      parseDebtShiftNearDeploymentManifest(
        JSON.stringify({ ...validNearManifest(), network: 'mainnet' }),
      ),
    ).toThrow('NEAR deployment environment and network must match');
    expect(() =>
      parseDebtShiftNearDeploymentManifest(
        JSON.stringify({
          ...validNearManifest(),
          verifierAccounts: ['verifier.debtshift.testnet', 'verifier.debtshift.testnet'],
        }),
      ),
    ).toThrow('NEAR deployment verifier accounts must be unique');
    expect(() =>
      parseDebtShiftNearDeploymentManifest(
        JSON.stringify({
          ...validNearManifest(),
          deploymentTransaction: {
            ...validNearManifest().deploymentTransaction,
            receiverAccount: 'different.testnet',
          },
        }),
      ),
    ).toThrow('NEAR deployment transactions must bind the deployer and registry accounts');
    expect(() =>
      parseDebtShiftNearDeploymentManifest(
        JSON.stringify({
          ...validNearManifest(),
          ownerAccount: 'verifier.debtshift.testnet',
        }),
      ),
    ).toThrow('NEAR registry, owner, and verifier identities must be distinct');
  });
});

function validManifest() {
  const contract = (artifact: string, address: string, seed: string) => ({
    artifact,
    address,
    deploymentTransactionHash: `0x${seed.repeat(64)}`,
    deploymentBlockNumber: '123',
    deploymentBlockHash: `0x${seed.repeat(64)}`,
    runtimeCodeHash: `0x${seed.repeat(64)}`,
  });
  const configurationTransaction = (action: string, seed: string) => ({
    action,
    transactionHash: `0x${seed.repeat(64)}`,
    blockNumber: '124',
    blockHash: `0x${seed.repeat(64)}`,
  });
  return {
    schemaVersion: 1,
    environment: 'mainnet',
    routeId: 'base-aave-v3-weth-usdc-to-arbitrum-morpho-blue-weth-usdc-v1',
    routeConfigurationHash: `0x${'1'.repeat(64)}`,
    createdAt: '2026-11-12T21:00:00.000Z',
    sourceCommit: '1'.repeat(40),
    owner: '0x1000000000000000000000000000000000000001',
    executor: '0x1000000000000000000000000000000000000002',
    workflowWriteSwitchEnabled: false,
    source: {
      chainId: 8453,
      deploymentBlockNumber: '123',
      protocol: {
        kind: 'AAVE_V3',
        pool: '0x1000000000000000000000000000000000000003',
        dataProvider: '0x1000000000000000000000000000000000000004',
        aToken: '0x1000000000000000000000000000000000000005',
        variableDebtToken: '0x1000000000000000000000000000000000000006',
      },
      collateralToken: '0x1000000000000000000000000000000000000007',
      debtToken: '0x1000000000000000000000000000000000000008',
      contracts: {
        liquidityVault: contract(
          'LiquidityVault',
          '0x1000000000000000000000000000000000000011',
          '2',
        ),
        migrationEscrow: contract(
          'MigrationEscrow',
          '0x1000000000000000000000000000000000000012',
          '3',
        ),
        sourceLending: contract(
          'AaveV3SourceLending',
          '0x1000000000000000000000000000000000000013',
          '4',
        ),
        sourceAdapter: contract('SourceAdapter', '0x1000000000000000000000000000000000000014', '5'),
      },
      configurationTransactions: [configurationTransaction('set source roles', '6')],
    },
    destination: {
      chainId: 42161,
      deploymentBlockNumber: '223',
      protocol: {
        kind: 'MORPHO_BLUE',
        morpho: '0x2000000000000000000000000000000000000001',
        marketId: `0x${'7'.repeat(64)}`,
        oracle: '0x2000000000000000000000000000000000000002',
        irm: '0x2000000000000000000000000000000000000003',
        lltv: '860000000000000000',
      },
      collateralToken: '0x2000000000000000000000000000000000000004',
      debtToken: '0x2000000000000000000000000000000000000005',
      contracts: {
        migrationEscrow: contract(
          'MigrationEscrow',
          '0x2000000000000000000000000000000000000011',
          '8',
        ),
        targetLending: contract(
          'MorphoBlueTargetLending',
          '0x2000000000000000000000000000000000000012',
          '9',
        ),
        destinationAdapter: contract(
          'DestinationAdapter',
          '0x2000000000000000000000000000000000000013',
          'a',
        ),
      },
      configurationTransactions: [configurationTransaction('set destination roles', 'b')],
    },
  } as const;
}

function validNearManifest() {
  const transaction = (seed: string) => ({
    transactionHash: seed.repeat(44),
    signerAccount: 'registry.debtshift.testnet',
    receiverAccount: 'registry.debtshift.testnet',
    blockHeight: '277500000',
    blockHash: seed.repeat(44),
  });
  return {
    schemaVersion: 1,
    environment: 'testnet',
    network: 'testnet',
    createdAt: '2026-11-13T13:00:00.000Z',
    sourceCommit: '1'.repeat(40),
    registryAccount: 'registry.debtshift.testnet',
    deployerAccount: 'registry.debtshift.testnet',
    ownerAccount: 'owner.debtshift.testnet',
    verifierAccounts: ['verifier.debtshift.testnet'],
    artifact: 'contracts/near/target/near/debtshift_registry/debtshift_registry.wasm',
    wasmSha256: `0x${'2'.repeat(64)}`,
    deployedCodeHash: '3'.repeat(44),
    deploymentTransaction: transaction('4'),
    initializationTransaction: transaction('5'),
    initialStorageUsage: '123456',
    workflowWriteSwitchEnabled: false,
  } as const;
}

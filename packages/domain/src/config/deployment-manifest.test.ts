import { describe, expect, it } from 'vitest';

import { parseDebtShiftEvmDeploymentManifest } from './deployment-manifest.js';

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

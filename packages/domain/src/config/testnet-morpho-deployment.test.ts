import { describe, expect, it } from 'vitest';

import { parseTestnetMorphoDeploymentManifest } from './testnet-morpho-deployment.js';

describe('testnet Morpho deployment manifest', () => {
  it('accepts a source-bound, write-disabled, funded market record', () => {
    const parsed = parseTestnetMorphoDeploymentManifest(JSON.stringify(validManifest()));

    expect(parsed.upstream.commit).toBe('1'.repeat(40));
    expect(parsed.market.seedLiquidityAssets).toBe('1000000');
    expect(parsed.workflowWriteSwitchEnabled).toBe(false);
  });

  it('rejects mainnet, mock funding, binding drift, and incomplete sequencer configuration', () => {
    expect(() =>
      parseTestnetMorphoDeploymentManifest(
        JSON.stringify({ ...validManifest(), environment: 'mainnet' }),
      ),
    ).toThrow();
    expect(() =>
      parseTestnetMorphoDeploymentManifest(
        JSON.stringify({
          ...validManifest(),
          market: { ...validManifest().market, seedLiquidityAssets: '0' },
        }),
      ),
    ).toThrow('seed liquidity must be positive');
    expect(() =>
      parseTestnetMorphoDeploymentManifest(
        JSON.stringify({
          ...validManifest(),
          market: {
            ...validManifest().market,
            oracle: '0x9000000000000000000000000000000000000009',
          },
        }),
      ),
    ).toThrow('market oracle does not match');
    expect(() =>
      parseTestnetMorphoDeploymentManifest(
        JSON.stringify({
          ...validManifest(),
          feeds: { ...validManifest().feeds, sequencerGracePeriodSeconds: '3600' },
        }),
      ),
    ).toThrow('Sequencer feed and positive grace period');
    expect(() =>
      parseTestnetMorphoDeploymentManifest(
        JSON.stringify({
          ...validManifest(),
          market: { ...validManifest().market, oraclePriceAtDeployment: '0' },
        }),
      ),
    ).toThrow('oracle price at deployment must be positive');
    const [first, ...rest] = validManifest().configurationTransactions;
    expect(() =>
      parseTestnetMorphoDeploymentManifest(
        JSON.stringify({
          ...validManifest(),
          configurationTransactions: [
            { ...first, sender: '0x1000000000000000000000000000000000000009' },
            ...rest,
          ],
        }),
      ),
    ).toThrow('configuration transaction sender must be the deployer');
  });
});

function validManifest() {
  const code = (address: string, seed: string, decimals = 8) => ({
    address,
    decimals,
    runtimeCodeHash: `0x${seed.repeat(64)}`,
  });
  const contract = (artifact: string, address: string, seed: string) => ({
    artifact,
    address,
    artifactCreationCodeHash: `0x${seed.repeat(64)}`,
    deploymentTransactionHash: `0x${seed.repeat(64)}`,
    deploymentTransactionInputHash: `0x${seed.repeat(64)}`,
    deploymentBlockNumber: '100',
    deploymentBlockHash: `0x${seed.repeat(64)}`,
    runtimeCodeHash: `0x${seed.repeat(64)}`,
  });
  const transaction = (action: string, seed: string) => ({
    action,
    transactionHash: `0x${seed.repeat(64)}`,
    transactionInputHash: `0x${seed.repeat(64)}`,
    sender: '0x1000000000000000000000000000000000000001',
    target: '0x2000000000000000000000000000000000000001',
    blockNumber: '101',
    blockHash: `0x${seed.repeat(64)}`,
  });
  return {
    schemaVersion: 1,
    environment: 'testnet',
    createdAt: '2026-11-13T14:00:00.000Z',
    sourceCommit: '2'.repeat(40),
    routeId: 'ethereum-sepolia-to-base-sepolia-v1',
    routeDependenciesHash: `0x${'2'.repeat(64)}`,
    workflowWriteSwitchEnabled: false,
    upstream: {
      repository: 'https://github.com/morpho-org/morpho-blue',
      commit: '1'.repeat(40),
      sourceManifestHash: `0x${'3'.repeat(64)}`,
      compilerVersion: '0.8.19',
      evmVersion: 'paris',
      viaIr: true,
      optimizerRuns: 999_999,
    },
    chainId: 84_532,
    deploymentBlockNumber: '100',
    deployer: '0x1000000000000000000000000000000000000001',
    owner: '0x1000000000000000000000000000000000000002',
    contracts: {
      morpho: contract('Morpho', '0x2000000000000000000000000000000000000001', '4'),
      irm: contract('AdaptiveCurveIrm', '0x2000000000000000000000000000000000000002', '5'),
      oracle: contract(
        'DebtShiftChainlinkOracle',
        '0x2000000000000000000000000000000000000003',
        '6',
      ),
    },
    tokens: {
      collateral: code('0x3000000000000000000000000000000000000001', '7', 18),
      loan: code('0x3000000000000000000000000000000000000002', '8', 6),
    },
    feeds: {
      collateral: code('0x4000000000000000000000000000000000000001', '9'),
      loan: code('0x4000000000000000000000000000000000000002', 'a'),
      sequencerUptime: null,
      collateralMaxPriceAgeSeconds: '3600',
      loanMaxPriceAgeSeconds: '90000',
      sequencerGracePeriodSeconds: '0',
    },
    market: {
      id: `0x${'b'.repeat(64)}`,
      loanToken: '0x3000000000000000000000000000000000000002',
      collateralToken: '0x3000000000000000000000000000000000000001',
      oracle: '0x2000000000000000000000000000000000000003',
      irm: '0x2000000000000000000000000000000000000002',
      lltv: '860000000000000000',
      seedLiquidityOwner: '0x1000000000000000000000000000000000000002',
      seedLiquidityAssets: '1000000',
      seedLiquidityShares: '1000000000000',
      oraclePriceAtDeployment: '2000000000000000000000000000',
      totalSupplyAssetsAtDeployment: '1000000',
      availableLiquidityAtDeployment: '1000000',
    },
    configurationTransactions: ['c', 'd', 'e', 'f', '1', '2'].map((seed, index) =>
      transaction(`configuration ${index}`, seed),
    ),
  } as const;
}

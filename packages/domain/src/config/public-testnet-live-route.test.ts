import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';

import {
  derivePublicTestnetLiveRoute,
  parsePublicTestnetLiveRoutePolicy,
} from './public-testnet-live-route.js';
import { parsePublicTestnetRouteDependencies } from './public-testnet-route.js';
import { parseTestnetMorphoDeploymentManifest } from './testnet-morpho-deployment.js';

const dependenciesJson = readFileSync(
  new URL(
    '../../../../config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json',
    import.meta.url,
  ),
  'utf8',
);
const policyJson = readFileSync(
  new URL(
    '../../../../config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.policy.v1.json',
    import.meta.url,
  ),
  'utf8',
);
const dependencies = parsePublicTestnetRouteDependencies(dependenciesJson);
const routeDependenciesHash = keccak256(stringToHex(dependenciesJson));
const generationPolicy = parsePublicTestnetLiveRoutePolicy(policyJson);

describe('public testnet executable route derivation', () => {
  it('derives every protocol, token, feed, and market binding without fake provider asset IDs', () => {
    const morphoManifest = validMorphoManifest();
    const route = derivePublicTestnetLiveRoute({
      dependencies,
      routeDependenciesHash,
      morphoManifest,
      generationPolicy,
    });

    expect(route.source.pool).toBe(dependencies.source.pool);
    expect(route.source.collateralAsset.providerAssetId).toBeUndefined();
    expect(route.prices.sourceCollateralUsd.address).toBe(
      dependencies.source.collateralFeed.address,
    );
    expect(route.prices.sourceDebtUsd.maximumAgeSeconds).toBe(90_000);
    expect(route.destination.morpho).toBe(morphoManifest.contracts.morpho.address);
    expect(route.destination.marketId).toBe(morphoManifest.market.id);
    expect(route.destination.morphoOracleFeeds).toEqual([
      {
        address: dependencies.destination.collateralFeed.address,
        maximumAgeSeconds: dependencies.destination.collateralFeed.maximumAgeSeconds,
      },
      {
        address: dependencies.destination.loanFeed.address,
        maximumAgeSeconds: dependencies.destination.loanFeed.maximumAgeSeconds,
      },
    ]);
  });

  it('rejects dependency hashes and manifested feed bindings that drift independently', () => {
    const morphoManifest = validMorphoManifest();
    expect(() =>
      derivePublicTestnetLiveRoute({
        dependencies,
        routeDependenciesHash: `0x${'ff'.repeat(32)}`,
        morphoManifest,
        generationPolicy,
      }),
    ).toThrow('Morpho manifest dependency hash');

    expect(() =>
      derivePublicTestnetLiveRoute({
        dependencies,
        routeDependenciesHash,
        morphoManifest: {
          ...morphoManifest,
          feeds: {
            ...morphoManifest.feeds,
            collateral: {
              ...morphoManifest.feeds.collateral,
              address: '0x5000000000000000000000000000000000000005',
            },
          },
        },
        generationPolicy,
      }),
    ).toThrow('Morpho collateral feed');
  });

  it('rejects a route policy whose maximum LTV exceeds the manifested market LLTV', () => {
    expect(() =>
      derivePublicTestnetLiveRoute({
        dependencies,
        routeDependenciesHash,
        morphoManifest: validMorphoManifest(),
        generationPolicy: {
          ...generationPolicy,
          policy: { ...generationPolicy.policy, maximumLtvBps: 8_001 },
        },
      }),
    ).toThrow('maximum LTV exceeds');
  });
});

function validMorphoManifest() {
  const deployer = '0x1000000000000000000000000000000000000001';
  const contract = (artifact: string, address: string, byte: string) => ({
    artifact,
    address,
    artifactCreationCodeHash: `0x${byte.repeat(64)}`,
    deploymentTransactionHash: `0x${byte.repeat(64)}`,
    deploymentTransactionInputHash: `0x${byte.repeat(64)}`,
    deploymentBlockNumber: '100',
    deploymentBlockHash: `0x${byte.repeat(64)}`,
    runtimeCodeHash: `0x${byte.repeat(64)}`,
  });
  const observed = (address: string, decimals: number, byte: string) => ({
    address,
    decimals,
    runtimeCodeHash: `0x${byte.repeat(64)}`,
  });
  const transaction = (index: number) => {
    const byte = (index + 1).toString(16);
    return {
      action: `configuration-${index}`,
      transactionHash: `0x${byte.repeat(64)}`,
      transactionInputHash: `0x${byte.repeat(64)}`,
      sender: deployer,
      target: '0x2000000000000000000000000000000000000001',
      blockNumber: (101 + index).toString(),
      blockHash: `0x${byte.repeat(64)}`,
    };
  };
  const morpho = contract('Morpho', '0x2000000000000000000000000000000000000001', '1');
  const irm = contract('AdaptiveCurveIrm', '0x2000000000000000000000000000000000000002', '2');
  const oracle = contract(
    'DebtShiftChainlinkOracle',
    '0x2000000000000000000000000000000000000003',
    '3',
  );
  return parseTestnetMorphoDeploymentManifest(
    JSON.stringify({
      schemaVersion: 1,
      environment: 'testnet',
      createdAt: '2026-11-13T16:00:00.000Z',
      sourceCommit: '1'.repeat(40),
      routeId: dependencies.routeId,
      routeDependenciesHash,
      workflowWriteSwitchEnabled: false,
      upstream: {
        repository: 'https://github.com/morpho-org/morpho-blue',
        commit: '2'.repeat(40),
        sourceManifestHash: `0x${'4'.repeat(64)}`,
        compilerVersion: '0.8.19',
        evmVersion: 'paris',
        viaIr: true,
        optimizerRuns: 999_999,
      },
      chainId: dependencies.destination.chainId,
      deploymentBlockNumber: '100',
      deployer,
      owner: '0x1000000000000000000000000000000000000002',
      contracts: { morpho, irm, oracle },
      tokens: {
        collateral: observed(
          dependencies.destination.collateralAsset.address,
          dependencies.destination.collateralAsset.decimals,
          '5',
        ),
        loan: observed(
          dependencies.destination.loanAsset.address,
          dependencies.destination.loanAsset.decimals,
          '6',
        ),
      },
      feeds: {
        collateral: observed(
          dependencies.destination.collateralFeed.address,
          dependencies.destination.collateralFeed.decimals,
          '7',
        ),
        loan: observed(
          dependencies.destination.loanFeed.address,
          dependencies.destination.loanFeed.decimals,
          '8',
        ),
        sequencerUptime: null,
        collateralMaxPriceAgeSeconds:
          dependencies.destination.collateralFeed.maximumAgeSeconds.toString(),
        loanMaxPriceAgeSeconds: dependencies.destination.loanFeed.maximumAgeSeconds.toString(),
        sequencerGracePeriodSeconds:
          dependencies.destination.sequencerGracePeriodSeconds.toString(),
      },
      market: {
        id: `0x${'9'.repeat(64)}`,
        loanToken: dependencies.destination.loanAsset.address,
        collateralToken: dependencies.destination.collateralAsset.address,
        oracle: oracle.address,
        irm: irm.address,
        lltv: dependencies.destination.lltv,
        seedLiquidityOwner: '0x1000000000000000000000000000000000000002',
        seedLiquidityAssets: dependencies.destination.minimumSeedLiquidityUnits,
        seedLiquidityShares: dependencies.destination.minimumSeedLiquidityUnits,
        oraclePriceAtDeployment: '1000000000000000000',
        totalSupplyAssetsAtDeployment: dependencies.destination.minimumSeedLiquidityUnits,
        availableLiquidityAtDeployment: dependencies.destination.minimumSeedLiquidityUnits,
      },
      configurationTransactions: Array.from({ length: 6 }, (_, index) => transaction(index)),
    }),
  );
}

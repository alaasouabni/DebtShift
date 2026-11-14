import { describe, expect, it } from 'vitest';

import { parsePublicTestnetRouteDependencies } from './public-testnet-route.js';

describe('public testnet route dependencies', () => {
  it('accepts a write-disabled cross-chain candidate with explicit transport limits', () => {
    const route = parsePublicTestnetRouteDependencies(JSON.stringify(validRoute()));

    expect(route.environment).toBe('testnet');
    expect(route.workflowWriteSwitchEnabled).toBe(false);
    expect(route.transport.testnetBoundary).toBe('SIMULATED_UNAVAILABLE_PROVIDER_BOUNDARY');
    expect(route.source.collateralFeed.expectedDescription).toBe('ETH / USD');
    expect(route.destination.sequencerUptimeFeed).toBeNull();
  });

  it('rejects execution authority, insecure provenance, and unsafe feed bindings', () => {
    expect(() =>
      parsePublicTestnetRouteDependencies(
        JSON.stringify({ ...validRoute(), workflowWriteSwitchEnabled: true }),
      ),
    ).toThrow();
    expect(() =>
      parsePublicTestnetRouteDependencies(
        JSON.stringify({
          ...validRoute(),
          source: {
            ...validRoute().source,
            addressBook: {
              ...validRoute().source.addressBook,
              manifestUrl: 'http://example.com/manifest.json',
            },
          },
        }),
      ),
    ).toThrow('Public references must use HTTPS');
    expect(() =>
      parsePublicTestnetRouteDependencies(
        JSON.stringify({
          ...validRoute(),
          destination: {
            ...validRoute().destination,
            loanFeed: {
              ...validRoute().destination.loanFeed,
              address: validRoute().destination.collateralFeed.address,
            },
          },
        }),
      ),
    ).toThrow('feeds must differ');
    expect(() =>
      parsePublicTestnetRouteDependencies(
        JSON.stringify({
          ...validRoute(),
          destination: {
            ...validRoute().destination,
            loanFeed: {
              ...validRoute().destination.loanFeed,
              heartbeatSeconds: 90_000,
              maximumAgeSeconds: 86_400,
            },
          },
        }),
      ),
    ).toThrow('maximum age must cover');
    expect(() =>
      parsePublicTestnetRouteDependencies(
        JSON.stringify({
          ...validRoute(),
          source: {
            ...validRoute().source,
            debtFeed: {
              ...validRoute().source.debtFeed,
              address: validRoute().source.collateralFeed.address,
            },
          },
        }),
      ),
    ).toThrow('Source collateral and debt feeds must differ');
  });
});

function validRoute() {
  const token = (address: string, decimals: number, symbol: string) => ({
    address,
    decimals,
    symbol,
  });
  const address = (seed: string) => `0x${seed.padEnd(40, '0')}`;
  const aaveAsset = (tokenAddress: string, decimals: number, symbol: string, suffix: string) => ({
    ...token(tokenAddress, decimals, symbol),
    aToken: address(`${suffix}1`),
    variableDebtToken: address(`${suffix}2`),
    oracle: address(`${suffix}3`),
  });
  const feed = (address: string, path: string, description: string) => ({
    address,
    registryPath: path,
    expectedDescription: description,
    decimals: 8,
    heartbeatSeconds: 3_600,
    maximumAgeSeconds: 7_200,
  });
  return {
    schemaVersion: 1,
    routeId: 'ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue-weth-usdc-v1',
    environment: 'testnet',
    status: 'candidate-dependencies',
    workflowWriteSwitchEnabled: false,
    source: {
      chainId: 11_155_111,
      network: 'Ethereum Sepolia',
      addressBook: {
        manifestUrl: 'https://aave.example/manifest.json',
        moduleName: 'AaveV3Sepolia',
        commit: '1'.repeat(40),
        aggregateSha256: '2'.repeat(64),
        moduleSha256: '3'.repeat(64),
        moduleBytes: 4_799,
      },
      references: {
        chainlinkDirectoryUrl: 'https://chainlink.example/feeds',
        chainlinkRegistryUrl: 'https://chainlink.example/ethereum-sepolia.json',
      },
      pool: '0x1000000000000000000000000000000000000001',
      poolAddressesProvider: '0x1000000000000000000000000000000000000002',
      dataProvider: '0x1000000000000000000000000000000000000003',
      oracle: '0x1000000000000000000000000000000000000004',
      faucet: '0x1000000000000000000000000000000000000005',
      collateralAsset: aaveAsset('0x2000000000000000000000000000000000000001', 18, 'WETH', '21'),
      debtAsset: aaveAsset('0x2000000000000000000000000000000000000002', 6, 'USDC', '22'),
      collateralFeed: feed('0x2000000000000000000000000000000000000003', 'eth-usd', 'ETH / USD'),
      debtFeed: feed('0x2000000000000000000000000000000000000004', 'usdc-usd', 'USDC / USD'),
    },
    destination: {
      chainId: 84_532,
      network: 'Base Sepolia',
      references: {
        baseContractsUrl: 'https://base.example/contracts',
        circleUsdcUrl: 'https://circle.example/usdc',
        chainlinkDirectoryUrl: 'https://chainlink.example/feeds',
        chainlinkRegistryUrl: 'https://chainlink.example/base-sepolia.json',
        chainlinkSequencerFeedsUrl: 'https://chainlink.example/sequencer',
      },
      collateralAsset: token('0x3000000000000000000000000000000000000001', 18, 'WETH'),
      loanAsset: token('0x3000000000000000000000000000000000000002', 6, 'USDC'),
      collateralFeed: feed('0x4000000000000000000000000000000000000001', 'eth-usd', 'ETH / USD'),
      loanFeed: feed('0x4000000000000000000000000000000000000002', 'usdc-usd', 'USDC / USD'),
      sequencerUptimeFeed: null,
      sequencerGracePeriodSeconds: 0,
      lltv: '800000000000000000',
      minimumSeedLiquidityUnits: '10000000',
    },
    transport: {
      provider: 'NEAR_INTENTS_1CLICK',
      testnetBoundary: 'SIMULATED_UNAVAILABLE_PROVIDER_BOUNDARY',
      sourceAndDestinationTransfers: 'REAL_PUBLIC_CHAIN_TRANSACTIONS',
      collateralMapping: { sourceSymbol: 'WETH', destinationSymbol: 'WETH' },
      debtMapping: { sourceSymbol: 'USDC', destinationSymbol: 'USDC' },
    },
  } as const;
}

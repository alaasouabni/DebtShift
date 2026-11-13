import { readFile } from 'node:fs/promises';

import { parseLiveMarketConfiguration } from '../packages/domain/dist/index.js';
import { OneClickReadOnlyClient } from '../packages/intents/dist/index.js';
import {
  ChainlinkOracleFreshnessReader,
  ChainlinkPriceReader,
  MorphoBlueReadAdapter,
  readAaveReserveTokenAddresses,
} from '../packages/protocols/dist/index.js';
import { createPublicClient, getAddress, http, isAddressEqual } from 'viem';

const ROUTE_PATH = new URL(
  '../config/routes/base-aave-v3-to-arbitrum-morpho-blue.v1.json',
  import.meta.url,
);
const BASE_CHAIN_ID = 8453;
const ARBITRUM_CHAIN_ID = 42161;
const baseRpcUrl = validatedRpcUrl(
  process.env.BASE_READ_RPC_URL ?? 'https://mainnet.base.org',
  'BASE_READ_RPC_URL',
);
const arbitrumRpcUrl = validatedRpcUrl(
  process.env.ARBITRUM_READ_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',
  'ARBITRUM_READ_RPC_URL',
);

const configuration = parseLiveMarketConfiguration(await readFile(ROUTE_PATH, 'utf8'));
const baseClient = publicClient(BASE_CHAIN_ID, 'Base', baseRpcUrl);
const arbitrumClient = publicClient(ARBITRUM_CHAIN_ID, 'Arbitrum One', arbitrumRpcUrl);

const [baseChainId, arbitrumChainId, baseBlock, arbitrumBlock] = await Promise.all([
  baseClient.getChainId(),
  arbitrumClient.getChainId(),
  baseClient.getBlock({ blockTag: 'latest' }),
  arbitrumClient.getBlock({ blockTag: 'latest' }),
]);
if (baseChainId !== BASE_CHAIN_ID || arbitrumChainId !== ARBITRUM_CHAIN_ID) {
  throw new Error(`Route RPC chain mismatch: received ${baseChainId} and ${arbitrumChainId}.`);
}

const [collateralReserve, debtReserve] = await Promise.all([
  readAaveReserveTokenAddresses(
    baseClient,
    configuration.source.dataProvider,
    configuration.source.collateralAsset.address,
  ),
  readAaveReserveTokenAddresses(
    baseClient,
    configuration.source.dataProvider,
    configuration.source.debtAsset.address,
  ),
]);

const oracleFreshness = new ChainlinkOracleFreshnessReader(arbitrumClient, {
  morphoOracle: configuration.destination.morphoOracle,
  feeds: configuration.destination.morphoOracleFeeds,
  ...(configuration.destination.sequencerUptimeFeed === undefined
    ? {}
    : { sequencerUptimeFeed: configuration.destination.sequencerUptimeFeed }),
});
const morpho = new MorphoBlueReadAdapter(
  arbitrumClient,
  { chainId: ARBITRUM_CHAIN_ID, morpho: configuration.destination.morpho },
  oracleFreshness,
);
const market = await morpho.readMarket(configuration.destination.marketId, 1n);
assertAddress(
  'Morpho collateral token',
  market.params.collateralToken,
  configuration.destination.collateralAsset.address,
);
assertAddress(
  'Morpho loan token',
  market.params.loanToken,
  configuration.destination.debtAsset.address,
);
assertAddress('Morpho oracle', market.params.oracle, configuration.destination.morphoOracle);
if (BigInt(market.availableBorrowUnits) <= 0n) {
  throw new Error('Configured Morpho market has no available borrow liquidity.');
}

const [basePrices, arbitrumPrices] = await Promise.all([
  readPrices(baseClient, baseBlock, configuration.source.sequencerUptimeFeed, [
    configuration.prices.sourceCollateralUsd,
    configuration.prices.sourceDebtUsd,
    configuration.prices.sourceNativeUsd,
  ]),
  readPrices(arbitrumClient, arbitrumBlock, configuration.destination.sequencerUptimeFeed, [
    configuration.prices.destinationCollateralUsd,
    configuration.prices.destinationDebtUsd,
    configuration.prices.destinationNativeUsd,
  ]),
]);

await assertContracts(baseClient, [
  configuration.source.pool,
  configuration.source.dataProvider,
  configuration.source.collateralAsset.address,
  configuration.source.debtAsset.address,
  collateralReserve.aToken,
  debtReserve.variableDebtToken,
]);
await assertContracts(arbitrumClient, [
  configuration.destination.morpho,
  configuration.destination.morphoOracle,
  configuration.destination.collateralAsset.address,
  configuration.destination.debtAsset.address,
  market.params.irm,
]);

const catalog = await new OneClickReadOnlyClient({
  baseUrl: 'https://1click.chaindefuser.com',
}).getTokenCatalogObservation();
const expectedAssets = [
  configuration.source.collateralAsset,
  configuration.source.debtAsset,
  configuration.destination.collateralAsset,
  configuration.destination.debtAsset,
];
for (const expected of expectedAssets) {
  const actual = catalog.tokens.find(({ assetId }) => assetId === expected.providerAssetId);
  if (actual === undefined) {
    throw new Error(`1Click catalog is missing ${expected.providerAssetId}.`);
  }
  if (actual.decimals !== expected.decimals || actual.symbol !== expected.symbol) {
    throw new Error(`1Click catalog metadata changed for ${expected.providerAssetId}.`);
  }
}

console.log(
  JSON.stringify({
    route: 'base-aave-v3-weth-usdc-to-arbitrum-morpho-blue-weth-usdc-v1',
    source: {
      chainId: BASE_CHAIN_ID,
      blockNumber: baseBlock.number.toString(),
      pool: getAddress(configuration.source.pool),
      collateralAToken: collateralReserve.aToken,
      debtVariableDebtToken: debtReserve.variableDebtToken,
      priceObservations: basePrices,
    },
    destination: {
      chainId: ARBITRUM_CHAIN_ID,
      blockNumber: arbitrumBlock.number.toString(),
      morpho: getAddress(configuration.destination.morpho),
      marketId: configuration.destination.marketId,
      lltvWad: market.params.lltv.toString(),
      availableBorrowUnits: market.availableBorrowUnits,
      currentBorrowAprBps: market.currentBorrowAprBps,
      priceObservations: arbitrumPrices,
    },
    transport: {
      provider: 'NEAR_INTENTS_1CLICK',
      catalogObservedAt: catalog.observedAt,
      catalogResponseHash: catalog.responseHash,
      originAsset: configuration.source.collateralAsset.providerAssetId,
      destinationAsset: configuration.destination.collateralAsset.providerAssetId,
    },
  }),
);

function publicClient(chainId, name, rpcUrl) {
  const chain = {
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
}

function validatedRpcUrl(value, label) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
  return parsed.toString();
}

async function readPrices(client, block, sequencerUptimeFeed, feeds) {
  const reader = new ChainlinkPriceReader(
    client,
    sequencerUptimeFeed === undefined ? undefined : sequencerUptimeFeed,
  );
  const observedAt = new Date(Number(block.timestamp) * 1_000).toISOString();
  const unique = new Map(feeds.map((feed) => [feed.address.toLowerCase(), feed]));
  return Promise.all(
    [...unique.values()].map(async (feed) => {
      const observation = await reader.readAtBlock(feed, block.number, observedAt);
      return {
        feed: observation.feed,
        answer: observation.answer.toString(),
        decimals: observation.decimals,
        updatedAt: observation.updatedAt,
      };
    }),
  );
}

async function assertContracts(client, addresses) {
  const unique = [...new Set(addresses.map((address) => getAddress(address)))];
  await Promise.all(
    unique.map(async (address) => {
      const code = await client.getCode({ address });
      if (code === undefined || code === '0x') {
        throw new Error(`Expected deployed contract at ${address}.`);
      }
    }),
  );
}

function assertAddress(label, actual, expected) {
  if (!isAddressEqual(actual, getAddress(expected))) {
    throw new Error(`${label} does not match the configured route.`);
  }
}

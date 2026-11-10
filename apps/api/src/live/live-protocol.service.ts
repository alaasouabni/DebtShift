import {
  hashCanonicalText,
  parseLiveMarketConfiguration,
  type LiveMarketConfiguration,
  type PositionSnapshot,
  type TokenReference,
} from '@debtshift/domain';
import { AaveV3ReadAdapter } from '@debtshift/protocols';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, getAddress, http, type Address, type PublicClient } from 'viem';

import type { DebtShiftRouteDefinition, ProtocolDataPort } from '../market-data/ports.js';

@Injectable()
export class LiveProtocolService implements ProtocolDataPort {
  readonly provider = 'LIVE_READ_ONLY' as const;
  readonly #client: PublicClient;
  readonly #adapter: AaveV3ReadAdapter;
  readonly #configuration: Readonly<LiveMarketConfiguration>;
  readonly #route: DebtShiftRouteDefinition;

  constructor(@Inject(ConfigService) config: ConfigService) {
    if (config.getOrThrow<string>('MARKET_DATA_PROVIDER') !== 'LIVE_READ_ONLY') {
      throw new Error('Live protocol data requires MARKET_DATA_PROVIDER=LIVE_READ_ONLY.');
    }
    this.#configuration = parseLiveMarketConfiguration(
      config.getOrThrow<string>('LIVE_MARKET_CONFIG_JSON'),
    );
    const sourceChainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    const destinationChainId = config.getOrThrow<number>('DESTINATION_CHAIN_ID');
    this.#client = createPublicClient({
      transport: http(config.getOrThrow<string>('SOURCE_RPC_URL')),
    });
    const sourceCollateralAsset = token(sourceChainId, this.#configuration.source.collateralAsset);
    const sourceDebtAsset = token(sourceChainId, this.#configuration.source.debtAsset);
    const destinationCollateralAsset = token(
      destinationChainId,
      this.#configuration.destination.collateralAsset,
    );
    const destinationDebtAsset = token(
      destinationChainId,
      this.#configuration.destination.debtAsset,
    );
    this.#adapter = new AaveV3ReadAdapter(this.#client, {
      chainId: sourceChainId,
      pool: this.#configuration.source.pool,
      dataProvider: this.#configuration.source.dataProvider,
      collateralAsset: sourceCollateralAsset,
      debtAsset: sourceDebtAsset,
    });
    this.#route = {
      sourceMarket: {
        chainId: sourceChainId,
        protocol: 'AAVE_V3',
        deployment: getAddress(this.#configuration.source.pool),
        marketId: hashCanonicalText(
          `debtshift.aave-v3-market.v1:${sourceChainId}:${this.#configuration.source.pool.toLowerCase()}`,
        ),
      },
      targetMarket: {
        chainId: destinationChainId,
        protocol: 'MORPHO_BLUE',
        deployment: getAddress(this.#configuration.destination.morpho),
        marketId: this.#configuration.destination.marketId,
      },
      sourceDebtAsset,
      sourceCollateralAsset,
      destinationDebtAsset,
      destinationCollateralAsset,
      execution: { kind: 'READ_ONLY' },
    };
  }

  get route(): DebtShiftRouteDefinition {
    return this.#route;
  }

  get configuration(): Readonly<LiveMarketConfiguration> {
    return this.#configuration;
  }

  get sourceClient(): PublicClient {
    return this.#client;
  }

  async getSourcePosition(borrowerInput: string): Promise<PositionSnapshot> {
    const position = await this.#adapter.readPosition(getAddress(borrowerInput));
    if (position === undefined) {
      throw new Error('No supported Aave V3 source position was found for this wallet.');
    }
    return position;
  }

  async verifySourceSnapshot(snapshot: PositionSnapshot): Promise<void> {
    if (snapshot.position.market.protocol !== 'AAVE_V3') {
      throw new Error('Live source verification accepts only Aave V3 snapshots.');
    }
    const blockNumber = BigInt(snapshot.block.number);
    const canonicalBlock = await this.#client.getBlock({ blockNumber });
    if (canonicalBlock.hash?.toLowerCase() !== snapshot.block.hash.toLowerCase()) {
      throw new Error('Aave source snapshot block is no longer canonical.');
    }
    const historical = await this.#adapter.readPosition(snapshot.position.borrower, blockNumber);
    if (historical === undefined || historical.snapshotId !== snapshot.snapshotId) {
      throw new Error('Aave source snapshot does not match its referenced block state.');
    }
    const current = await this.#adapter.readPosition(snapshot.position.borrower);
    if (
      current === undefined ||
      current.collateralUnits !== snapshot.collateralUnits ||
      current.debtUnits !== snapshot.debtUnits ||
      current.position.market.marketId !== snapshot.position.market.marketId
    ) {
      throw new Error('Aave source position changed after route preparation.');
    }
  }
}

function token(
  chainId: number,
  configuration: {
    readonly address: Address;
    readonly decimals: number;
    readonly symbol: string;
    readonly providerAssetId: string;
  },
): TokenReference & { readonly symbol: string; readonly providerAssetId: string } {
  return {
    chainId,
    address: getAddress(configuration.address),
    decimals: configuration.decimals,
    symbol: configuration.symbol,
    providerAssetId: configuration.providerAssetId,
  };
}

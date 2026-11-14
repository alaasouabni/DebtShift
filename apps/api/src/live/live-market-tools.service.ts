import type { PositionSnapshot, ProviderQuote, TokenReference } from '@debtshift/domain';
import { hashCanonicalText, marketSnapshotSchema } from '@debtshift/domain';
import type { RouteRiskTools } from '@debtshift/agent';
import { verifyOneClickRouteAssets } from '@debtshift/intents';
import {
  routeCandidateSchema,
  routePolicySchema,
  type RouteCandidate,
  type RoutePolicy,
} from '@debtshift/optimizer';
import {
  ChainlinkOracleFreshnessReader,
  ChainlinkPriceReader,
  MorphoMarketDiscoveryClient,
  MorphoBlueReadAdapter,
  type DiscoveredMorphoMarket,
  type ChainlinkPriceObservation,
} from '@debtshift/protocols';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, getAddress, http, isAddressEqual, type Address } from 'viem';

import type { MarketIntelligencePort } from '../market-data/ports.js';
import { TransportService } from '../transport.service.js';
import { LiveProtocolService } from './live-protocol.service.js';

const USD_DECIMALS = 6;
const MORPHO_ORACLE_SCALE = 10n ** 36n;

interface TargetMarketDiscovery {
  readonly marketId: `0x${string}`;
  readonly indexed?: DiscoveredMorphoMarket;
}

/**
 * Live, read-only route intelligence. It uses direct Aave/Morpho/Chainlink
 * reads and environment-gated transport analysis quotes: explicitly simulated
 * on testnet and authenticated 1Click dry quotes in mainnet read-only mode.
 */
@Injectable()
export class LiveMarketToolsService implements RouteRiskTools, MarketIntelligencePort {
  readonly provider = 'LIVE_READ_ONLY' as const;
  readonly #destinationClient;
  readonly #morpho: MorphoBlueReadAdapter;
  readonly #sourcePrices: ChainlinkPriceReader;
  readonly #destinationPrices: ChainlinkPriceReader;
  readonly #sourceDebtBufferBps: number;
  readonly #mode: 'testnet' | 'mainnet-readonly' | 'mainnet';
  readonly #marketDiscovery: MorphoMarketDiscoveryClient;

  constructor(
    @Inject(LiveProtocolService) private readonly protocols: LiveProtocolService,
    @Inject(TransportService) private readonly transport: TransportService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    const configuration = protocols.configuration;
    this.#mode = config.getOrThrow<'testnet' | 'mainnet-readonly' | 'mainnet'>('DEBTSHIFT_MODE');
    this.#sourceDebtBufferBps = config.get<number>('SOURCE_DEBT_BUFFER_BPS') ?? 10;
    this.#marketDiscovery = new MorphoMarketDiscoveryClient();
    this.#destinationClient = createPublicClient({
      transport: http(config.getOrThrow<string>('DESTINATION_RPC_URL')),
    });
    const destinationSequencer = configuration.destination.sequencerUptimeFeed;
    const oracleFreshness = new ChainlinkOracleFreshnessReader(this.#destinationClient, {
      morphoOracle: configuration.destination.morphoOracle,
      feeds: configuration.destination.morphoOracleFeeds,
      ...(destinationSequencer === undefined ? {} : { sequencerUptimeFeed: destinationSequencer }),
    });
    this.#morpho = new MorphoBlueReadAdapter(
      this.#destinationClient,
      {
        chainId: config.getOrThrow<number>('DESTINATION_CHAIN_ID'),
        morpho: configuration.destination.morpho,
      },
      oracleFreshness,
    );
    this.#sourcePrices = new ChainlinkPriceReader(
      protocols.sourceClient,
      configuration.source.sequencerUptimeFeed,
    );
    this.#destinationPrices = new ChainlinkPriceReader(
      this.#destinationClient,
      destinationSequencer,
    );
  }

  createPolicy(evaluatedAt: string): RoutePolicy {
    const policy = this.protocols.configuration.policy;
    return routePolicySchema.parse({
      evaluatedAt,
      horizonDays: policy.horizonDays,
      maxAllInCostUsdMicro: policy.maxAllInCostUsdMicro,
      minAprReductionBps: policy.minAprReductionBps,
      maxPositionSnapshotAgeSeconds: policy.maxPositionSnapshotAgeSeconds,
      maxMarketSnapshotAgeSeconds: policy.maxMarketSnapshotAgeSeconds,
      maxOracleAgeSeconds: policy.maxOracleAgeSeconds,
      minimumLiquidityBufferBps: policy.minimumLiquidityBufferBps,
      stressCollateralDropBps: policy.stressCollateralDropBps,
      stressTargetAprIncreaseBps: policy.stressTargetAprIncreaseBps,
      requirePositiveNetBenefit: true,
      safetyPolicy: {
        kind: 'MAX_LTV_BPS',
        maximumLtvBps: policy.maximumLtvBps,
        stressMaximumLtvBps: policy.stressMaximumLtvBps,
      },
    });
  }

  async getSourcePositions(
    wallet: Address,
    chainIds: readonly number[],
  ): Promise<readonly PositionSnapshot[]> {
    if (!chainIds.includes(this.protocols.route.sourceMarket.chainId)) return [];
    return [await this.protocols.getSourcePosition(wallet)];
  }

  async getRouteCandidates(
    position: PositionSnapshot,
    evaluatedAt: string,
  ): Promise<readonly RouteCandidate[]> {
    const route = this.protocols.route;
    assertSameToken(position.position.debtAsset, route.sourceDebtAsset, 'source debt');
    assertSameToken(
      position.position.collateralAsset,
      route.sourceCollateralAsset,
      'source collateral',
    );
    const deadline = new Date(Date.parse(evaluatedAt) + 5 * 60 * 1_000).toISOString();
    const sourceDebtMaximumUnits = addBasisPointHeadroom(
      BigInt(position.debtUnits),
      this.#sourceDebtBufferBps,
    );
    const quoteBase = {
      maxSlippageBps: 50,
      destinationReceiver: position.position.borrower,
      refundReceiver: position.position.borrower,
      deadline,
    } as const;
    const [collateralQuote, debtForwardQuote, debtReverseQuote] = await Promise.all([
      this.transport.getAnalysisQuote({
        inputAsset: route.sourceCollateralAsset,
        outputAsset: route.destinationCollateralAsset,
        amountUnits: position.collateralUnits,
        amountKind: 'EXACT_INPUT',
        ...quoteBase,
      }),
      this.transport.getAnalysisQuote({
        inputAsset: route.sourceDebtAsset,
        outputAsset: route.destinationDebtAsset,
        amountUnits: sourceDebtMaximumUnits.toString(),
        amountKind: 'EXACT_INPUT',
        ...quoteBase,
      }),
      this.transport.getAnalysisQuote({
        inputAsset: route.destinationDebtAsset,
        outputAsset: route.sourceDebtAsset,
        amountUnits: sourceDebtMaximumUnits.toString(),
        amountKind: 'EXACT_OUTPUT',
        ...quoteBase,
      }),
    ]);
    const settlementPayoffUnits = maxBigInt(
      BigInt(debtForwardQuote.expectedAmountOutUnits),
      BigInt(debtReverseQuote.amountInUnits),
    );
    const discoveredTargets = await this.#discoverTargetMarkets(route);
    const markets = await Promise.all(
      discoveredTargets.map(async (target) => {
        const market = await this.#morpho.readMarket(target.marketId, settlementPayoffUnits);
        this.#assertMarketIdentity(market.params, target.indexed);
        return market;
      }),
    );
    const referenceMarket = markets[0];
    if (referenceMarket === undefined) {
      throw new Error('No onchain-verified Morpho market remained after discovery.');
    }
    if (
      markets.some((market) => market.snapshot.block.hash !== referenceMarket.snapshot.block.hash)
    ) {
      throw new Error('Discovered Morpho markets were not observed at one canonical block.');
    }
    const sourceBlock = await this.protocols.sourceClient.getBlock({ blockTag: 'latest' });
    const sourceObservedAt = new Date(Number(sourceBlock.timestamp) * 1_000).toISOString();
    const destinationBlockNumber = BigInt(referenceMarket.snapshot.block.number);
    const configuration = this.protocols.configuration;
    const [
      sourceCollateralUsd,
      sourceDebtUsd,
      sourceNativeUsd,
      destinationCollateralUsd,
      destinationDebtUsd,
      destinationNativeUsd,
      sourceGasPrice,
      destinationGasPrice,
    ] = await Promise.all([
      this.#sourcePrices.readAtBlock(
        configuration.prices.sourceCollateralUsd,
        sourceBlock.number,
        sourceObservedAt,
      ),
      this.#sourcePrices.readAtBlock(
        configuration.prices.sourceDebtUsd,
        sourceBlock.number,
        sourceObservedAt,
      ),
      this.#sourcePrices.readAtBlock(
        configuration.prices.sourceNativeUsd,
        sourceBlock.number,
        sourceObservedAt,
      ),
      this.#destinationPrices.readAtBlock(
        configuration.prices.destinationCollateralUsd,
        destinationBlockNumber,
        referenceMarket.snapshot.block.observedAt,
      ),
      this.#destinationPrices.readAtBlock(
        configuration.prices.destinationDebtUsd,
        destinationBlockNumber,
        referenceMarket.snapshot.block.observedAt,
      ),
      this.#destinationPrices.readAtBlock(
        configuration.prices.destinationNativeUsd,
        destinationBlockNumber,
        referenceMarket.snapshot.block.observedAt,
      ),
      this.protocols.sourceClient.getGasPrice(),
      this.#destinationClient.getGasPrice(),
    ]);
    const inputCollateralUsd = usdMicroFloor(
      BigInt(position.collateralUnits),
      route.sourceCollateralAsset.decimals,
      sourceCollateralUsd,
    );
    const expectedCollateralUsd = usdMicroFloor(
      BigInt(collateralQuote.expectedAmountOutUnits),
      route.destinationCollateralAsset.decimals,
      destinationCollateralUsd,
    );
    const minimumCollateralUsd = usdMicroFloor(
      BigInt(collateralQuote.minAmountOutUnits),
      route.destinationCollateralAsset.decimals,
      destinationCollateralUsd,
    );
    const transportFeeUsd = zeroFloorSubtract(inputCollateralUsd, expectedCollateralUsd);
    const slippageUsd = zeroFloorSubtract(expectedCollateralUsd, minimumCollateralUsd);
    const sourceGasUsd = usdMicroCeil(
      BigInt(configuration.analyticsCosts.sourceGasUnitsUpperBound) * sourceGasPrice,
      18,
      sourceNativeUsd,
    );
    const destinationGasUsd = usdMicroCeil(
      BigInt(configuration.analyticsCosts.destinationGasUnitsUpperBound) * destinationGasPrice,
      18,
      destinationNativeUsd,
    );
    const principalDebtUsd = usdMicroCeil(
      BigInt(position.debtUnits),
      route.sourceDebtAsset.decimals,
      sourceDebtUsd,
    );
    const targetDebtUsd = usdMicroCeil(
      settlementPayoffUnits,
      route.destinationDebtAsset.decimals,
      destinationDebtUsd,
    );
    const policy = this.createPolicy(evaluatedAt);
    const conversionHash = hashCanonicalText(
      `debtshift.oneclick-bid-ask-bound.v1:${debtForwardQuote.quoteHash}:${debtReverseQuote.quoteHash}:${settlementPayoffUnits}`,
    );
    const financingCosts = [
      ['source-gas', 'NETWORK', sourceGasUsd],
      ['destination-gas', 'NETWORK', destinationGasUsd],
      ['transport', 'TRANSPORT', transportFeeUsd],
      ['slippage', 'SLIPPAGE', slippageUsd],
    ] as const;

    return markets.map((market) => {
      const marketSnapshot = marketSnapshotSchema.parse({
        ...market.snapshot,
        collateralAsset: route.destinationCollateralAsset,
        debtAsset: route.destinationDebtAsset,
      });
      const deliveredCollateralLoanUnits =
        (BigInt(collateralQuote.minAmountOutUnits) * BigInt(marketSnapshot.oracle.priceMantissa)) /
        MORPHO_ORACLE_SCALE;
      const oracleDeliveredUsd = usdMicroFloor(
        deliveredCollateralLoanUnits,
        route.destinationDebtAsset.decimals,
        destinationDebtUsd,
      );
      const deliveredCollateralValueUsd = minBigInt(oracleDeliveredUsd, minimumCollateralUsd);
      const stressedCollateralLoanUnits =
        (deliveredCollateralLoanUnits * BigInt(10_000 - policy.stressCollateralDropBps)) / 10_000n;
      const protocolCapacity =
        (deliveredCollateralLoanUnits * BigInt(marketSnapshot.lltvBps ?? 0)) / 10_000n;
      const normalPolicyCapacity =
        (deliveredCollateralLoanUnits * BigInt(configuration.policy.maximumLtvBps)) / 10_000n;
      const stressPolicyCapacity =
        (stressedCollateralLoanUnits * BigInt(configuration.policy.stressMaximumLtvBps)) / 10_000n;
      const policyCapacity = minBigInt(normalPolicyCapacity, stressPolicyCapacity);
      const liquidityCapacity =
        (BigInt(market.availableBorrowUnits) * 10_000n) /
        BigInt(10_000 + policy.minimumLiquidityBufferBps);
      const candidateId = `live-morpho:${market.marketId}`;
      const adapterVersionApproved =
        this.#mode === 'mainnet-readonly' ||
        market.marketId.toLowerCase() === route.targetMarket.marketId.toLowerCase();
      return routeCandidateSchema.parse({
        candidateId,
        market: marketSnapshot,
        requestedBorrowUnits: settlementPayoffUnits.toString(),
        principalDebtValueUsdMicro: principalDebtUsd.toString(),
        targetDebtValueUsdMicro: targetDebtUsd.toString(),
        deliveredCollateralValueUsdMicro: deliveredCollateralValueUsd.toString(),
        costs: {
          sourceGasUsdMicro: sourceGasUsd.toString(),
          destinationGasUsdMicro: destinationGasUsd.toString(),
          transportFeeUsdMicro: transportFeeUsd.toString(),
          slippageUsdMicro: slippageUsd.toString(),
          solverFeeUsdMicro: '0',
          protocolFeeUsdMicro: '0',
          collateralSwapCostUsdMicro: '0',
        },
        carryingCostAprBps: 0,
        tailLossEstimateUsdMicro: configuration.analyticsCosts.tailLossEstimateUsdMicro,
        settlementRiskCostUsdMicro: configuration.analyticsCosts.settlementRiskCostUsdMicro,
        dependencyRiskCostUsdMicro: configuration.analyticsCosts.dependencyRiskCostUsdMicro,
        estimatedSettlementSeconds: configuration.analyticsCosts.estimatedSettlementSeconds,
        settlementTimeP95Seconds: configuration.analyticsCosts.settlementTimeP95Seconds,
        rateProjection: {
          kind: 'DIRECT_PROJECTION',
          currentBorrowAprBps: market.currentBorrowAprBps,
          projectedBorrowAprBps: market.projectedBorrowAprBps,
          provenance: `morpho-direct:${market.blockNumber}`,
        },
        assetRouteSupported: true,
        adapterVersionApproved,
        transportMinimumMet: BigInt(collateralQuote.minAmountOutUnits) > 0n,
        financing: {
          evaluatedAt,
          settlementAsset: route.destinationDebtAsset,
          sourcePayoff: {
            asset: route.sourceDebtAsset,
            amountUnits: sourceDebtMaximumUnits.toString(),
            settlementAmountUnits: settlementPayoffUnits.toString(),
            conversion: {
              quoteHash: conversionHash,
              provider:
                debtForwardQuote.mode === 'SIMULATED'
                  ? 'DEBTSHIFT_SIMULATOR_BID_ASK_BOUND'
                  : 'NEAR_INTENTS_1CLICK_BID_ASK_BOUND',
              inputAsset: route.sourceDebtAsset,
              outputAsset: route.destinationDebtAsset,
              amountInUnits: sourceDebtMaximumUnits.toString(),
              amountOutUnits: settlementPayoffUnits.toString(),
              expiresAt: earliestExpiry(debtForwardQuote, debtReverseQuote),
            },
          },
          costs: financingCosts
            .filter(([, , usdMicro]) => usdMicro > 0n)
            .map(([name, kind, usdMicro]) => {
              const amount = usdMicroToTokenUnitsCeil(
                usdMicro,
                route.destinationDebtAsset.decimals,
                destinationDebtUsd,
              );
              return {
                componentId: `${candidateId}:${name}`,
                kind,
                financingClass: 'SEPARATELY_PAID' as const,
                asset: route.destinationDebtAsset,
                amountUnits: amount.toString(),
                settlementAmountUnits: amount.toString(),
              };
            }),
          solverFee: {
            asset: route.destinationDebtAsset,
            amountUnits: '0',
            signedCapUnits: '0',
          },
          externalFunding: [],
          capacities: {
            protocolUnits: protocolCapacity.toString(),
            policyUnits: policyCapacity.toString(),
            liquidityUnits: liquidityCapacity.toString(),
            signedUnits: settlementPayoffUnits.toString(),
          },
        },
      });
    });
  }

  async #discoverTargetMarkets(
    route: LiveProtocolService['route'],
  ): Promise<readonly TargetMarketDiscovery[]> {
    if (this.#mode === 'testnet') return [{ marketId: route.targetMarket.marketId }];
    const catalog = await this.transport.getTokenCatalog();
    verifyOneClickRouteAssets(catalog, [
      route.sourceCollateralAsset,
      route.sourceDebtAsset,
      route.destinationCollateralAsset,
      route.destinationDebtAsset,
    ]);
    const observation = await this.#marketDiscovery.discoverMarkets({
      chainId: route.targetMarket.chainId,
      loanToken: route.destinationDebtAsset.address,
      collateralToken: route.destinationCollateralAsset.address,
      listed: true,
    });
    const approved = observation.markets.filter((market) =>
      isAddressEqual(market.oracle, this.protocols.configuration.destination.morphoOracle),
    );
    if (approved.length === 0) {
      throw new Error(
        'Morpho discovery found no listed market with the approved asset and oracle boundary.',
      );
    }
    return approved.map((indexed) => ({ marketId: indexed.marketId, indexed }));
  }

  #assertMarketIdentity(
    params: {
      readonly loanToken: Address;
      readonly collateralToken: Address;
      readonly oracle: Address;
      readonly irm: Address;
      readonly lltv: bigint;
    },
    indexed?: DiscoveredMorphoMarket,
  ): void {
    const configuration = this.protocols.configuration.destination;
    if (!isAddressEqual(params.loanToken, configuration.debtAsset.address)) {
      throw new Error('Morpho loan token does not match the approved live registry.');
    }
    if (!isAddressEqual(params.collateralToken, configuration.collateralAsset.address)) {
      throw new Error('Morpho collateral token does not match the approved live registry.');
    }
    if (!isAddressEqual(params.oracle, configuration.morphoOracle)) {
      throw new Error('Morpho oracle does not match the approved live registry.');
    }
    if (
      indexed !== undefined &&
      (!isAddressEqual(params.loanToken, indexed.loanToken) ||
        !isAddressEqual(params.collateralToken, indexed.collateralToken) ||
        !isAddressEqual(params.oracle, indexed.oracle) ||
        !isAddressEqual(params.irm, indexed.irm) ||
        params.lltv !== BigInt(indexed.lltvWad))
    ) {
      throw new Error(
        'Morpho indexed market identity does not match canonical onchain parameters.',
      );
    }
  }
}

function assertSameToken(left: TokenReference, right: TokenReference, label: string): void {
  if (
    left.chainId !== right.chainId ||
    !isAddressEqual(getAddress(left.address), getAddress(right.address)) ||
    left.decimals !== right.decimals
  ) {
    throw new Error(`Observed ${label} token does not match the approved live registry.`);
  }
}

function usdMicroFloor(
  amountUnits: bigint,
  tokenDecimals: number,
  price: ChainlinkPriceObservation,
): bigint {
  return (
    (amountUnits * price.answer * 10n ** BigInt(USD_DECIMALS)) /
    (10n ** BigInt(tokenDecimals) * 10n ** BigInt(price.decimals))
  );
}

function usdMicroCeil(
  amountUnits: bigint,
  tokenDecimals: number,
  price: ChainlinkPriceObservation,
): bigint {
  return ceilDiv(
    amountUnits * price.answer * 10n ** BigInt(USD_DECIMALS),
    10n ** BigInt(tokenDecimals) * 10n ** BigInt(price.decimals),
  );
}

function usdMicroToTokenUnitsCeil(
  usdMicro: bigint,
  tokenDecimals: number,
  price: ChainlinkPriceObservation,
): bigint {
  return ceilDiv(
    usdMicro * 10n ** BigInt(tokenDecimals) * 10n ** BigInt(price.decimals),
    price.answer * 10n ** BigInt(USD_DECIMALS),
  );
}

function earliestExpiry(left: ProviderQuote, right: ProviderQuote): string {
  return Date.parse(left.expiresAt) <= Date.parse(right.expiresAt)
    ? left.expiresAt
    : right.expiresAt;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('A positive denominator is required.');
  return (numerator + denominator - 1n) / denominator;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function addBasisPointHeadroom(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(10_000 + basisPoints) + 9_999n) / 10_000n;
}

function zeroFloorSubtract(left: bigint, right: bigint): bigint {
  return left > right ? left - right : 0n;
}

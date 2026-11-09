import type { PositionSnapshot } from '@debtshift/domain';
import { hashCanonicalText, marketSnapshotSchema } from '@debtshift/domain';
import type { RouteRiskTools } from '@debtshift/agent';
import {
  routeCandidateSchema,
  routePolicySchema,
  type RouteCandidate,
  type RoutePolicy,
} from '@debtshift/optimizer';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';

import { LocalProtocolService, type LocalRouteDefinition } from './local-protocol.service.js';

export const LOCAL_EXECUTABLE_ROUTE_ID = 'local-morpho-balanced';
export const LOCAL_REJECTED_ROUTE_ID = 'local-morpho-low-liquidity';
export const LOCAL_EXECUTION_FEE_UNITS = '50000000';
export const LOCAL_MIN_APR_REDUCTION_BPS = 150;

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

const TARGET_MARKET_ABI = [
  {
    type: 'function',
    name: 'collateralPriceInDebtWad',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'price', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maximumLtvBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'maximumLtv', type: 'uint16' }],
  },
] as const;

export interface DestinationObservation {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly observedAt: string;
  readonly availableBorrowUnits: bigint;
  readonly collateralPriceInDebtWad: bigint;
  readonly maximumLtvBps: number;
}

@Injectable()
export class LocalMarketToolsService implements RouteRiskTools {
  readonly #destinationClient: PublicClient;
  readonly #sourceChainId: number;

  constructor(
    @Inject(LocalProtocolService) private readonly protocols: LocalProtocolService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#sourceChainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    this.#destinationClient = createPublicClient({
      transport: http(config.getOrThrow<string>('DESTINATION_RPC_URL')),
    });
  }

  async getSourcePositions(
    wallet: Address,
    chainIds: readonly number[],
  ): Promise<readonly PositionSnapshot[]> {
    if (!chainIds.includes(this.#sourceChainId)) return [];
    return [await this.protocols.getSourcePosition(wallet)];
  }

  async getRouteCandidates(
    position: PositionSnapshot,
    _evaluatedAt: string,
  ): Promise<readonly RouteCandidate[]> {
    const route = this.protocols.route;
    const block = await this.#destinationClient.getBlock({ blockTag: 'latest' });
    if (block.hash === null) throw new Error('The latest destination block is not canonical.');
    const [availableBorrowUnits, collateralPriceInDebtWad, maximumLtvBps] = await Promise.all([
      this.#destinationClient.readContract({
        address: route.destinationDebtAsset.address,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [route.targetMarket.deployment],
        blockNumber: block.number,
      }),
      this.#destinationClient.readContract({
        address: route.targetMarket.deployment,
        abi: TARGET_MARKET_ABI,
        functionName: 'collateralPriceInDebtWad',
        blockNumber: block.number,
      }),
      this.#destinationClient.readContract({
        address: route.targetMarket.deployment,
        abi: TARGET_MARKET_ABI,
        functionName: 'maximumLtvBps',
        blockNumber: block.number,
      }),
    ]);
    return buildLocalRouteCandidates(position, route, {
      blockNumber: block.number,
      blockHash: block.hash,
      observedAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
      availableBorrowUnits,
      collateralPriceInDebtWad,
      maximumLtvBps,
    });
  }
}

export function localRoutePolicy(evaluatedAt: string): RoutePolicy {
  return routePolicySchema.parse({
    evaluatedAt,
    horizonDays: 180,
    maxAllInCostUsdMicro: '100000000',
    minAprReductionBps: LOCAL_MIN_APR_REDUCTION_BPS,
    maxPositionSnapshotAgeSeconds: 30,
    maxMarketSnapshotAgeSeconds: 30,
    maxOracleAgeSeconds: 30,
    minimumLiquidityBufferBps: 1000,
    stressCollateralDropBps: 1000,
    stressTargetAprIncreaseBps: 200,
    requirePositiveNetBenefit: true,
    safetyPolicy: {
      kind: 'MAX_LTV_BPS',
      maximumLtvBps: 7000,
      stressMaximumLtvBps: 6500,
    },
  });
}

export function buildLocalRouteCandidates(
  position: PositionSnapshot,
  route: LocalRouteDefinition,
  observation: DestinationObservation,
): readonly RouteCandidate[] {
  const block = {
    number: observation.blockNumber.toString(),
    hash: observation.blockHash,
    observedAt: observation.observedAt,
  };
  const oracle = {
    oracle: 'LOCAL_TARGET_IMMUTABLE_PRICE',
    priceMantissa: observation.collateralPriceInDebtWad.toString(),
    priceDecimals: 18,
    updatedAt: observation.observedAt,
    block,
  };
  const principal = BigInt(position.debtUnits);
  const targetDebt = principal + BigInt(LOCAL_EXECUTION_FEE_UNITS);
  const deliveredCollateralValue =
    (BigInt(position.collateralUnits) * observation.collateralPriceInDebtWad * 99n) /
    (10n ** 30n * 100n);
  const baseMarket = marketSnapshotSchema.parse({
    snapshotId: hashCanonicalText(
      `debtshift.local-market.v1:${route.targetMarket.marketId}:${observation.blockHash}`,
    ),
    market: route.targetMarket,
    collateralAsset: route.destinationCollateralAsset,
    debtAsset: route.destinationDebtAsset,
    borrowAprBps: 400,
    availableBorrowUnits: observation.availableBorrowUnits.toString(),
    lltvBps: observation.maximumLtvBps,
    oracle,
    block,
  });

  const balanced = routeCandidateSchema.parse({
    candidateId: LOCAL_EXECUTABLE_ROUTE_ID,
    market: baseMarket,
    requestedBorrowUnits: targetDebt.toString(),
    principalDebtValueUsdMicro: principal.toString(),
    targetDebtValueUsdMicro: targetDebt.toString(),
    deliveredCollateralValueUsdMicro: deliveredCollateralValue.toString(),
    costs: {
      sourceGasUsdMicro: '10000000',
      destinationGasUsdMicro: '10000000',
      transportFeeUsdMicro: '10000000',
      slippageUsdMicro: '5000000',
      solverFeeUsdMicro: '35000000',
      protocolFeeUsdMicro: '15000000',
      collateralSwapCostUsdMicro: '0',
    },
    carryingCostAprBps: 0,
    tailLossEstimateUsdMicro: '5000000',
    settlementRiskCostUsdMicro: '3000000',
    dependencyRiskCostUsdMicro: '2000000',
    estimatedSettlementSeconds: 120,
    settlementTimeP95Seconds: 300,
    rateProjection: {
      kind: 'DIRECT_PROJECTION',
      currentBorrowAprBps: 400,
      projectedBorrowAprBps: 450,
      provenance: 'local-target-read-plus-bounded-impact-v1',
    },
    assetRouteSupported: true,
    adapterVersionApproved: true,
    transportMinimumMet: true,
  });

  const constrainedMarket = marketSnapshotSchema.parse({
    ...baseMarket,
    snapshotId: hashCanonicalText(
      `debtshift.local-market.low-liquidity.v1:${observation.blockHash}`,
    ),
    market: {
      ...route.targetMarket,
      marketId: hashCanonicalText('debtshift.local.destination-market.low-liquidity.v1'),
    },
    borrowAprBps: 350,
    availableBorrowUnits: principal.toString(),
  });
  const lowLiquidity = routeCandidateSchema.parse({
    candidateId: LOCAL_REJECTED_ROUTE_ID,
    market: constrainedMarket,
    requestedBorrowUnits: targetDebt.toString(),
    principalDebtValueUsdMicro: principal.toString(),
    targetDebtValueUsdMicro: targetDebt.toString(),
    deliveredCollateralValueUsdMicro: deliveredCollateralValue.toString(),
    costs: {
      sourceGasUsdMicro: '8000000',
      destinationGasUsdMicro: '8000000',
      transportFeeUsdMicro: '8000000',
      slippageUsdMicro: '4000000',
      solverFeeUsdMicro: '20000000',
      protocolFeeUsdMicro: '12000000',
      collateralSwapCostUsdMicro: '0',
    },
    carryingCostAprBps: 0,
    tailLossEstimateUsdMicro: '8000000',
    settlementRiskCostUsdMicro: '4000000',
    dependencyRiskCostUsdMicro: '3000000',
    estimatedSettlementSeconds: 180,
    settlementTimeP95Seconds: 480,
    rateProjection: {
      kind: 'DIRECT_PROJECTION',
      currentBorrowAprBps: 350,
      projectedBorrowAprBps: 425,
      provenance: 'local-constrained-market-impact-v1',
    },
    assetRouteSupported: true,
    adapterVersionApproved: true,
    transportMinimumMet: true,
  });
  return [balanced, lowLiquidity];
}

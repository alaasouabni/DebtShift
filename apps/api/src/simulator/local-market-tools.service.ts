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

import type { MarketIntelligencePort } from '../market-data/ports.js';
import { LocalProtocolService, type LocalRouteDefinition } from './local-protocol.service.js';

export const LOCAL_EXECUTABLE_ROUTE_ID = 'local-morpho-balanced';
export const LOCAL_REJECTED_ROUTE_ID = 'local-morpho-low-liquidity';
export const LOCAL_EXECUTION_FEE_UNITS = '50000000';
export const LOCAL_MIN_APR_REDUCTION_BPS = 150;
export const LOCAL_LIQUIDITY_BUFFER_BPS = 1_000;
export const LOCAL_STRESS_COLLATERAL_DROP_BPS = 1_000;

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
export class LocalMarketToolsService implements RouteRiskTools, MarketIntelligencePort {
  readonly provider = 'SIMULATOR' as const;
  readonly #destinationClient: PublicClient;
  readonly #sourceChainId: number;
  readonly #sourceDebtBufferBps: number;

  constructor(
    @Inject(LocalProtocolService) private readonly protocols: LocalProtocolService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#sourceChainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    this.#sourceDebtBufferBps = config.get<number>('SOURCE_DEBT_BUFFER_BPS') ?? 10;
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
    evaluatedAt: string,
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
    return buildLocalRouteCandidates(
      position,
      route,
      {
        blockNumber: block.number,
        blockHash: block.hash,
        observedAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
        availableBorrowUnits,
        collateralPriceInDebtWad,
        maximumLtvBps,
      },
      evaluatedAt,
      this.#sourceDebtBufferBps,
    );
  }

  createPolicy(evaluatedAt: string): RoutePolicy {
    return localRoutePolicy(evaluatedAt);
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
    minimumLiquidityBufferBps: LOCAL_LIQUIDITY_BUFFER_BPS,
    stressCollateralDropBps: LOCAL_STRESS_COLLATERAL_DROP_BPS,
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
  evaluatedAt = observation.observedAt,
  sourceDebtBufferBps = 10,
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
  const sourceDebtMaximum = addBasisPointHeadroom(principal, sourceDebtBufferBps);
  const targetDebt = sourceDebtMaximum + BigInt(LOCAL_EXECUTION_FEE_UNITS);
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
      solverFeeUsdMicro: LOCAL_EXECUTION_FEE_UNITS,
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
    financing: localFinancingStructure({
      candidateId: LOCAL_EXECUTABLE_ROUTE_ID,
      position,
      route,
      observation,
      evaluatedAt,
      deliveredCollateralValue,
      availableBorrowUnits: observation.availableBorrowUnits,
      requestedBorrowUnits: targetDebt,
      sourceDebtPayoffUnits: sourceDebtMaximum,
      solverFeeUnits: BigInt(LOCAL_EXECUTION_FEE_UNITS),
      separatelyPaidCosts: [
        ['source-gas', 'NETWORK', 10_000_000n],
        ['destination-gas', 'NETWORK', 10_000_000n],
        ['transport', 'TRANSPORT', 10_000_000n],
        ['slippage', 'SLIPPAGE', 5_000_000n],
        ['protocol', 'PROTOCOL', 15_000_000n],
      ],
    }),
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
  const lowLiquidityFee = 20_000_000n;
  const lowLiquidityTargetDebt = sourceDebtMaximum + lowLiquidityFee;
  const lowLiquidity = routeCandidateSchema.parse({
    candidateId: LOCAL_REJECTED_ROUTE_ID,
    market: constrainedMarket,
    requestedBorrowUnits: lowLiquidityTargetDebt.toString(),
    principalDebtValueUsdMicro: principal.toString(),
    targetDebtValueUsdMicro: lowLiquidityTargetDebt.toString(),
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
    financing: localFinancingStructure({
      candidateId: LOCAL_REJECTED_ROUTE_ID,
      position,
      route,
      observation,
      evaluatedAt,
      deliveredCollateralValue,
      availableBorrowUnits: principal,
      requestedBorrowUnits: lowLiquidityTargetDebt,
      sourceDebtPayoffUnits: sourceDebtMaximum,
      solverFeeUnits: lowLiquidityFee,
      separatelyPaidCosts: [
        ['source-gas', 'NETWORK', 8_000_000n],
        ['destination-gas', 'NETWORK', 8_000_000n],
        ['transport', 'TRANSPORT', 8_000_000n],
        ['slippage', 'SLIPPAGE', 4_000_000n],
        ['protocol', 'PROTOCOL', 12_000_000n],
      ],
    }),
  });
  return [balanced, lowLiquidity];
}

type LocalCostKind = 'TRANSPORT' | 'PROTOCOL' | 'NETWORK' | 'SLIPPAGE';

interface LocalFinancingInput {
  readonly candidateId: string;
  readonly position: PositionSnapshot;
  readonly route: LocalRouteDefinition;
  readonly observation: DestinationObservation;
  readonly evaluatedAt: string;
  readonly deliveredCollateralValue: bigint;
  readonly availableBorrowUnits: bigint;
  readonly requestedBorrowUnits: bigint;
  readonly sourceDebtPayoffUnits: bigint;
  readonly solverFeeUnits: bigint;
  readonly separatelyPaidCosts: readonly (readonly [string, LocalCostKind, bigint])[];
}

function localFinancingStructure(input: LocalFinancingInput) {
  const stressedCollateralValue =
    (input.deliveredCollateralValue * BigInt(10_000 - LOCAL_STRESS_COLLATERAL_DROP_BPS)) / 10_000n;
  const protocolCapacity =
    (input.deliveredCollateralValue * BigInt(input.observation.maximumLtvBps)) / 10_000n;
  const normalPolicyCapacity = (input.deliveredCollateralValue * 7_000n) / 10_000n;
  const stressPolicyCapacity = (stressedCollateralValue * 6_500n) / 10_000n;
  const policyCapacity = minBigInt(normalPolicyCapacity, stressPolicyCapacity);
  const liquidityCapacity =
    (input.availableBorrowUnits * 10_000n) / BigInt(10_000 + LOCAL_LIQUIDITY_BUFFER_BPS);
  const conversionExpiry = new Date(Date.parse(input.evaluatedAt) + 10 * 60 * 1_000).toISOString();
  const sourceDebtUnits = input.sourceDebtPayoffUnits.toString();
  const conversionHash = hashCanonicalText(
    `debtshift.local-parity-conversion.v1:${input.candidateId}:${sourceDebtUnits}:${input.evaluatedAt}`,
  );
  return {
    evaluatedAt: input.evaluatedAt,
    settlementAsset: input.route.destinationDebtAsset,
    sourcePayoff: {
      asset: input.route.sourceDebtAsset,
      amountUnits: sourceDebtUnits,
      settlementAmountUnits: sourceDebtUnits,
      conversion: {
        quoteHash: conversionHash,
        provider: 'DEBTSHIFT_SIMULATOR_PARITY_QUOTE',
        inputAsset: input.route.sourceDebtAsset,
        outputAsset: input.route.destinationDebtAsset,
        amountInUnits: sourceDebtUnits,
        amountOutUnits: sourceDebtUnits,
        expiresAt: conversionExpiry,
      },
    },
    costs: input.separatelyPaidCosts.map(([id, kind, amount]) => ({
      componentId: `${input.candidateId}:${id}`,
      kind,
      financingClass: 'SEPARATELY_PAID' as const,
      asset: input.route.destinationDebtAsset,
      amountUnits: amount.toString(),
      settlementAmountUnits: amount.toString(),
    })),
    solverFee: {
      asset: input.route.destinationDebtAsset,
      amountUnits: input.solverFeeUnits.toString(),
      signedCapUnits: input.solverFeeUnits.toString(),
    },
    externalFunding: [],
    capacities: {
      protocolUnits: protocolCapacity.toString(),
      policyUnits: policyCapacity.toString(),
      liquidityUnits: liquidityCapacity.toString(),
      signedUnits: input.requestedBorrowUnits.toString(),
    },
  };
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function addBasisPointHeadroom(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(10_000 + basisPoints) + 9_999n) / 10_000n;
}

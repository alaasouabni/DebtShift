import type { RateProjection } from './models.js';

export interface ProjectedBorrowRate {
  readonly currentBorrowAprBps: number;
  readonly projectedBorrowAprBps: number;
  readonly rateImpactBps: number;
  readonly utilizationBeforeBps?: number;
  readonly utilizationAfterBps?: number;
  readonly provenance: string;
}

export function projectBorrowRate(
  projection: RateProjection,
  requestedBorrowUnits: bigint,
): ProjectedBorrowRate {
  if (projection.kind === 'DIRECT_PROJECTION') {
    return {
      currentBorrowAprBps: projection.currentBorrowAprBps,
      projectedBorrowAprBps: projection.projectedBorrowAprBps,
      rateImpactBps: projection.projectedBorrowAprBps - projection.currentBorrowAprBps,
      provenance: projection.provenance,
    };
  }

  const available = BigInt(projection.availableLiquidityUnits);
  const borrowed = BigInt(projection.totalBorrowUnits);
  if (requestedBorrowUnits > available) {
    throw new Error('Requested borrow exceeds the rate model available liquidity.');
  }
  const totalLiquidity = available + borrowed;
  if (totalLiquidity === 0n) {
    return {
      currentBorrowAprBps: projection.baseRateBps,
      projectedBorrowAprBps: projection.baseRateBps,
      rateImpactBps: 0,
      utilizationBeforeBps: 0,
      utilizationAfterBps: 0,
      provenance: projection.provenance,
    };
  }
  const utilizationBeforeBps = ratioFloor(borrowed, totalLiquidity, 10_000n);
  const utilizationAfterBps = ratioFloor(borrowed + requestedBorrowUnits, totalLiquidity, 10_000n);
  const currentBorrowAprBps = rateAtUtilization(projection, utilizationBeforeBps);
  const projectedBorrowAprBps = rateAtUtilization(projection, utilizationAfterBps);
  return {
    currentBorrowAprBps,
    projectedBorrowAprBps,
    rateImpactBps: projectedBorrowAprBps - currentBorrowAprBps,
    utilizationBeforeBps,
    utilizationAfterBps,
    provenance: projection.provenance,
  };
}

function rateAtUtilization(
  projection: Extract<RateProjection, { kind: 'LINEAR_KINK' }>,
  utilizationBps: number,
): number {
  if (utilizationBps <= projection.optimalUtilizationBps) {
    return (
      projection.baseRateBps +
      Math.floor((projection.slope1Bps * utilizationBps) / projection.optimalUtilizationBps)
    );
  }
  return (
    projection.baseRateBps +
    projection.slope1Bps +
    Math.floor(
      (projection.slope2Bps * (utilizationBps - projection.optimalUtilizationBps)) /
        (10_000 - projection.optimalUtilizationBps),
    )
  );
}

function ratioFloor(numerator: bigint, denominator: bigint, scale: bigint): number {
  return Number((numerator * scale) / denominator);
}

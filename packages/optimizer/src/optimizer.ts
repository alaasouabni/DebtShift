import {
  compareRoutesInputSchema,
  routeComparisonSchema,
  type RouteCandidate,
  type RouteComparison,
  type RouteEvaluation,
  type RoutePolicy,
  type RouteRejection,
  type RouteSafety,
} from './models.js';
import { evaluateRefinancingFeasibility } from './feasibility.js';
import { projectBorrowRate } from './rate.js';

const BPS = 10_000n;
const DAYS_PER_YEAR = 365n;
const SECONDS_PER_DAY = 86_400n;
const WAD = 10n ** 18n;

export function compareRoutes(input: unknown): RouteComparison {
  const parsed = compareRoutesInputSchema.parse(input);
  const evaluations = parsed.candidates.map((candidate) =>
    evaluateRoute(candidate, parsed.sourcePosition, parsed.policy),
  );
  const eligible = evaluations
    .filter((evaluation) => evaluation.eligible)
    .sort(compareEligibleRoutes)
    .map((evaluation, index) => ({ ...evaluation, rank: index + 1 }));
  const ranks = new Map(eligible.map((evaluation) => [evaluation.candidateId, evaluation]));
  const ordered = evaluations
    .map((evaluation) => ranks.get(evaluation.candidateId) ?? evaluation)
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (left.eligible && right.eligible) return (left.rank ?? 0) - (right.rank ?? 0);
      return left.candidateId.localeCompare(right.candidateId);
    });
  const selectedCandidateId = eligible[0]?.candidateId;
  return routeComparisonSchema.parse({
    policyVersion: 1,
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    evaluations: ordered,
  });
}

function evaluateRoute(
  candidate: RouteCandidate,
  sourcePosition: ReturnType<typeof compareRoutesInputSchema.parse>['sourcePosition'],
  policy: RoutePolicy,
): RouteEvaluation {
  const rejections: RouteRejection[] = [];
  const requestedBorrow = BigInt(candidate.requestedBorrowUnits);
  const financing = evaluateRefinancingFeasibility(candidate.financing);
  for (const rejection of financing.rejections) {
    reject(rejections, rejection.code, rejection.message);
  }
  if (requestedBorrow !== BigInt(financing.requiredDestinationBorrowUnits)) {
    reject(
      rejections,
      'REQUESTED_BORROW_MISMATCH',
      'Requested destination borrowing does not match the reconciled financing requirement.',
    );
  }
  const availableBorrow = BigInt(candidate.market.availableBorrowUnits);
  const requiredLiquidity = ceilDiv(
    requestedBorrow * (BPS + BigInt(policy.minimumLiquidityBufferBps)),
    BPS,
  );
  if (availableBorrow < requiredLiquidity) {
    reject(
      rejections,
      'INSUFFICIENT_BORROW_LIQUIDITY',
      'Target liquidity does not cover the requested debt and policy buffer.',
    );
  }
  if (!candidate.assetRouteSupported) {
    reject(rejections, 'ROUTE_UNSUPPORTED', 'The exact collateral route is not supported.');
  }
  if (!candidate.adapterVersionApproved) {
    reject(rejections, 'ADAPTER_VERSION_UNAPPROVED', 'The target adapter version is not approved.');
  }
  if (!candidate.transportMinimumMet) {
    reject(
      rejections,
      'TRANSPORT_MINIMUM_NOT_MET',
      'The transport minimum cannot satisfy the target collateral authorization.',
    );
  }

  const evaluatedAtMs = Date.parse(policy.evaluatedAt);
  if (
    ageSeconds(evaluatedAtMs, sourcePosition.block.observedAt) >
    policy.maxPositionSnapshotAgeSeconds
  ) {
    reject(rejections, 'SOURCE_POSITION_STALE', 'The source position snapshot is stale.');
  }
  if (
    ageSeconds(evaluatedAtMs, candidate.market.block.observedAt) >
    policy.maxMarketSnapshotAgeSeconds
  ) {
    reject(rejections, 'MARKET_SNAPSHOT_STALE', 'The target market snapshot is stale.');
  }
  if (ageSeconds(evaluatedAtMs, candidate.market.oracle.updatedAt) > policy.maxOracleAgeSeconds) {
    reject(rejections, 'ORACLE_STALE', 'The target oracle snapshot is stale.');
  }

  let rate;
  try {
    rate = projectBorrowRate(candidate.rateProjection, requestedBorrow);
  } catch (error) {
    reject(
      rejections,
      'INSUFFICIENT_BORROW_LIQUIDITY',
      error instanceof Error ? error.message : 'Target rate projection lacks borrow liquidity.',
    );
    const boundedBorrow =
      candidate.rateProjection.kind === 'LINEAR_KINK'
        ? BigInt(candidate.rateProjection.availableLiquidityUnits)
        : requestedBorrow;
    rate = projectBorrowRate(candidate.rateProjection, boundedBorrow);
  }
  const aprReductionBps = sourcePosition.borrowAprBps - rate.projectedBorrowAprBps;
  if (aprReductionBps < policy.minAprReductionBps) {
    reject(
      rejections,
      'APR_REDUCTION_BELOW_MINIMUM',
      'Projected APR reduction is below the borrower policy minimum.',
    );
  }

  const allInCost = sumCosts(candidate);
  if (allInCost > BigInt(policy.maxAllInCostUsdMicro)) {
    reject(rejections, 'COST_ABOVE_MAXIMUM', 'All-in route cost exceeds the policy cap.');
  }
  const principalValue = BigInt(candidate.principalDebtValueUsdMicro);
  const targetDebtValue = BigInt(candidate.targetDebtValueUsdMicro);
  const collateralValue = BigInt(candidate.deliveredCollateralValueUsdMicro);
  const horizon = BigInt(policy.horizonDays);
  const grossSavings = projectedInterestDelta(principalValue, aprReductionBps, horizon);
  const stressApr = rate.projectedBorrowAprBps + policy.stressTargetAprIncreaseBps;
  const stressGrossSavings = projectedInterestDelta(
    principalValue,
    sourcePosition.borrowAprBps - stressApr,
    horizon,
  );
  const carryingCost = projectedInterestDelta(
    principalValue,
    candidate.carryingCostAprBps,
    horizon,
  );
  const netBenefit = grossSavings - allInCost - carryingCost;
  const stressNetBenefit = stressGrossSavings - allInCost - carryingCost;
  if (policy.requirePositiveNetBenefit && netBenefit <= 0n) {
    reject(
      rejections,
      'NEGATIVE_NET_BENEFIT',
      'Projected net benefit is not positive at the selected horizon.',
    );
  }

  const safety = evaluateSafety(candidate, policy, targetDebtValue, collateralValue, rejections);
  const riskPenalty =
    BigInt(candidate.tailLossEstimateUsdMicro) +
    BigInt(candidate.settlementRiskCostUsdMicro) +
    BigInt(candidate.dependencyRiskCostUsdMicro);
  const score = netBenefit - riskPenalty;
  const annualGrossSavings = projectedInterestDelta(principalValue, aprReductionBps, DAYS_PER_YEAR);
  const breakEvenSeconds =
    aprReductionBps > 0
      ? ceilDiv(
          allInCost * DAYS_PER_YEAR * SECONDS_PER_DAY * BPS,
          principalValue * BigInt(aprReductionBps),
        ).toString()
      : undefined;

  return {
    candidateId: candidate.candidateId,
    eligible: rejections.length === 0,
    scoreUsdMicro: score.toString(),
    economics: {
      sourceAprBps: sourcePosition.borrowAprBps,
      targetAprBeforeBps: rate.currentBorrowAprBps,
      targetAprAfterBps: rate.projectedBorrowAprBps,
      targetRateImpactBps: rate.rateImpactBps,
      aprReductionBps,
      stressTargetAprBps: stressApr,
      allInCostUsdMicro: allInCost.toString(),
      carryingCostUsdMicro: carryingCost.toString(),
      grossSavingsUsdMicro: grossSavings.toString(),
      stressGrossSavingsUsdMicro: stressGrossSavings.toString(),
      netBenefitUsdMicro: netBenefit.toString(),
      stressNetBenefitUsdMicro: stressNetBenefit.toString(),
      annualGrossSavingsUsdMicro: annualGrossSavings.toString(),
      ...(breakEvenSeconds === undefined ? {} : { breakEvenSeconds }),
    },
    safety,
    financing,
    rejections,
    provenance: {
      sourceSnapshotId: sourcePosition.snapshotId,
      marketSnapshotId: candidate.market.snapshotId,
      marketBlockNumber: candidate.market.block.number,
      marketBlockHash: candidate.market.block.hash,
      oracleUpdatedAt: candidate.market.oracle.updatedAt,
      evaluatedAt: policy.evaluatedAt,
      rateProjection: rate.provenance,
    },
  };
}

function evaluateSafety(
  candidate: RouteCandidate,
  policy: RoutePolicy,
  debtValue: bigint,
  collateralValue: bigint,
  rejections: RouteRejection[],
): RouteSafety {
  const stressedCollateral =
    (collateralValue * BigInt(10_000 - policy.stressCollateralDropBps)) / BPS;
  if (policy.safetyPolicy.kind === 'MAX_LTV_BPS') {
    const postLtvBps = Number(ceilDiv(debtValue * BPS, collateralValue));
    const stressLtvBps = Number(ceilDiv(debtValue * BPS, stressedCollateral));
    if (postLtvBps > policy.safetyPolicy.maximumLtvBps) {
      reject(rejections, 'UNSAFE_POST_STATE', 'Target post-migration LTV exceeds policy.');
    }
    if (stressLtvBps > policy.safetyPolicy.stressMaximumLtvBps) {
      reject(rejections, 'UNSAFE_STRESS_STATE', 'Stressed target LTV exceeds policy.');
    }
    return {
      kind: 'MAX_LTV_BPS',
      postLtvBps,
      stressLtvBps,
      maximumLtvBps: policy.safetyPolicy.maximumLtvBps,
      stressMaximumLtvBps: policy.safetyPolicy.stressMaximumLtvBps,
    };
  }

  const riskLimitBps = candidate.market.lltvBps ?? candidate.market.collateralFactorBps;
  if (riskLimitBps === undefined) {
    reject(
      rejections,
      'MARKET_RISK_LIMIT_MISSING',
      'Target market has no verified collateral risk limit.',
    );
    return {
      kind: 'MIN_HEALTH_FACTOR_WAD',
      postHealthFactorWad: '0',
      stressHealthFactorWad: '0',
      minimumWad: policy.safetyPolicy.minimumWad,
      stressMinimumWad: policy.safetyPolicy.stressMinimumWad,
    };
  }
  const postHealth = (collateralValue * BigInt(riskLimitBps) * WAD) / (debtValue * BPS);
  const stressHealth = (stressedCollateral * BigInt(riskLimitBps) * WAD) / (debtValue * BPS);
  if (postHealth < BigInt(policy.safetyPolicy.minimumWad)) {
    reject(rejections, 'UNSAFE_POST_STATE', 'Target post-migration health factor is below policy.');
  }
  if (stressHealth < BigInt(policy.safetyPolicy.stressMinimumWad)) {
    reject(rejections, 'UNSAFE_STRESS_STATE', 'Stressed target health factor is below policy.');
  }
  return {
    kind: 'MIN_HEALTH_FACTOR_WAD',
    postHealthFactorWad: postHealth.toString(),
    stressHealthFactorWad: stressHealth.toString(),
    minimumWad: policy.safetyPolicy.minimumWad,
    stressMinimumWad: policy.safetyPolicy.stressMinimumWad,
    riskLimitBps,
  };
}

function sumCosts(candidate: RouteCandidate): bigint {
  return Object.values(candidate.costs).reduce((total, value) => total + BigInt(value), 0n);
}

function projectedInterestDelta(
  principalUsdMicro: bigint,
  aprDeltaBps: number,
  horizonDays: bigint,
): bigint {
  return (principalUsdMicro * BigInt(aprDeltaBps) * horizonDays) / (BPS * DAYS_PER_YEAR);
}

function ageSeconds(evaluatedAtMs: number, observedAt: string): number {
  return Math.max(0, Math.floor((evaluatedAtMs - Date.parse(observedAt)) / 1000));
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('A positive denominator is required.');
  return (numerator + denominator - 1n) / denominator;
}

function reject(rejections: RouteRejection[], code: RouteRejection['code'], message: string): void {
  rejections.push({ code, message });
}

function compareEligibleRoutes(left: RouteEvaluation, right: RouteEvaluation): number {
  const scoreDifference = BigInt(right.scoreUsdMicro) - BigInt(left.scoreUsdMicro);
  if (scoreDifference !== 0n) return scoreDifference > 0n ? 1 : -1;
  if (left.economics.stressNetBenefitUsdMicro !== right.economics.stressNetBenefitUsdMicro) {
    return BigInt(right.economics.stressNetBenefitUsdMicro) >
      BigInt(left.economics.stressNetBenefitUsdMicro)
      ? 1
      : -1;
  }
  if (left.economics.targetAprAfterBps !== right.economics.targetAprAfterBps) {
    return left.economics.targetAprAfterBps - right.economics.targetAprAfterBps;
  }
  return left.candidateId.localeCompare(right.candidateId);
}

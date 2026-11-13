import type {
  ExecutionPlan,
  PersistedSourceLendingAuthorization,
  PersistedTargetLendingAuthorization,
  PositionSnapshot,
  PreparedSourceLendingAuthorization,
  PreparedTargetLendingAuthorization,
  SignedTargetLendingAuthorization,
  SubmittedSourceLendingAuthorization,
} from '@debtshift/domain';
import type { RouteCandidate, RoutePolicy } from '@debtshift/optimizer';
import type { Address } from 'viem';

import type {
  DebtShiftRouteDefinition,
  MarketIntelligencePort,
  ProtocolDataPort,
} from './ports.js';

const DISABLED_MESSAGE = 'Lending market access is disabled by the selected runtime policy.';

export class DisabledProtocolDataPort implements ProtocolDataPort {
  readonly provider = 'DISABLED' as const;

  get route(): DebtShiftRouteDefinition {
    throw new Error(DISABLED_MESSAGE);
  }

  getSourcePosition(_borrower: string): Promise<PositionSnapshot> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }

  verifySourceSnapshot(_snapshot: PositionSnapshot): Promise<void> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }

  prepareSourceAuthorization(_plan: ExecutionPlan): Promise<PreparedSourceLendingAuthorization> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }

  verifySourceAuthorization(
    _input: SubmittedSourceLendingAuthorization,
    _plan: ExecutionPlan,
  ): Promise<PersistedSourceLendingAuthorization> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }

  prepareTargetAuthorization(
    _borrower: Address,
    _deadline: bigint,
  ): Promise<PreparedTargetLendingAuthorization> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }

  verifyTargetAuthorization(
    _input: SignedTargetLendingAuthorization,
    _borrower: Address,
    _planDeadline: bigint,
  ): Promise<PersistedTargetLendingAuthorization> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }
}

export class DisabledMarketIntelligencePort implements MarketIntelligencePort {
  readonly provider = 'DISABLED' as const;

  createPolicy(_evaluatedAt: string): RoutePolicy {
    throw new Error(DISABLED_MESSAGE);
  }

  getSourcePositions(
    _wallet: Address,
    _chainIds: readonly number[],
  ): Promise<readonly PositionSnapshot[]> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }

  getRouteCandidates(
    _position: PositionSnapshot,
    _evaluatedAt: string,
  ): Promise<readonly RouteCandidate[]> {
    return Promise.reject(new Error(DISABLED_MESSAGE));
  }
}

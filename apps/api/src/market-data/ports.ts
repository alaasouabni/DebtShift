import type { RouteRiskTools } from '@debtshift/agent';
import type { MarketReference, PositionSnapshot, TokenReference } from '@debtshift/domain';
import type { RoutePolicy } from '@debtshift/optimizer';
import type { Address } from 'viem';

export const PROTOCOL_DATA_PORT = Symbol('PROTOCOL_DATA_PORT');
export const MARKET_INTELLIGENCE_PORT = Symbol('MARKET_INTELLIGENCE_PORT');

export interface SimulatorExecutionBindings {
  readonly kind: 'SIMULATOR';
  readonly destinationEscrow: Address;
  readonly sourceVault: Address;
  readonly executor: Address;
}

export interface ReadOnlyExecutionBindings {
  readonly kind: 'READ_ONLY';
}

export interface DebtShiftRouteDefinition {
  readonly sourceMarket: MarketReference;
  readonly targetMarket: MarketReference;
  readonly sourceDebtAsset: TokenReference;
  readonly sourceCollateralAsset: TokenReference;
  readonly destinationDebtAsset: TokenReference;
  readonly destinationCollateralAsset: TokenReference;
  readonly execution: SimulatorExecutionBindings | ReadOnlyExecutionBindings;
}

/**
 * Execution-authority protocol reads. Implementations are selected once at
 * startup; application services never import simulator or live adapters.
 */
export interface ProtocolDataPort {
  readonly provider: 'SIMULATOR' | 'LIVE_READ_ONLY' | 'DISABLED';
  readonly route: DebtShiftRouteDefinition;
  getSourcePosition(borrower: string): Promise<PositionSnapshot>;
  verifySourceSnapshot(snapshot: PositionSnapshot): Promise<void>;
}

/** Read-only market tools plus the policy that governs their observations. */
export interface MarketIntelligencePort extends RouteRiskTools {
  readonly provider: 'SIMULATOR' | 'LIVE_READ_ONLY' | 'DISABLED';
  createPolicy(evaluatedAt: string): RoutePolicy;
}

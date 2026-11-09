import type { PositionSnapshot } from '@debtshift/domain';
import {
  compareRoutes,
  routePolicySchema,
  type RouteCandidate,
  type RouteComparison,
  type RoutePolicy,
} from '@debtshift/optimizer';
import { getAddress, type Address } from 'viem';
import { z } from 'zod';

export const ROUTE_RISK_AGENT_CAPABILITIES = Object.freeze([
  'GET_SOURCE_POSITIONS',
  'GET_ROUTE_CANDIDATES',
  'COMPARE_ROUTES',
] as const);

export interface RouteRiskTools {
  getSourcePositions(
    wallet: Address,
    chainIds: readonly number[],
  ): Promise<readonly PositionSnapshot[]>;
  getRouteCandidates(
    position: PositionSnapshot,
    evaluatedAt: string,
  ): Promise<readonly RouteCandidate[]>;
}

export interface AnalyzeWalletRequest {
  readonly wallet: string;
  readonly sourceChainIds: readonly number[];
  readonly policy: RoutePolicy;
}

export interface PositionRouteAnalysis {
  readonly sourcePosition: PositionSnapshot;
  readonly comparison: RouteComparison;
}

export interface WalletRouteAnalysis {
  readonly agent: 'DEBTSHIFT_ROUTE_RISK_AGENT';
  readonly deterministic: true;
  readonly policyVersion: 1;
  readonly wallet: Address;
  readonly analyses: readonly PositionRouteAnalysis[];
}

const chainIdsSchema = z.array(z.number().int().positive()).min(1).max(32);

/** Read-only financial agent. Its tool type has no signing, broadcast, reservation, or write method. */
export class DeterministicRouteRiskAgent {
  constructor(private readonly tools: RouteRiskTools) {}

  async analyzeWallet(request: AnalyzeWalletRequest): Promise<WalletRouteAnalysis> {
    const wallet = getAddress(request.wallet);
    const sourceChainIds = chainIdsSchema.parse(request.sourceChainIds);
    const policy = routePolicySchema.parse(request.policy);
    const positions = await this.tools.getSourcePositions(wallet, sourceChainIds);
    const analyses = await Promise.all(
      positions.map(async (sourcePosition) => {
        const candidates = await this.tools.getRouteCandidates(sourcePosition, policy.evaluatedAt);
        return {
          sourcePosition,
          comparison: compareRoutes({ sourcePosition, candidates, policy }),
        };
      }),
    );
    return {
      agent: 'DEBTSHIFT_ROUTE_RISK_AGENT',
      deterministic: true,
      policyVersion: 1,
      wallet,
      analyses,
    };
  }
}

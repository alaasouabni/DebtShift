import { DeterministicRouteRiskAgent, RouteExplanationService } from '@debtshift/agent';
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAddressEqual, type Address } from 'viem';

import { routeAnalysisRequestSchema } from './http-contracts.js';
import { MARKET_INTELLIGENCE_PORT, type MarketIntelligencePort } from './market-data/ports.js';

@Injectable()
export class RouteAnalysisService {
  readonly #agent: DeterministicRouteRiskAgent;
  readonly #explanations: RouteExplanationService;
  readonly #sourceChainId: number;

  constructor(
    @Inject(MARKET_INTELLIGENCE_PORT)
    private readonly tools: MarketIntelligencePort,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#agent = new DeterministicRouteRiskAgent(tools);
    this.#sourceChainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    this.#explanations = new RouteExplanationService({
      allowCustomEndpoints: config.getOrThrow<boolean>('ALLOW_CUSTOM_AI_ENDPOINTS'),
    });
  }

  async analyze(input: unknown, authenticatedWallet?: Address) {
    try {
      const request = routeAnalysisRequestSchema.parse(input);
      if (
        authenticatedWallet !== undefined &&
        !isAddressEqual(request.wallet, authenticatedWallet)
      ) {
        throw new ForbiddenException('Wallet session does not match the requested borrower.');
      }
      const evaluatedAt = new Date().toISOString();
      const analysis = await this.#agent.analyzeWallet({
        wallet: request.wallet,
        sourceChainIds: [this.#sourceChainId],
        policy: this.tools.createPolicy(evaluatedAt),
      });
      if (analysis.analyses.length === 0) {
        throw new Error('No supported source position was found for this wallet.');
      }
      const explanations = await Promise.all(
        analysis.analyses.map(async ({ sourcePosition, comparison }) => ({
          sourceSnapshotId: sourcePosition.snapshotId,
          result: await this.#explanations.explain(
            comparison,
            request.explanation ?? { mode: 'DETERMINISTIC' },
          ),
        })),
      );
      return { analysis, explanations };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Unable to analyze refinance routes.',
      );
    }
  }
}

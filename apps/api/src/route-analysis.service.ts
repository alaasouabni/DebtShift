import {
  DeterministicRouteRiskAgent,
  explanationConfigurationSchema,
  RouteExplanationService,
} from '@debtshift/agent';
import { evmAddressSchema } from '@debtshift/domain';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import { LocalMarketToolsService, localRoutePolicy } from './local-market-tools.service.js';

const routeAnalysisRequestSchema = z
  .object({
    wallet: evmAddressSchema,
    explanation: explanationConfigurationSchema.optional(),
  })
  .strict();

@Injectable()
export class RouteAnalysisService {
  readonly #agent: DeterministicRouteRiskAgent;
  readonly #explanations: RouteExplanationService;
  readonly #sourceChainId: number;

  constructor(
    @Inject(LocalMarketToolsService) tools: LocalMarketToolsService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#agent = new DeterministicRouteRiskAgent(tools);
    this.#sourceChainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    this.#explanations = new RouteExplanationService({
      allowCustomEndpoints: config.getOrThrow<boolean>('ALLOW_CUSTOM_AI_ENDPOINTS'),
    });
  }

  async analyze(input: unknown) {
    try {
      const request = routeAnalysisRequestSchema.parse(input);
      const evaluatedAt = new Date().toISOString();
      const analysis = await this.#agent.analyzeWallet({
        wallet: request.wallet,
        sourceChainIds: [this.#sourceChainId],
        policy: localRoutePolicy(evaluatedAt),
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
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Unable to analyze refinance routes.',
      );
    }
  }
}

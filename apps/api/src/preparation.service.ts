import { randomBytes } from 'node:crypto';

import { storeProviderQuote } from '@debtshift/database';
import {
  computeMigrationId,
  computeRouteHash,
  executionPlanSchema,
  hashCanonicalText,
  hashExecutionPlan,
  hashRefinanceIntent,
  hashSourcePosition,
  refinanceIntentSchema,
  evmAddressSchema,
} from '@debtshift/domain';
import { transportQuoteRequestSchema } from '@debtshift/intents';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Address } from 'viem';
import { z } from 'zod';

import { DatabaseService } from './database.service.js';
import { LocalProtocolService } from './local-protocol.service.js';
import {
  LOCAL_EXECUTABLE_ROUTE_ID,
  LOCAL_EXECUTION_FEE_UNITS,
  LOCAL_MIN_APR_REDUCTION_BPS,
} from './local-market-tools.service.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { TransportService } from './transport.service.js';

const preparationRequestSchema = z.object({ borrower: evmAddressSchema }).strict();

@Injectable()
export class PreparationService {
  readonly #verifyingContract: Address;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LocalProtocolService) private readonly protocols: LocalProtocolService,
    @Inject(RouteAnalysisService) private readonly routeAnalysis: RouteAnalysisService,
    @Inject(TransportService) private readonly transport: TransportService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#verifyingContract = config.getOrThrow<Address>('EIP712_VERIFYING_CONTRACT');
  }

  async getPosition(wallet: string) {
    try {
      return await this.protocols.getSourcePosition(wallet);
    } catch (error) {
      throw badRequest(error);
    }
  }

  async prepare(input: unknown) {
    try {
      const { borrower } = preparationRequestSchema.parse(input);
      const routeAnalysis = await this.routeAnalysis.analyze({ wallet: borrower });
      const positionAnalysis = routeAnalysis.analysis.analyses[0];
      if (positionAnalysis === undefined) throw new Error('No route analysis was produced.');
      const snapshot = positionAnalysis.sourcePosition;
      const selected = positionAnalysis.comparison.evaluations.find(
        (evaluation) => evaluation.candidateId === positionAnalysis.comparison.selectedCandidateId,
      );
      if (
        selected === undefined ||
        !selected.eligible ||
        selected.candidateId !== LOCAL_EXECUTABLE_ROUTE_ID
      ) {
        throw new Error('No approved executable route satisfies the deterministic policy.');
      }
      const route = this.protocols.route;
      const quote = await this.transport.getQuote(
        transportQuoteRequestSchema.parse({
          inputAsset: route.sourceCollateralAsset,
          outputAsset: route.destinationCollateralAsset,
          amountInUnits: snapshot.collateralUnits,
          maxSlippageBps: 50,
          destinationReceiver: route.destinationEscrow,
          refundReceiver: borrower,
        }),
      );
      await storeProviderQuote(this.database.db, quote);

      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      const intentNonce = randomNonce();
      const intent = refinanceIntentSchema.parse({
        borrower,
        accountType: 'EOA',
        sourcePosition: snapshot.position,
        allowedTargets: [route.targetMarket],
        feeAsset: route.sourceDebtAsset,
        maxSourceDebtUnits: snapshot.debtUnits,
        minSourceCollateralUnits: snapshot.collateralUnits,
        maxTotalFeeUnits: selected.economics.allInCostUsdMicro,
        maxSlippageBps: 50,
        minAprReductionBps: LOCAL_MIN_APR_REDUCTION_BPS,
        safetyPolicy: {
          kind: 'MAX_LTV_BPS',
          maximumLtvBps: 7000,
          stressMaximumLtvBps: 6500,
        },
        maxDurationSeconds: 600,
        expiration: (nowSeconds + 600n).toString(),
        nonce: intentNonce.toString(),
      });
      const intentHash = hashRefinanceIntent(intent, this.#verifyingContract);
      const planNonce = randomNonce();
      const migrationId = computeMigrationId(intentHash, quote.quoteHash, planNonce);
      const feeMaxUnits = LOCAL_EXECUTION_FEE_UNITS;
      const quoteExpiry = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000));
      const deadline = minBigInt(nowSeconds + 240n, quoteExpiry - 5n);
      if (deadline <= nowSeconds) throw new Error('Transport quote expires too soon to authorize.');
      if (quote.depositAddress === undefined) {
        throw new Error('Prepared transport quote has no deposit address.');
      }
      const unsignedPlan = executionPlanSchema.parse({
        intentHash,
        migrationId,
        borrower,
        sourcePositionId: hashSourcePosition(snapshot.position),
        sourceMarket: route.sourceMarket,
        targetMarket: route.targetMarket,
        sourceDebtAsset: route.sourceDebtAsset,
        sourceCollateralAsset: route.sourceCollateralAsset,
        destinationDebtAsset: route.destinationDebtAsset,
        destinationCollateralAsset: route.destinationCollateralAsset,
        sourceRepaymentMaxUnits: snapshot.debtUnits,
        sourceCollateralMinUnits: snapshot.collateralUnits,
        targetDebtMaxUnits: (BigInt(snapshot.debtUnits) + BigInt(feeMaxUnits)).toString(),
        minDestinationCollateralUnits: quote.minAmountOutUnits,
        transportProvider: quote.provider,
        transportQuoteHash: quote.quoteHash,
        transportDepositAddress: quote.depositAddress,
        destinationReceiver: route.destinationEscrow,
        refundReceiver: borrower,
        fundingProvider: route.sourceVault,
        reservationHash: hashCanonicalText(`debtshift.reservation.v1:${migrationId}`),
        payoutAsset: route.sourceDebtAsset,
        payoutReceiver: route.executor,
        principalMaxUnits: snapshot.debtUnits,
        feeMaxUnits,
        routeHash: `0x${'00'.repeat(32)}`,
        deadline: deadline.toString(),
        nonce: planNonce.toString(),
      });
      const plan = executionPlanSchema.parse({
        ...unsignedPlan,
        routeHash: computeRouteHash(unsignedPlan),
      });

      return {
        simulation: {
          provider: 'DEBTSHIFT_SIMULATOR',
          mode: 'SIMULATED',
          warning: 'This route uses test assets and is not a 1Click testnet transaction.',
        },
        verifyingContract: this.#verifyingContract,
        intent,
        intentHash,
        plan,
        planHash: hashExecutionPlan(plan, this.#verifyingContract),
        quote,
        sourceSnapshot: snapshot,
        routeAnalysis,
      };
    } catch (error) {
      throw badRequest(error);
    }
  }
}

function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(16).toString('hex')}`);
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function badRequest(error: unknown): BadRequestException {
  if (error instanceof BadRequestException) return error;
  return new BadRequestException(error instanceof Error ? error.message : 'Invalid local request.');
}

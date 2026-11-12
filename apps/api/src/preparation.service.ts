import { randomBytes } from 'node:crypto';

import { storeProviderQuote } from '@debtshift/database';
import {
  computeMigrationId,
  computeRouteHash,
  executionFinancingSchema,
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
import {
  MARKET_INTELLIGENCE_PORT,
  PROTOCOL_DATA_PORT,
  type MarketIntelligencePort,
  type ProtocolDataPort,
} from './market-data/ports.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { TransportService } from './transport.service.js';

const preparationRequestSchema = z.object({ borrower: evmAddressSchema }).strict();

@Injectable()
export class PreparationService {
  readonly #verifyingContract: Address;
  readonly #mode: 'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet';
  readonly #fundedExecutionEnabled: boolean;
  readonly #sourceDebtBufferBps: number;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PROTOCOL_DATA_PORT) private readonly protocols: ProtocolDataPort,
    @Inject(MARKET_INTELLIGENCE_PORT)
    private readonly marketIntelligence: MarketIntelligencePort,
    @Inject(RouteAnalysisService) private readonly routeAnalysis: RouteAnalysisService,
    @Inject(TransportService) private readonly transport: TransportService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#verifyingContract = config.getOrThrow<Address>('EIP712_VERIFYING_CONTRACT');
    this.#mode = config.getOrThrow<'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet'>(
      'DEBTSHIFT_MODE',
    );
    this.#fundedExecutionEnabled =
      this.#mode !== 'mainnet' || config.getOrThrow<boolean>('MAINNET_EXECUTION_ENABLED');
    this.#sourceDebtBufferBps = config.get<number>('SOURCE_DEBT_BUFFER_BPS') ?? 10;
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
      const route = this.protocols.route;
      if (route.execution.kind !== 'EXECUTABLE') {
        throw new Error('Funded debt-migration preparation is disabled in mainnet-readonly mode.');
      }
      if (route.execution.mode !== this.#mode) {
        throw new Error(
          `Route execution mode ${route.execution.mode} does not match runtime mode ${this.#mode}.`,
        );
      }
      const routeAnalysis = await this.routeAnalysis.analyze({ wallet: borrower });
      const positionAnalysis = routeAnalysis.analysis.analyses[0];
      if (positionAnalysis === undefined) throw new Error('No route analysis was produced.');
      const snapshot = positionAnalysis.sourcePosition;
      const selected = positionAnalysis.comparison.evaluations.find(
        (evaluation) => evaluation.candidateId === positionAnalysis.comparison.selectedCandidateId,
      );
      if (selected === undefined || !selected.eligible) {
        throw new Error('No approved executable route satisfies the deterministic policy.');
      }
      const expectedSourceRepaymentMaximum = addBasisPointHeadroom(
        BigInt(snapshot.debtUnits),
        this.#sourceDebtBufferBps,
      );
      if (
        BigInt(selected.financing.sourceDebtPayoffAssetUnits) !== expectedSourceRepaymentMaximum
      ) {
        throw new Error('Route financing does not include the configured debt-accrual headroom.');
      }
      const policy = this.marketIntelligence.createPolicy(selected.provenance.evaluatedAt);
      const quote = await this.transport.getQuote(
        transportQuoteRequestSchema.parse({
          inputAsset: route.sourceCollateralAsset,
          outputAsset: route.destinationCollateralAsset,
          amountInUnits: snapshot.collateralUnits,
          maxSlippageBps: 50,
          destinationReceiver: route.execution.destinationEscrow,
          refundReceiver: route.execution.sourceEscrow,
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
        feeAsset: route.destinationDebtAsset,
        maxSourceDebtUnits: selected.financing.sourceDebtPayoffAssetUnits,
        minSourceCollateralUnits: snapshot.collateralUnits,
        maxTotalFeeUnits: selected.financing.solverFeeUnits,
        maxSlippageBps: 50,
        minAprReductionBps: policy.minAprReductionBps,
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
      const quoteExpiry = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000));
      const deadline = minBigInt(nowSeconds + 240n, quoteExpiry - 5n);
      if (deadline <= nowSeconds) throw new Error('Transport quote expires too soon to authorize.');
      if (quote.depositAddress === undefined) {
        throw new Error('Prepared transport quote has no deposit address.');
      }
      const financing = executionFinancingSchema.parse({
        modelVersion: selected.financing.modelVersion,
        evaluatedAt: selected.provenance.evaluatedAt,
        validUntil: deadline.toString(),
        capacityEvidenceHash: hashCanonicalText(
          [
            'debtshift.capacity-evidence.v1',
            selected.provenance.marketSnapshotId,
            selected.provenance.marketBlockNumber,
            selected.provenance.marketBlockHash,
            selected.provenance.oracleUpdatedAt,
          ].join(':'),
        ),
        liquidityBufferBps: policy.minimumLiquidityBufferBps,
        stressCollateralDropBps: policy.stressCollateralDropBps,
        settlementAsset: selected.financing.settlementAsset,
        sourceDebtPayoffAssetUnits: selected.financing.sourceDebtPayoffAssetUnits,
        sourceDebtPayoffUnits: selected.financing.sourceDebtPayoffUnits,
        ...(selected.financing.sourceConversionQuoteHash === undefined
          ? {}
          : { sourceConversionQuoteHash: selected.financing.sourceConversionQuoteHash }),
        borrowerDebtPrepaymentAssetUnits: '0',
        borrowerDebtPrepaymentUnits: selected.financing.borrowerDebtPrepaymentUnits,
        ...(selected.financing.borrowerDebtPrepaymentEvidenceId === undefined
          ? {}
          : {
              borrowerDebtPrepaymentEvidenceId: selected.financing.borrowerDebtPrepaymentEvidenceId,
            }),
        costs: selected.financing.components
          .filter((component) => component.counted)
          .map((component) => ({
            componentId: component.componentId,
            kind: component.kind,
            financingClass: component.financingClass,
            asset: component.asset,
            amountUnits: component.amountUnits,
            settlementAmountUnits: component.settlementAmountUnits,
            ...(component.conversionQuoteHash === undefined
              ? {}
              : { conversionQuoteHash: component.conversionQuoteHash }),
          })),
        solverAdvancedCostUnits: selected.financing.solverAdvancedCostUnits,
        solverPrincipalUnits: selected.financing.solverPrincipalUnits,
        solverFeeUnits: selected.financing.solverFeeUnits,
        capitalizedCostUnits: selected.financing.capitalizedCostUnits,
        separatelyPaidCostUnits: selected.financing.separatelyPaidCostUnits,
        totalRequiredRepaymentAndFinancedCostUnits:
          selected.financing.totalRequiredRepaymentAndFinancedCostUnits,
        externalFunding: selected.financing.externalFunding
          .filter((funding) => funding.counted)
          .map((funding) => ({
            fundingId: funding.fundingId,
            evidenceId: funding.evidenceId,
            asset: funding.asset,
            amountUnits: funding.amountUnits,
            escrow: funding.escrow,
            refundReceiver: funding.refundReceiver,
            authorizedUse: funding.authorizedUse,
            verificationState: 'FINALIZED' as const,
            expiresAt: Math.floor(Date.parse(funding.expiresAt) / 1_000).toString(),
          })),
        confirmedExternalFundingUnits: selected.financing.confirmedExternalFundingUnits,
        protocolBorrowCapacityUnits: selected.financing.protocolBorrowCapacityUnits,
        policyBorrowCapacityUnits: selected.financing.policyBorrowCapacityUnits,
        liquidityBorrowCapacityUnits: selected.financing.liquidityBorrowCapacityUnits,
        signedBorrowCapacityUnits: selected.financing.signedBorrowCapacityUnits,
        maximumSafeBorrowingCapacityUnits: selected.financing.maximumSafeBorrowingCapacityUnits,
        requiredDestinationBorrowUnits: selected.financing.requiredDestinationBorrowUnits,
        fundingShortfallUnits: selected.financing.fundingShortfallUnits,
      });
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
        sourceRepaymentMaxUnits: selected.financing.sourceDebtPayoffAssetUnits,
        sourceCollateralMinUnits: snapshot.collateralUnits,
        targetDebtMaxUnits: financing.requiredDestinationBorrowUnits,
        minDestinationCollateralUnits: quote.minAmountOutUnits,
        transportProvider: quote.provider,
        transportQuoteHash: quote.quoteHash,
        transportDepositAddress: quote.depositAddress,
        destinationReceiver: route.execution.destinationEscrow,
        transportRefundReceiver: route.execution.sourceEscrow,
        refundReceiver: borrower,
        fundingProvider: route.execution.sourceVault,
        reservationHash: hashCanonicalText(`debtshift.reservation.v1:${migrationId}`),
        payoutAsset: route.destinationDebtAsset,
        payoutReceiver: route.execution.executor,
        principalMaxUnits: selected.financing.solverPrincipalUnits,
        feeMaxUnits: financing.solverFeeUnits,
        financing,
        routeHash: `0x${'00'.repeat(32)}`,
        deadline: deadline.toString(),
        nonce: planNonce.toString(),
      });
      const plan = executionPlanSchema.parse({
        ...unsignedPlan,
        routeHash: computeRouteHash(unsignedPlan),
      });
      const [sourceAuthorization, targetAuthorization] = await Promise.all([
        this.protocols.prepareSourceAuthorization(plan),
        this.protocols.prepareTargetAuthorization(borrower, BigInt(plan.deadline)),
      ]);

      return {
        execution: {
          mode: this.#mode,
          transportProvider: quote.provider,
          transportMode: quote.mode,
          simulatedTransport: quote.mode === 'SIMULATED',
          fundedExecutionEnabled: this.#fundedExecutionEnabled,
          warning: executionWarning(this.#mode),
        },
        verifyingContract: this.#verifyingContract,
        intent,
        intentHash,
        plan,
        planHash: hashExecutionPlan(plan, this.#verifyingContract),
        sourceAuthorization,
        targetAuthorization,
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

function addBasisPointHeadroom(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(10_000 + basisPoints) + 9_999n) / 10_000n;
}

function badRequest(error: unknown): BadRequestException {
  if (error instanceof BadRequestException) return error;
  return new BadRequestException(error instanceof Error ? error.message : 'Invalid request.');
}

function executionWarning(mode: 'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet'): string {
  if (mode === 'sandbox') {
    return 'Contract-backed sandbox: test assets and an explicitly simulated external transport provider.';
  }
  if (mode === 'testnet') {
    return 'Public testnet contracts: the external transport provider is simulated because 1Click has no testnet.';
  }
  if (mode === 'mainnet') {
    return 'Mainnet plan: real funds can move only when the server execution switch and every authorization gate pass.';
  }
  return 'Read-only mode cannot prepare funded execution.';
}

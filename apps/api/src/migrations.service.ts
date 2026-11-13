import { isDeepStrictEqual } from 'node:util';

import {
  advanceMigrationWithEvidence,
  createAuthorizedMigration,
  getMigrationBorrower,
  getProviderQuote,
  getMigrationDetails,
  getSignedExecutionPlan,
  getSignedIntent,
  listEnabledMarkets,
  listMigrationEventsAfter,
  listWalletPositions,
} from '@debtshift/database';
import {
  assertFundedExecutionEnabled,
  assertExecutionPlanIntegrity,
  computeMigrationId,
  evidenceSchema,
  hashCanonicalText,
  hashExecutionPlan,
  hashRefinanceIntent,
  hashSourcePosition,
  verifySignedExecutionPlan,
  verifySignedRefinanceIntent,
} from '@debtshift/domain';
import type {
  executionPlanSchema,
  positionSnapshotSchema,
  providerQuoteSchema,
  SignedExecutionPlan,
  SignedRefinanceIntent,
} from '@debtshift/domain';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type MessageEvent,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compareRoutes } from '@debtshift/optimizer';
import { captureTraceContext } from '@debtshift/observability';
import { concatMap, from, mergeMap, timer, type Observable } from 'rxjs';
import { createPublicClient, http, isAddressEqual, type Address, type Hex } from 'viem';
import type { z } from 'zod';

import { DatabaseService } from './database.service.js';
import { executeMigrationRequestSchema } from './http-contracts.js';
import {
  MARKET_INTELLIGENCE_PORT,
  PROTOCOL_DATA_PORT,
  type MarketIntelligencePort,
  type ProtocolDataPort,
} from './market-data/ports.js';

@Injectable()
export class MigrationsService {
  readonly #verifyingContract: Address;
  readonly #sourceClient;
  readonly #sourceDebtBufferBps: number;
  readonly #executionEnvironment: {
    readonly DEBTSHIFT_MODE: 'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet';
    readonly MAINNET_EXECUTION_ENABLED: boolean;
  };

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PROTOCOL_DATA_PORT) private readonly protocols: ProtocolDataPort,
    @Inject(MARKET_INTELLIGENCE_PORT)
    private readonly marketTools: MarketIntelligencePort,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#verifyingContract = config.getOrThrow<Address>('EIP712_VERIFYING_CONTRACT');
    this.#executionEnvironment = {
      DEBTSHIFT_MODE: config.getOrThrow<'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet'>(
        'DEBTSHIFT_MODE',
      ),
      MAINNET_EXECUTION_ENABLED: config.getOrThrow<boolean>('MAINNET_EXECUTION_ENABLED'),
    };
    this.#sourceClient = createPublicClient({
      transport: http(config.getOrThrow<string>('SOURCE_RPC_URL')),
    });
    this.#sourceDebtBufferBps = config.get<number>('SOURCE_DEBT_BUFFER_BPS') ?? 10;
  }

  async execute(input: unknown, authenticatedWallet: Address) {
    try {
      const parsed = executeMigrationRequestSchema.parse(input);
      if (!isAddressEqual(parsed.signedIntent.intent.borrower, authenticatedWallet)) {
        throw new ForbiddenException('Wallet session does not match the signed borrower.');
      }
      assertFundedExecutionEnabled(this.#executionEnvironment);
      const signedIntent = parsed.signedIntent;
      const signedPlan = parsed.signedPlan;
      assertExecutionPlanIntegrity(signedPlan.plan);
      this.assertBindings(signedIntent, signedPlan, parsed.quote, parsed.sourceSnapshot);
      const preparedQuote = await getProviderQuote(this.database.db, parsed.quote.quoteHash);
      if (preparedQuote === undefined || !isDeepStrictEqual(preparedQuote, parsed.quote)) {
        throw new Error('Transport quote was not issued and persisted by this DebtShift API.');
      }
      await this.protocols.verifySourceSnapshot(parsed.sourceSnapshot);
      await this.revalidateFinancing(parsed.sourceSnapshot, signedPlan.plan);

      const eip1271Reader = {
        readIsValidSignature: async (
          wallet: Address,
          digest: Hex,
          signature: Hex,
          blockNumber?: bigint,
        ): Promise<Hex> =>
          this.#sourceClient.readContract({
            address: wallet,
            abi: [
              {
                type: 'function',
                name: 'isValidSignature',
                stateMutability: 'view',
                inputs: [
                  { name: 'hash', type: 'bytes32' },
                  { name: 'signature', type: 'bytes' },
                ],
                outputs: [{ name: 'magicValue', type: 'bytes4' }],
              },
            ],
            functionName: 'isValidSignature',
            args: [digest, signature],
            ...(blockNumber === undefined ? {} : { blockNumber }),
          }),
      };
      const [intentValid, planValid] = await Promise.all([
        verifySignedRefinanceIntent(signedIntent, this.#verifyingContract, eip1271Reader),
        verifySignedExecutionPlan(
          signedPlan,
          signedIntent.intent.accountType,
          this.#verifyingContract,
          eip1271Reader,
        ),
      ]);
      if (!intentValid || !planValid) throw new Error('Borrower authorization is invalid.');
      const targetLendingAuthorization = await this.protocols.verifyTargetAuthorization(
        parsed.targetAuthorization,
        signedPlan.plan.borrower,
        BigInt(signedPlan.plan.deadline),
      );
      const sourceLendingAuthorization = await this.protocols.verifySourceAuthorization(
        parsed.sourceAuthorization,
        signedPlan.plan,
      );

      const result = await createAuthorizedMigration(
        this.database.db,
        {
          signedIntent,
          signedPlan,
          quote: parsed.quote,
          sourceSnapshot: parsed.sourceSnapshot,
          sourceLendingAuthorization,
          targetLendingAuthorization,
        },
        captureTraceContext(),
      );
      Logger.log(
        JSON.stringify({
          event: result.created ? 'workflow_migration_authorized' : 'workflow_migration_reconciled',
          migrationId: result.migrationId,
          phase: 'AUTHORIZED',
          ...(result.initialCommandId === undefined
            ? {}
            : { commandId: result.initialCommandId, commandType: 'RESERVE_LIQUIDITY' }),
          mode: this.#executionEnvironment.DEBTSHIFT_MODE,
        }),
        'Workflow',
      );
      return result;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) throw error;
      const message = error instanceof Error ? error.message : 'Invalid migration request.';
      throw new BadRequestException(message);
    }
  }

  async getMigration(migrationId: string, authenticatedWallet: Address) {
    const borrower = await getMigrationBorrower(this.database.db, migrationId);
    if (borrower === undefined || !isAddressEqual(borrower as Address, authenticatedWallet)) {
      throw new NotFoundException('Migration not found.');
    }
    const result = await getMigrationDetails(this.database.db, migrationId);
    if (result === undefined) throw new NotFoundException('Migration not found.');
    return result;
  }

  async getIntent(intentHash: string, authenticatedWallet: Address) {
    const stored = await getSignedIntent(this.database.db, intentHash);
    if (
      stored === undefined ||
      !isAddressEqual(stored.walletAddress as Address, authenticatedWallet)
    ) {
      throw new NotFoundException('Intent not found.');
    }
    return stored.signedIntent;
  }

  async getPlan(planHash: string, authenticatedWallet: Address) {
    const stored = await getSignedExecutionPlan(this.database.db, planHash);
    if (
      stored === undefined ||
      !isAddressEqual(stored.walletAddress as Address, authenticatedWallet)
    ) {
      throw new NotFoundException('Execution plan not found.');
    }
    return stored.signedPlan;
  }

  async cancel(migrationId: string, authenticatedWallet: Address) {
    const details = await this.getMigration(migrationId, authenticatedWallet);
    if (details.migration.phase === 'CANCELLED') {
      return { migrationId, phase: 'CANCELLED' as const, cancellationRequested: true };
    }
    if (details.migration.phase !== 'AUTHORIZED' && details.migration.phase !== 'RESERVED') {
      throw new ConflictException(
        `Migration cancellation is not permitted from phase ${details.migration.phase}.`,
      );
    }
    const observedAt = new Date().toISOString();
    const payload = {
      reason: 'BORROWER_REQUESTED_CANCELLATION',
      requestedBy: authenticatedWallet,
      requestedPhase: details.migration.phase,
    };
    const evidenceId = hashCanonicalText(
      `debtshift.evidence.v1:${migrationId}:MIGRATION_CANCELLATION_REQUESTED:${authenticatedWallet.toLowerCase()}`,
    );
    const record = evidenceSchema.parse({
      evidenceId,
      migrationId,
      type: 'MIGRATION_CANCELLATION_REQUESTED',
      schemaVersion: 1,
      provider: 'DEBTSHIFT_API',
      network: 'debtshift:workflow',
      providerReference: evidenceId,
      rawObservationHash: hashCanonicalText(JSON.stringify(payload)),
      normalizedPayload: payload,
      observedAt,
      verificationState: 'FINALIZED',
      verificationMethod: 'AUTHENTICATED_BORROWER_SESSION',
      verifierVersion: 'debtshift-api-v1',
    });
    try {
      const phase = await advanceMigrationWithEvidence(
        this.database.db,
        record,
        authenticatedWallet,
        captureTraceContext(),
      );
      return { migrationId, phase, cancellationRequested: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Migration cancellation failed.';
      throw new ConflictException(message);
    }
  }

  async streamMigrationEvents(
    migrationId: string,
    initialAfterSequence: number,
    authenticatedWallet: Address,
  ): Promise<Observable<MessageEvent>> {
    await this.getMigration(migrationId, authenticatedWallet);
    let cursor = initialAfterSequence;
    let emptyPolls = 0;

    return timer(0, 1_000).pipe(
      concatMap(async () => {
        const events = await listMigrationEventsAfter(this.database.db, migrationId, cursor);
        if (events.length > 0) {
          cursor = events.at(-1)?.sequence ?? cursor;
          emptyPolls = 0;
          return events.map((event): MessageEvent => ({
            type: 'migration',
            id: event.sequence.toString(),
            retry: 1_500,
            data: {
              migrationId,
              sequence: event.sequence,
              type: event.type,
              phase: event.phase,
              observedAt: event.observedAt,
              payloadHash: event.payloadHash,
            },
          }));
        }

        const shouldEmitKeepalive = emptyPolls === 0 || emptyPolls >= 14;
        emptyPolls = shouldEmitKeepalive ? 1 : emptyPolls + 1;
        return shouldEmitKeepalive
          ? [
              {
                type: 'keepalive',
                retry: 1_500,
                data: { migrationId, cursor, observedAt: new Date().toISOString() },
              } satisfies MessageEvent,
            ]
          : [];
      }),
      mergeMap((events) => from(events)),
    );
  }

  listPositions(walletAddress: string) {
    return listWalletPositions(this.database.db, walletAddress);
  }

  listMarkets() {
    return listEnabledMarkets(this.database.db);
  }

  private async revalidateFinancing(
    snapshot: z.infer<typeof positionSnapshotSchema>,
    plan: z.infer<typeof executionPlanSchema>,
  ): Promise<void> {
    const evaluatedAt = new Date().toISOString();
    const candidates = await this.marketTools.getRouteCandidates(snapshot, evaluatedAt);
    const candidate = candidates.find((route) =>
      sameMarket(route.market.market, plan.targetMarket),
    );
    if (candidate === undefined) {
      throw new Error(
        'The signed target market is no longer available for financing revalidation.',
      );
    }
    const comparison = compareRoutes({
      sourcePosition: snapshot,
      candidates: [candidate],
      policy: this.marketTools.createPolicy(evaluatedAt),
    });
    const current = comparison.evaluations[0];
    if (current === undefined || !current.eligible) {
      const reasons =
        current?.rejections.map((rejection) => rejection.code).join(', ') ?? 'UNKNOWN';
      throw new Error(`Financing revalidation failed before reservation: ${reasons}.`);
    }
    const signed = plan.financing;
    const exactFields = [
      'borrowerDebtPrepaymentUnits',
      'solverAdvancedCostUnits',
      'solverFeeUnits',
      'capitalizedCostUnits',
      'separatelyPaidCostUnits',
      'confirmedExternalFundingUnits',
    ] as const;
    for (const field of exactFields) {
      if (current.financing[field] !== signed[field]) {
        throw new Error(`Financing revalidation changed signed field ${field}.`);
      }
    }
    const boundedFields = [
      'sourceDebtPayoffAssetUnits',
      'sourceDebtPayoffUnits',
      'solverPrincipalUnits',
      'totalRequiredRepaymentAndFinancedCostUnits',
      'requiredDestinationBorrowUnits',
    ] as const;
    for (const field of boundedFields) {
      if (BigInt(current.financing[field]) > BigInt(signed[field])) {
        throw new Error(`Financing revalidation exceeds signed field ${field}.`);
      }
    }
    if (
      BigInt(current.financing.maximumSafeBorrowingCapacityUnits) <
      BigInt(signed.requiredDestinationBorrowUnits)
    ) {
      throw new Error('Fresh maximum safe borrowing capacity is below the signed requirement.');
    }
    if (current.financing.fundingShortfallUnits !== '0') {
      throw new Error('Fresh financing evidence has a non-zero funding shortfall.');
    }
  }

  private assertBindings(
    signedIntent: SignedRefinanceIntent,
    signedPlan: SignedExecutionPlan,
    quote: z.infer<typeof providerQuoteSchema>,
    snapshot: z.infer<typeof positionSnapshotSchema>,
  ): void {
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(signedIntent.intent.expiration) <= nowSeconds)
      throw new Error('Intent has expired.');
    if (BigInt(signedPlan.plan.deadline) <= nowSeconds)
      throw new Error('Execution plan has expired.');
    if (BigInt(signedPlan.plan.deadline) > BigInt(signedIntent.intent.expiration)) {
      throw new Error('Execution plan outlives the signed intent.');
    }
    if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error('Transport quote has expired.');
    if (
      signedIntent.intentHash !== hashRefinanceIntent(signedIntent.intent, this.#verifyingContract)
    ) {
      throw new Error('Intent hash does not match the authorization payload.');
    }
    if (signedPlan.planHash !== hashExecutionPlan(signedPlan.plan, this.#verifyingContract)) {
      throw new Error('Plan hash does not match the authorization payload.');
    }
    if (signedPlan.plan.intentHash !== signedIntent.intentHash) {
      throw new Error('Execution plan is bound to another intent.');
    }
    if (signedPlan.plan.borrower !== signedIntent.intent.borrower) {
      throw new Error('Execution plan borrower does not match the signed intent.');
    }
    if (
      signedPlan.plan.migrationId !==
      computeMigrationId(signedIntent.intentHash, quote.quoteHash, BigInt(signedPlan.plan.nonce))
    ) {
      throw new Error('Migration identifier is not derived from the signed intent and quote.');
    }
    if (signedPlan.plan.transportQuoteHash !== quote.quoteHash) {
      throw new Error('Execution plan is bound to another transport quote.');
    }
    if (signedPlan.plan.transportProvider !== quote.provider) {
      throw new Error('Transport provider does not match the execution plan.');
    }
    if (Date.parse(quote.expiresAt) < Number(BigInt(signedPlan.plan.deadline) * 1000n)) {
      throw new Error('Execution plan outlives the committed transport quote.');
    }
    if (signedPlan.plan.transportDepositAddress !== quote.depositAddress) {
      throw new Error('Transport deposit address does not match the execution plan.');
    }
    if (
      !isAddressEqual(signedPlan.plan.destinationReceiver, quote.destinationReceiver as Address)
    ) {
      throw new Error('Transport destination receiver does not match the execution plan.');
    }
    if (!isAddressEqual(signedPlan.plan.transportRefundReceiver, quote.refundReceiver as Address)) {
      throw new Error('Transport refund receiver does not match the execution plan.');
    }
    if (hashSourcePosition(snapshot.position) !== signedPlan.plan.sourcePositionId) {
      throw new Error('Source snapshot does not match the execution plan position.');
    }
    if (
      hashSourcePosition(signedIntent.intent.sourcePosition) !== signedPlan.plan.sourcePositionId
    ) {
      throw new Error('Execution plan source position does not match the signed intent.');
    }
    if (!sameMarket(signedPlan.plan.sourceMarket, signedIntent.intent.sourcePosition.market)) {
      throw new Error('Execution plan source market does not match the signed intent.');
    }
    if (
      !signedIntent.intent.allowedTargets.some((target) =>
        sameMarket(target, signedPlan.plan.targetMarket),
      )
    ) {
      throw new Error('Execution plan target market is not authorized by the intent.');
    }
    const expectedSourceRepaymentMaximum = addBasisPointHeadroom(
      BigInt(snapshot.debtUnits),
      this.#sourceDebtBufferBps,
    );
    if (
      BigInt(signedPlan.plan.sourceRepaymentMaxUnits) !== expectedSourceRepaymentMaximum ||
      BigInt(signedIntent.intent.maxSourceDebtUnits) !== expectedSourceRepaymentMaximum
    ) {
      throw new Error('Source repayment cap does not match the configured debt-accrual headroom.');
    }
    if (BigInt(snapshot.collateralUnits) < BigInt(signedPlan.plan.sourceCollateralMinUnits)) {
      throw new Error('Source collateral is below the signed minimum.');
    }
    if (
      BigInt(signedPlan.plan.sourceRepaymentMaxUnits) >
      BigInt(signedIntent.intent.maxSourceDebtUnits)
    ) {
      throw new Error('Source repayment exceeds the signed intent cap.');
    }
    if (
      BigInt(signedPlan.plan.sourceCollateralMinUnits) <
      BigInt(signedIntent.intent.minSourceCollateralUnits)
    ) {
      throw new Error('Source collateral minimum is weaker than the signed intent.');
    }
    if (BigInt(signedPlan.plan.feeMaxUnits) > BigInt(signedIntent.intent.maxTotalFeeUnits)) {
      throw new Error('Execution fee exceeds the signed intent cap.');
    }
    if (!sameToken(signedIntent.intent.feeAsset, signedPlan.plan.financing.settlementAsset)) {
      throw new Error('Signed intent fee asset does not match the settlement asset.');
    }
    if (signedPlan.plan.financing.fundingShortfallUnits !== '0') {
      throw new Error('Execution financing has a non-zero funding shortfall.');
    }
    if (
      BigInt(signedPlan.plan.principalMaxUnits) > BigInt(signedPlan.plan.sourceRepaymentMaxUnits)
    ) {
      throw new Error('Reserved principal exceeds the source repayment authorization.');
    }
    if (signedPlan.plan.principalMaxUnits !== signedPlan.plan.financing.solverPrincipalUnits) {
      throw new Error('Reserved principal does not match the signed solver principal cap.');
    }
    if (!sameToken(signedPlan.plan.sourceDebtAsset, signedIntent.intent.sourcePosition.debtAsset)) {
      throw new Error('Execution plan source debt asset does not match the signed intent.');
    }
    if (
      !sameToken(
        signedPlan.plan.sourceCollateralAsset,
        signedIntent.intent.sourcePosition.collateralAsset,
      )
    ) {
      throw new Error('Execution plan source collateral asset does not match the signed intent.');
    }
    if (!sameToken(quote.inputAsset, signedPlan.plan.sourceCollateralAsset)) {
      throw new Error('Transport input token does not match source collateral.');
    }
    if (!sameToken(quote.outputAsset, signedPlan.plan.destinationCollateralAsset)) {
      throw new Error('Transport output token does not match destination collateral.');
    }
    const minimumOutputAllowedByIntent =
      (BigInt(quote.expectedAmountOutUnits) * BigInt(10_000 - signedIntent.intent.maxSlippageBps)) /
      10_000n;
    if (BigInt(quote.minAmountOutUnits) < minimumOutputAllowedByIntent) {
      throw new Error('Transport quote exceeds the signed slippage cap.');
    }
    if (BigInt(quote.minAmountOutUnits) < BigInt(signedPlan.plan.minDestinationCollateralUnits)) {
      throw new Error('Transport minimum output is below the signed destination minimum.');
    }
    if (BigInt(quote.amountInUnits) > BigInt(snapshot.collateralUnits)) {
      throw new Error('Transport input exceeds observed source collateral.');
    }
  }
}

function sameMarket(
  left: z.infer<typeof executionPlanSchema>['sourceMarket'],
  right: z.infer<typeof executionPlanSchema>['sourceMarket'],
): boolean {
  return (
    left.chainId === right.chainId &&
    left.protocol === right.protocol &&
    left.deployment.toLowerCase() === right.deployment.toLowerCase() &&
    left.marketId === right.marketId
  );
}

function sameToken(
  left: z.infer<typeof executionPlanSchema>['sourceDebtAsset'],
  right: z.infer<typeof executionPlanSchema>['sourceDebtAsset'],
): boolean {
  return (
    left.chainId === right.chainId &&
    left.address.toLowerCase() === right.address.toLowerCase() &&
    left.decimals === right.decimals
  );
}

function addBasisPointHeadroom(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(10_000 + basisPoints) + 9_999n) / 10_000n;
}

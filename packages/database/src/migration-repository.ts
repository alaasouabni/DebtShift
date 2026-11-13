import {
  executionPlanSchema,
  hashCanonicalText,
  hashExecutionFinancing,
  positionSnapshotSchema,
  persistedSourceLendingAuthorizationSchema,
  persistedTargetLendingAuthorizationSchema,
  providerQuoteSchema,
  refinanceIntentSchema,
  signatureSchema,
  signedExecutionPlanSchema,
  signedRefinanceIntentSchema,
  type EvidenceType,
  type PositionSnapshot,
  type PersistedSourceLendingAuthorization,
  type PersistedTargetLendingAuthorization,
  type ProviderQuote,
  type SignedExecutionPlan,
  type SignedRefinanceIntent,
} from '@debtshift/domain';
import { and, asc, desc, eq, gt } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import {
  assetCatalogVersions,
  auditEvents,
  commands,
  evidence,
  executionPlans,
  intents,
  ledgerEntries,
  liquidityReservations,
  markets,
  migrations,
  positions,
  positionSnapshots,
  providerObservations,
  providerQuotes,
  recoveryCases,
  transportLegs,
  wallets,
} from './schema.js';
import { enqueueCommandInTransaction, planNextCommand } from './workflow.js';

export interface CreateAuthorizedMigrationInput {
  readonly signedIntent: SignedRefinanceIntent;
  readonly signedPlan: SignedExecutionPlan;
  readonly quote: ProviderQuote;
  readonly sourceSnapshot: PositionSnapshot;
  readonly sourceLendingAuthorization: PersistedSourceLendingAuthorization;
  readonly targetLendingAuthorization: PersistedTargetLendingAuthorization;
}

export interface CreateAuthorizedMigrationResult {
  readonly created: boolean;
  readonly migrationId: string;
  readonly initialCommandId?: string;
}

export async function createAuthorizedMigration(
  database: DebtShiftDatabase,
  input: CreateAuthorizedMigrationInput,
): Promise<CreateAuthorizedMigrationResult> {
  const {
    signedIntent,
    signedPlan,
    quote,
    sourceSnapshot,
    sourceLendingAuthorization,
    targetLendingAuthorization,
  } = input;
  persistedSourceLendingAuthorizationSchema.parse(sourceLendingAuthorization);
  const migrationId = signedPlan.plan.migrationId;
  return database.transaction(
    async (transaction) => {
      const [existing] = await transaction
        .select({ migrationId: migrations.migrationId })
        .from(migrations)
        .where(eq(migrations.migrationId, migrationId))
        .limit(1);
      if (existing !== undefined) return { created: false, migrationId };

      const [wallet] = await transaction
        .insert(wallets)
        .values({
          chainId: signedIntent.intent.sourcePosition.market.chainId.toString(),
          address: signedIntent.intent.borrower.toLowerCase(),
          accountType: signedIntent.intent.accountType,
        })
        .onConflictDoUpdate({
          target: [wallets.chainId, wallets.address],
          set: { accountType: signedIntent.intent.accountType, updatedAt: new Date() },
        })
        .returning({ walletId: wallets.walletId });
      if (wallet === undefined) throw new Error('Wallet upsert failed.');

      const sourceMarketPk = await upsertMarket(
        transaction,
        signedPlan.plan.sourceMarket,
        signedPlan.plan.sourceDebtAsset,
        signedPlan.plan.sourceCollateralAsset,
      );
      await upsertMarket(
        transaction,
        signedPlan.plan.targetMarket,
        signedPlan.plan.destinationDebtAsset,
        signedPlan.plan.destinationCollateralAsset,
      );

      await transaction
        .insert(positions)
        .values({
          positionId: signedPlan.plan.sourcePositionId,
          walletId: wallet.walletId,
          marketPk: sourceMarketPk,
          protocolPositionId: signedPlan.plan.sourcePositionId,
          latestSnapshotId: sourceSnapshot.snapshotId,
          discoveredAt: new Date(sourceSnapshot.block.observedAt),
        })
        .onConflictDoUpdate({
          target: positions.positionId,
          set: { latestSnapshotId: sourceSnapshot.snapshotId, updatedAt: new Date() },
        });
      await transaction
        .insert(positionSnapshots)
        .values({
          snapshotId: sourceSnapshot.snapshotId,
          positionId: signedPlan.plan.sourcePositionId,
          chainId: sourceSnapshot.position.market.chainId.toString(),
          blockNumber: sourceSnapshot.block.number,
          blockHash: sourceSnapshot.block.hash,
          debtUnits: sourceSnapshot.debtUnits,
          collateralUnits: sourceSnapshot.collateralUnits,
          healthFactorWad:
            sourceSnapshot.health.kind === 'AAVE_HEALTH_FACTOR'
              ? sourceSnapshot.health.healthFactorWad
              : null,
          ltvBps: sourceSnapshot.health.kind === 'MORPHO_LTV' ? sourceSnapshot.health.ltvBps : null,
          payload: sourceSnapshot,
          rawResponseHash: hashCanonicalText(canonicalJson(sourceSnapshot)),
          observedAt: new Date(sourceSnapshot.block.observedAt),
        })
        .onConflictDoNothing({ target: positionSnapshots.snapshotId });

      await transaction
        .insert(providerQuotes)
        .values(providerQuoteValues(quote))
        .onConflictDoNothing({ target: providerQuotes.quoteHash });
      await transaction.insert(intents).values({
        intentHash: signedIntent.intentHash,
        walletId: wallet.walletId,
        nonce: signedIntent.intent.nonce,
        expiration: signedIntent.intent.expiration,
        payload: signedIntent.intent,
        signature: signedIntent.signature,
      });
      await transaction.insert(executionPlans).values({
        planHash: signedPlan.planHash,
        migrationId,
        intentHash: signedPlan.plan.intentHash,
        nonce: signedPlan.plan.nonce,
        deadline: signedPlan.plan.deadline,
        routeHash: signedPlan.plan.routeHash,
        payload: signedPlan.plan,
        signature: signedPlan.signature,
        targetLendingAuthorization,
      });
      const expiresAt = new Date(
        Math.min(Date.parse(quote.expiresAt), Number(BigInt(signedPlan.plan.deadline) * 1000n)),
      );
      await transaction.insert(migrations).values({
        migrationId,
        intentHash: signedIntent.intentHash,
        planHash: signedPlan.planHash,
        quoteHash: quote.quoteHash,
        phase: 'AUTHORIZED',
        expiresAt,
      });
      await transaction.insert(liquidityReservations).values({
        reservationId: hashCanonicalText(`debtshift.liquidity-reservation.v1:${migrationId}`),
        migrationId,
        reservationHash: signedPlan.plan.reservationHash,
        provider: signedPlan.plan.fundingProvider.toLowerCase(),
        chainId: signedPlan.plan.sourceMarket.chainId.toString(),
        asset: signedPlan.plan.sourceDebtAsset.address.toLowerCase(),
        principalUnits: signedPlan.plan.principalMaxUnits,
        feeCapUnits: signedPlan.plan.feeMaxUnits,
        status: 'PENDING',
        expiresAt: new Date(Number(BigInt(signedPlan.plan.deadline) * 1_000n)),
      });
      await transaction.insert(transportLegs).values({
        migrationId,
        legIndex: 0,
        provider: quote.provider,
        quoteHash: quote.quoteHash,
        inputAsset: quote.inputAsset,
        outputAsset: quote.outputAsset,
        inputUnits: quote.amountInUnits,
        minimumOutputUnits: quote.minAmountOutUnits,
        providerState: 'QUOTED',
        providerReference: quote.correlationId ?? quote.quoteId,
        depositAddress: quote.depositAddress ?? null,
      });

      const observedAt = sourceSnapshot.block.observedAt;
      const initialEvidence: readonly [EvidenceType, string, unknown][] = [
        ['SOURCE_POSITION_SNAPSHOT', 'DIRECT_RPC', sourceSnapshot],
        ['ROUTE_QUOTE', quote.provider, quote],
        ['INTENT_AUTHORIZATION', 'EIP712', signedIntent],
        [
          'SOURCE_LENDING_AUTHORIZATION',
          sourceLendingAuthorization.kind === 'ERC20_APPROVAL'
            ? 'ERC20_APPROVAL'
            : 'SANDBOX_NOT_REQUIRED',
          sourceLendingAuthorization,
        ],
        ['EXECUTION_PLAN_AUTHORIZATION', 'EIP712', { signedPlan, targetLendingAuthorization }],
        ['FINANCING_FEASIBILITY', 'DETERMINISTIC_ENGINE_V1', signedPlan.plan.financing],
      ];
      for (const [type, provider, payload] of initialEvidence) {
        const evidenceId = hashCanonicalText(`debtshift.evidence.v1:${migrationId}:${type}`);
        await transaction.insert(evidence).values({
          evidenceId,
          migrationId,
          type,
          schemaVersion: 1,
          provider,
          network: `eip155:${signedPlan.plan.sourceMarket.chainId.toString()}`,
          ...(type === 'SOURCE_POSITION_SNAPSHOT'
            ? {
                chainId: signedPlan.plan.sourceMarket.chainId.toString(),
                blockNumber: sourceSnapshot.block.number,
                blockHash: sourceSnapshot.block.hash,
              }
            : {}),
          ...(type === 'SOURCE_LENDING_AUTHORIZATION' &&
          sourceLendingAuthorization.kind === 'ERC20_APPROVAL'
            ? {
                chainId: sourceLendingAuthorization.authorization.chainId.toString(),
                blockNumber: sourceLendingAuthorization.blockNumber,
                blockHash: sourceLendingAuthorization.blockHash,
                transactionHash: sourceLendingAuthorization.authorization.transactionHash,
              }
            : {}),
          providerReference:
            type === 'SOURCE_LENDING_AUTHORIZATION' &&
            sourceLendingAuthorization.kind === 'ERC20_APPROVAL'
              ? sourceLendingAuthorization.authorization.transactionHash
              : evidenceId,
          rawObservationHash: hashCanonicalText(canonicalJson(payload)),
          normalizedPayload: toJsonRecord(payload),
          observedAt: new Date(observedAt),
          verificationState: 'FINALIZED',
          verificationMethod:
            type === 'SOURCE_LENDING_AUTHORIZATION'
              ? sourceLendingAuthorization.kind === 'ERC20_APPROVAL'
                ? 'FINALIZED_APPROVAL_RECEIPT_AND_EXACT_ALLOWANCE'
                : 'SANDBOX_ADAPTER_NOT_REQUIRED'
              : type.includes('AUTHORIZATION')
                ? 'SIGNATURE'
                : 'SCHEMA_AND_STATE',
          verifierVersion: 'debtshift-v1',
        });
      }
      for (const funding of signedPlan.plan.financing.externalFunding) {
        await transaction.insert(evidence).values({
          evidenceId: funding.evidenceId,
          migrationId,
          type: 'SUPPLEMENTARY_FUNDING',
          schemaVersion: 1,
          provider: 'MIGRATION_ESCROW',
          network: `eip155:${funding.asset.chainId.toString()}`,
          chainId: funding.asset.chainId.toString(),
          providerReference: funding.fundingId,
          rawObservationHash: hashCanonicalText(canonicalJson(funding)),
          normalizedPayload: toJsonRecord(funding),
          observedAt: new Date(signedPlan.plan.financing.evaluatedAt),
          verificationState: 'FINALIZED',
          verificationMethod: 'FINALIZED_ESCROW_BALANCE',
          verifierVersion: 'debtshift-financing-v1',
        });
      }
      const auditPayload = {
        intentHash: signedIntent.intentHash,
        planHash: signedPlan.planHash,
        quoteHash: quote.quoteHash,
        financingHash: hashExecutionFinancing(signedPlan.plan.financing),
        sourceAuthorization:
          sourceLendingAuthorization.kind === 'ERC20_APPROVAL'
            ? sourceLendingAuthorization.authorization.transactionHash
            : 'NONE',
      };
      await transaction.insert(auditEvents).values({
        eventId: hashCanonicalText(`debtshift.audit.v1:${migrationId}:1`),
        migrationId,
        sequence: 1,
        type: 'MIGRATION_AUTHORIZED',
        phase: 'AUTHORIZED',
        actor: signedIntent.intent.borrower,
        payload: auditPayload,
        payloadHash: hashCanonicalText(canonicalJson(auditPayload)),
        observedAt: new Date(observedAt),
      });

      const planned = planNextCommand(migrationId, 'AUTHORIZED');
      if (planned === undefined) throw new Error('Authorized migration has no next command.');
      const initialCommandId = await enqueueCommandInTransaction(transaction, migrationId, planned);
      return { created: true, migrationId, initialCommandId };
    },
    { isolationLevel: 'serializable', accessMode: 'read write', deferrable: false },
  );
}

export async function getMigrationDetails(database: DebtShiftDatabase, migrationId: string) {
  const [migration] = await database
    .select()
    .from(migrations)
    .where(eq(migrations.migrationId, migrationId))
    .limit(1);
  if (migration === undefined) return undefined;
  const [
    storedEvidence,
    storedEvents,
    storedCommands,
    storedLedger,
    storedReservations,
    storedRecoveryCases,
  ] = await Promise.all([
    database
      .select()
      .from(evidence)
      .where(eq(evidence.migrationId, migrationId))
      .orderBy(asc(evidence.createdAt)),
    database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.migrationId, migrationId))
      .orderBy(asc(auditEvents.sequence)),
    database
      .select()
      .from(commands)
      .where(eq(commands.migrationId, migrationId))
      .orderBy(asc(commands.createdAt)),
    database
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.migrationId, migrationId))
      .orderBy(asc(ledgerEntries.sequence)),
    database
      .select()
      .from(liquidityReservations)
      .where(eq(liquidityReservations.migrationId, migrationId)),
    database.select().from(recoveryCases).where(eq(recoveryCases.migrationId, migrationId)),
  ]);
  return {
    migration,
    evidence: storedEvidence,
    events: storedEvents,
    commands: storedCommands,
    ledger: storedLedger,
    reservations: storedReservations,
    recoveryCases: storedRecoveryCases,
  };
}

export async function getMigrationBorrower(
  database: DebtShiftDatabase,
  migrationId: string,
): Promise<string | undefined> {
  const [owner] = await database
    .select({ address: wallets.address })
    .from(migrations)
    .innerJoin(intents, eq(migrations.intentHash, intents.intentHash))
    .innerJoin(wallets, eq(intents.walletId, wallets.walletId))
    .where(eq(migrations.migrationId, migrationId))
    .limit(1);
  return owner?.address;
}

export async function getSignedIntent(database: DebtShiftDatabase, intentHash: string) {
  const [stored] = await database
    .select({
      payload: intents.payload,
      signature: intents.signature,
      walletAddress: wallets.address,
    })
    .from(intents)
    .innerJoin(wallets, eq(intents.walletId, wallets.walletId))
    .where(eq(intents.intentHash, intentHash))
    .limit(1);
  if (stored === undefined) return undefined;
  return {
    walletAddress: stored.walletAddress,
    signedIntent: signedRefinanceIntentSchema.parse({
      intent: refinanceIntentSchema.parse(stored.payload),
      intentHash,
      signature: signatureSchema.parse(stored.signature),
    }),
  };
}

export async function getSignedExecutionPlan(database: DebtShiftDatabase, planHash: string) {
  const [stored] = await database
    .select({
      payload: executionPlans.payload,
      signature: executionPlans.signature,
      walletAddress: wallets.address,
    })
    .from(executionPlans)
    .innerJoin(intents, eq(executionPlans.intentHash, intents.intentHash))
    .innerJoin(wallets, eq(intents.walletId, wallets.walletId))
    .where(eq(executionPlans.planHash, planHash))
    .limit(1);
  if (stored === undefined) return undefined;
  return {
    walletAddress: stored.walletAddress,
    signedPlan: signedExecutionPlanSchema.parse({
      plan: executionPlanSchema.parse(stored.payload),
      planHash,
      signature: signatureSchema.parse(stored.signature),
    }),
  };
}

export async function listMigrationEventsAfter(
  database: DebtShiftDatabase,
  migrationId: string,
  afterSequence: number,
  limit = 100,
) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('Migration event cursor must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Migration event page size must be an integer from 1 through 500.');
  }
  return database
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.migrationId, migrationId), gt(auditEvents.sequence, afterSequence)))
    .orderBy(asc(auditEvents.sequence))
    .limit(limit);
}

export async function listWalletPositions(database: DebtShiftDatabase, walletAddress: string) {
  return database
    .select({
      position: positions,
      market: markets,
      snapshot: positionSnapshots,
    })
    .from(positions)
    .innerJoin(wallets, eq(positions.walletId, wallets.walletId))
    .innerJoin(markets, eq(positions.marketPk, markets.marketPk))
    .leftJoin(positionSnapshots, eq(positions.latestSnapshotId, positionSnapshots.snapshotId))
    .where(eq(wallets.address, walletAddress.toLowerCase()))
    .orderBy(desc(positions.updatedAt));
}

export async function listEnabledMarkets(database: DebtShiftDatabase) {
  return database
    .select()
    .from(markets)
    .where(eq(markets.enabled, true))
    .orderBy(asc(markets.chainId), asc(markets.protocol));
}

export async function storeProviderQuote(
  database: DebtShiftDatabase,
  quoteInput: ProviderQuote,
): Promise<ProviderQuote> {
  const quote = providerQuoteSchema.parse(quoteInput);
  await database
    .insert(providerQuotes)
    .values(providerQuoteValues(quote))
    .onConflictDoNothing({ target: providerQuotes.quoteHash });
  const stored = await getProviderQuote(database, quote.quoteHash);
  if (stored === undefined) throw new Error('Prepared provider quote was not persisted.');
  return stored;
}

export interface ProviderObservationInput {
  readonly provider: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly requestPayload: Readonly<Record<string, unknown>>;
  readonly responsePayload: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly observedAt: string;
}

export async function storeProviderObservation(
  database: DebtShiftDatabase,
  input: ProviderObservationInput,
): Promise<string> {
  const provider = requiredBoundedText(input.provider, 64, 'provider');
  const operation = requiredBoundedText(input.operation, 64, 'operation');
  const requestHash = requiredBytes32(input.requestHash, 'request hash');
  const responseHash = requiredBytes32(input.responseHash, 'response hash');
  const observedAt = new Date(input.observedAt);
  if (Number.isNaN(observedAt.valueOf())) throw new Error('Provider observation time is invalid.');
  const observationId = hashCanonicalText(
    `debtshift.provider-observation.v1:${provider}:${operation}:${responseHash}`,
  );
  await database
    .insert(providerObservations)
    .values({
      observationId,
      provider,
      operation,
      requestHash,
      responseHash,
      requestPayload: toJsonRecord(input.requestPayload),
      responsePayload: toJsonRecord(input.responsePayload),
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: requiredBoundedText(input.correlationId, 256, 'correlation ID') }),
      observedAt,
    })
    .onConflictDoNothing({ target: providerObservations.observationId });
  const [stored] = await database
    .select({ observationId: providerObservations.observationId })
    .from(providerObservations)
    .where(eq(providerObservations.observationId, observationId))
    .limit(1);
  if (stored === undefined) throw new Error('Provider observation was not persisted.');
  return stored.observationId;
}

export interface AssetCatalogVersionInput {
  readonly provider: string;
  readonly environment: string;
  readonly assets: readonly Readonly<Record<string, unknown>>[];
  readonly rawResponseHash: string;
  readonly fetchedAt: string;
}

export async function storeAssetCatalogVersion(
  database: DebtShiftDatabase,
  input: AssetCatalogVersionInput,
): Promise<string> {
  const provider = requiredBoundedText(input.provider, 64, 'catalog provider');
  const environment = requiredBoundedText(input.environment, 64, 'catalog environment');
  const rawResponseHash = requiredBytes32(input.rawResponseHash, 'catalog raw response hash');
  const fetchedAt = new Date(input.fetchedAt);
  if (Number.isNaN(fetchedAt.valueOf())) throw new Error('Asset catalog fetch time is invalid.');
  const payload = input.assets.map((asset) => toJsonRecord(asset));
  if (payload.length === 0) throw new Error('Asset catalog cannot be empty.');
  const catalogHash = hashCanonicalText(canonicalJson(payload));
  await database
    .insert(assetCatalogVersions)
    .values({
      catalogHash,
      provider,
      environment,
      schemaVersion: 1,
      payload,
      rawResponseHash,
      fetchedAt,
    })
    .onConflictDoNothing({ target: assetCatalogVersions.catalogHash });
  const [stored] = await database
    .select({ catalogHash: assetCatalogVersions.catalogHash })
    .from(assetCatalogVersions)
    .where(eq(assetCatalogVersions.catalogHash, catalogHash))
    .limit(1);
  if (stored === undefined) throw new Error('Asset catalog version was not persisted.');
  return stored.catalogHash;
}

export async function getProviderQuote(
  database: DebtShiftDatabase,
  quoteHash: string,
): Promise<ProviderQuote | undefined> {
  const [stored] = await database
    .select({ payload: providerQuotes.payload })
    .from(providerQuotes)
    .where(eq(providerQuotes.quoteHash, quoteHash))
    .limit(1);
  return stored === undefined ? undefined : providerQuoteSchema.parse(stored.payload);
}

export async function getMigrationExecutionContext(
  database: DebtShiftDatabase,
  migrationId: string,
) {
  const [row] = await database
    .select({
      migration: migrations,
      intentPayload: intents.payload,
      intentHash: intents.intentHash,
      intentSignature: intents.signature,
      planPayload: executionPlans.payload,
      planHash: executionPlans.planHash,
      planSignature: executionPlans.signature,
      targetLendingAuthorization: executionPlans.targetLendingAuthorization,
      quotePayload: providerQuotes.payload,
      transportLeg: transportLegs,
    })
    .from(migrations)
    .innerJoin(intents, eq(migrations.intentHash, intents.intentHash))
    .innerJoin(executionPlans, eq(migrations.planHash, executionPlans.planHash))
    .innerJoin(providerQuotes, eq(migrations.quoteHash, providerQuotes.quoteHash))
    .innerJoin(
      transportLegs,
      and(eq(transportLegs.migrationId, migrations.migrationId), eq(transportLegs.legIndex, 0)),
    )
    .where(eq(migrations.migrationId, migrationId))
    .limit(1);
  if (row === undefined) return undefined;
  const signedPlan = signedExecutionPlanSchema.parse({
    plan: executionPlanSchema.parse(row.planPayload),
    planHash: row.planHash,
    signature: signatureSchema.parse(row.planSignature),
  });
  const [snapshotRow] = await database
    .select({ payload: positionSnapshots.payload })
    .from(positionSnapshots)
    .where(eq(positionSnapshots.positionId, signedPlan.plan.sourcePositionId))
    .orderBy(desc(positionSnapshots.observedAt))
    .limit(1);
  if (snapshotRow === undefined) {
    throw new Error(`Source snapshot for ${signedPlan.plan.sourcePositionId} was not found.`);
  }
  return {
    migration: row.migration,
    signedIntent: signedRefinanceIntentSchema.parse({
      intent: refinanceIntentSchema.parse(row.intentPayload),
      intentHash: row.intentHash,
      signature: signatureSchema.parse(row.intentSignature),
    }),
    signedPlan,
    targetLendingAuthorization: persistedTargetLendingAuthorizationSchema.parse(
      row.targetLendingAuthorization,
    ),
    sourceSnapshot: positionSnapshotSchema.parse(snapshotRow.payload),
    quote: providerQuoteSchema.parse(row.quotePayload),
    transportLeg: row.transportLeg,
  };
}

export type MigrationExecutionContext = NonNullable<
  Awaited<ReturnType<typeof getMigrationExecutionContext>>
>;

export interface TransportLegStateUpdate {
  readonly providerState: string;
  readonly providerReference?: string;
  readonly originTransactionHash?: string;
  readonly destinationTransactionHash?: string;
  readonly refundTransactionHash?: string;
  readonly observedOutputUnits?: string;
  readonly observationCount?: number;
}

export async function updateTransportLegState(
  database: DebtShiftDatabase,
  migrationId: string,
  update: TransportLegStateUpdate,
): Promise<void> {
  await database
    .update(transportLegs)
    .set({
      providerState: update.providerState,
      ...(update.providerReference === undefined
        ? {}
        : { providerReference: update.providerReference }),
      ...(update.originTransactionHash === undefined
        ? {}
        : { originTransactionHash: update.originTransactionHash }),
      ...(update.destinationTransactionHash === undefined
        ? {}
        : { destinationTransactionHash: update.destinationTransactionHash }),
      ...(update.refundTransactionHash === undefined
        ? {}
        : { refundTransactionHash: update.refundTransactionHash }),
      ...(update.observedOutputUnits === undefined
        ? {}
        : { observedOutputUnits: update.observedOutputUnits }),
      ...(update.observationCount === undefined
        ? {}
        : { observationCount: update.observationCount }),
      updatedAt: new Date(),
    })
    .where(and(eq(transportLegs.migrationId, migrationId), eq(transportLegs.legIndex, 0)));
}

async function upsertMarket(
  transaction: Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0],
  market: SignedExecutionPlan['plan']['sourceMarket'],
  debtAsset: SignedExecutionPlan['plan']['sourceDebtAsset'],
  collateralAsset: SignedExecutionPlan['plan']['sourceCollateralAsset'],
): Promise<string> {
  const [stored] = await transaction
    .insert(markets)
    .values({
      chainId: market.chainId.toString(),
      protocol: market.protocol,
      deployment: market.deployment.toLowerCase(),
      marketId: market.marketId,
      debtAsset,
      collateralAsset,
    })
    .onConflictDoUpdate({
      target: [markets.chainId, markets.protocol, markets.deployment, markets.marketId],
      set: { debtAsset, collateralAsset, updatedAt: new Date() },
    })
    .returning({ marketPk: markets.marketPk });
  if (stored === undefined) throw new Error('Market upsert failed.');
  return stored.marketPk;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, current: unknown) =>
    typeof current === 'bigint' ? current.toString() : current,
  );
}

function providerQuoteValues(quote: ProviderQuote): typeof providerQuotes.$inferInsert {
  return {
    quoteHash: quote.quoteHash,
    quoteId: quote.quoteId,
    provider: quote.provider,
    mode: quote.mode,
    amountInUnits: quote.amountInUnits,
    expectedAmountOutUnits: quote.expectedAmountOutUnits,
    minimumAmountOutUnits: quote.minAmountOutUnits,
    payload: quote,
    rawResponseHash: quote.rawResponseHash,
    expiresAt: new Date(quote.expiresAt),
  };
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(canonicalJson(value)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected an object payload.');
  }
  return parsed as Record<string, unknown>;
}

function requiredBoundedText(value: string, maximumLength: number, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(
      `Provider observation ${name} must be between 1 and ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function requiredBytes32(value: string, name: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Provider observation ${name} must be a lowercase bytes32 value.`);
  }
  return value;
}

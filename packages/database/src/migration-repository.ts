import {
  executionPlanSchema,
  hashCanonicalText,
  positionSnapshotSchema,
  providerQuoteSchema,
  refinanceIntentSchema,
  signatureSchema,
  signedExecutionPlanSchema,
  signedRefinanceIntentSchema,
  type EvidenceType,
  type PositionSnapshot,
  type ProviderQuote,
  type SignedExecutionPlan,
  type SignedRefinanceIntent,
} from '@debtshift/domain';
import { and, asc, desc, eq } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import {
  auditEvents,
  commands,
  evidence,
  executionPlans,
  intents,
  ledgerEntries,
  markets,
  migrations,
  positions,
  positionSnapshots,
  providerQuotes,
  transportLegs,
  wallets,
} from './schema.js';
import { enqueueCommandInTransaction, planNextCommand } from './workflow.js';

export interface CreateAuthorizedMigrationInput {
  readonly signedIntent: SignedRefinanceIntent;
  readonly signedPlan: SignedExecutionPlan;
  readonly quote: ProviderQuote;
  readonly sourceSnapshot: PositionSnapshot;
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
  const { signedIntent, signedPlan, quote, sourceSnapshot } = input;
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
        ['EXECUTION_PLAN_AUTHORIZATION', 'EIP712', signedPlan],
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
          providerReference: evidenceId,
          rawObservationHash: hashCanonicalText(canonicalJson(payload)),
          normalizedPayload: toJsonRecord(payload),
          observedAt: new Date(observedAt),
          verificationState: 'FINALIZED',
          verificationMethod: type.includes('AUTHORIZATION') ? 'SIGNATURE' : 'SCHEMA_AND_STATE',
          verifierVersion: 'debtshift-v1',
        });
      }
      const auditPayload = {
        intentHash: signedIntent.intentHash,
        planHash: signedPlan.planHash,
        quoteHash: quote.quoteHash,
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
  const [storedEvidence, storedEvents, storedCommands, storedLedger] = await Promise.all([
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
  ]);
  return {
    migration,
    evidence: storedEvidence,
    events: storedEvents,
    commands: storedCommands,
    ledger: storedLedger,
  };
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

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import {
  computeMigrationId,
  computeRouteHash,
  executionPlanSchema,
  hashCanonicalText,
  hashExecutionPlan,
  hashRefinanceIntent,
  hashSourcePosition,
  positionSnapshotSchema,
  providerQuoteSchema,
  refinanceIntentSchema,
  type SignedExecutionPlan,
  type SignedRefinanceIntent,
} from '@debtshift/domain';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DebtShiftDatabase } from './client.js';
import {
  createAuthorizedMigration,
  getMigrationDetails,
  storeAssetCatalogVersion,
  storeProviderObservation,
} from './migration-repository.js';
import * as schema from './schema.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa' as const;
const VERIFYING_CONTRACT = '0x9000000000000000000000000000000000000009' as const;
const QUOTE_HASH = `0x${'aa'.repeat(32)}` as const;
const SIGNATURE = `0x${'11'.repeat(65)}` as const;

describe('authorized migration repository', () => {
  const postgres = new PGlite();
  const database = createPgliteDrizzle(postgres, { schema }) as unknown as DebtShiftDatabase;

  beforeAll(async () => {
    if (migrationFiles.length === 0) throw new Error('Migration SQL is missing.');
    for (const migrationFile of migrationFiles) {
      await postgres.exec(readFileSync(`${migrationsDirectory}/${migrationFile}`, 'utf8'));
    }
  });

  afterAll(async () => {
    await postgres.close();
  });

  it('atomically persists signed terms, initial evidence, audit, command, and outbox', async () => {
    const input = buildInput();
    const created = await createAuthorizedMigration(database, input);
    expect(created.created).toBe(true);
    expect(created.initialCommandId).toMatch(/^0x[0-9a-f]{64}$/);

    const repeated = await createAuthorizedMigration(database, input);
    expect(repeated).toEqual({ created: false, migrationId: created.migrationId });

    const details = await getMigrationDetails(database, created.migrationId);
    expect(details?.migration.phase).toBe('AUTHORIZED');
    expect(details?.evidence.map((record) => record.type).sort()).toEqual([
      'EXECUTION_PLAN_AUTHORIZATION',
      'FINANCING_FEASIBILITY',
      'INTENT_AUTHORIZATION',
      'ROUTE_QUOTE',
      'SOURCE_POSITION_SNAPSHOT',
    ]);
    expect(details?.events).toHaveLength(1);
    expect(details?.commands).toHaveLength(1);
    expect(details?.commands[0]?.type).toBe('RESERVE_LIQUIDITY');
    const reservation = await postgres.query<{
      status: string;
      principal_units: string;
      fee_cap_units: string;
    }>('SELECT status, principal_units, fee_cap_units FROM liquidity_reservations');
    expect(reservation.rows[0]).toEqual({
      status: 'PENDING',
      principal_units: '10000000000',
      fee_cap_units: '50000000',
    });
    const counts = await postgres.query<{ commands: number; outbox: number }>(`
      SELECT
        (SELECT count(*)::int FROM commands) AS commands,
        (SELECT count(*)::int FROM outbox_messages) AS outbox
    `);
    expect(counts.rows[0]).toEqual({ commands: 1, outbox: 1 });
  });

  it('durably stores an idempotent raw provider observation without credentials', async () => {
    const requestHash = hashCanonicalText('provider-request');
    const responseHash = hashCanonicalText('provider-response');
    const input = {
      provider: 'NEAR_INTENTS_1CLICK',
      operation: 'DRY_QUOTE',
      requestHash,
      responseHash,
      requestPayload: { dry: true, amount: '1000000' },
      responsePayload: { signature: 'provider-signature', quote: { amountOut: '998000' } },
      correlationId: '2026-11-10T12:00:00.000Z',
      observedAt: '2026-11-10T12:00:00.000Z',
    } as const;

    const observationId = await storeProviderObservation(database, input);
    await expect(storeProviderObservation(database, input)).resolves.toBe(observationId);
    const stored = await postgres.query<{
      provider: string;
      operation: string;
      request_hash: string;
      response_hash: string;
      request_payload: Record<string, unknown>;
      response_payload: Record<string, unknown>;
    }>(
      `SELECT provider, operation, request_hash, response_hash, request_payload, response_payload
       FROM provider_observations WHERE observation_id = $1`,
      [observationId],
    );
    expect(stored.rows).toEqual([
      {
        provider: input.provider,
        operation: input.operation,
        request_hash: requestHash,
        response_hash: responseHash,
        request_payload: input.requestPayload,
        response_payload: input.responsePayload,
      },
    ]);
  });

  it('versions a normalized provider asset catalog independently from its raw response', async () => {
    const input = {
      provider: 'NEAR_INTENTS_1CLICK',
      environment: 'mainnet-readonly',
      assets: [
        {
          assetId: 'nep141:base-usdc.omft.near',
          blockchain: 'base',
          symbol: 'USDC',
          decimals: 6,
        },
      ],
      rawResponseHash: hashCanonicalText('catalog-raw-response'),
      fetchedAt: '2026-11-10T12:00:00.000Z',
    } as const;
    const catalogHash = await storeAssetCatalogVersion(database, input);
    await expect(storeAssetCatalogVersion(database, input)).resolves.toBe(catalogHash);
    const stored = await postgres.query<{
      provider: string;
      environment: string;
      schema_version: number;
      raw_response_hash: string;
    }>(
      `SELECT provider, environment, schema_version, raw_response_hash
       FROM asset_catalog_versions WHERE catalog_hash = $1`,
      [catalogHash],
    );
    expect(stored.rows).toEqual([
      {
        provider: input.provider,
        environment: input.environment,
        schema_version: 1,
        raw_response_hash: input.rawResponseHash,
      },
    ]);
  });
});

function buildInput() {
  const destinationDebtAsset = {
    chainId: 31_338,
    address: '0x5000000000000000000000000000000000000005',
    decimals: 6,
    symbol: 'dUSDC',
  } as const;
  const intent = refinanceIntentSchema.parse({
    borrower: BORROWER,
    accountType: 'EOA',
    sourcePosition: {
      market: {
        chainId: 31_337,
        protocol: 'LOCAL_AAVE_MOCK',
        deployment: '0x1000000000000000000000000000000000000001',
        marketId: `0x${'21'.repeat(32)}`,
      },
      borrower: BORROWER,
      collateralAsset: {
        chainId: 31_337,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 18,
        symbol: 'sWETH',
      },
      debtAsset: {
        chainId: 31_337,
        address: '0x3000000000000000000000000000000000000003',
        decimals: 6,
        symbol: 'sUSDC',
      },
    },
    allowedTargets: [
      {
        chainId: 31_338,
        protocol: 'LOCAL_MORPHO_MOCK',
        deployment: '0x4000000000000000000000000000000000000004',
        marketId: `0x${'22'.repeat(32)}`,
      },
    ],
    feeAsset: destinationDebtAsset,
    maxSourceDebtUnits: '10000000000',
    minSourceCollateralUnits: '9900000000000000000',
    maxTotalFeeUnits: '100000000',
    maxSlippageBps: 50,
    minAprReductionBps: 100,
    safetyPolicy: { kind: 'MAX_LTV_BPS', maximumLtvBps: 7000, stressMaximumLtvBps: 6500 },
    maxDurationSeconds: 1800,
    expiration: '1999999999',
    nonce: '1',
  });
  const intentHash = hashRefinanceIntent(intent, VERIFYING_CONTRACT);
  const migrationId = computeMigrationId(intentHash, QUOTE_HASH, 2n);
  const rawPlan = executionPlanSchema.parse({
    intentHash,
    migrationId,
    borrower: BORROWER,
    sourcePositionId: hashSourcePosition(intent.sourcePosition),
    sourceMarket: intent.sourcePosition.market,
    targetMarket: intent.allowedTargets[0],
    sourceDebtAsset: intent.sourcePosition.debtAsset,
    sourceCollateralAsset: intent.sourcePosition.collateralAsset,
    destinationDebtAsset,
    destinationCollateralAsset: {
      chainId: 31_338,
      address: '0x6000000000000000000000000000000000000006',
      decimals: 18,
      symbol: 'dWETH',
    },
    sourceRepaymentMaxUnits: '10000000000',
    sourceCollateralMinUnits: '9900000000000000000',
    targetDebtMaxUnits: '10050000000',
    minDestinationCollateralUnits: '9800000000000000000',
    transportProvider: 'DEBTSHIFT_SIMULATOR',
    transportQuoteHash: QUOTE_HASH,
    transportDepositAddress: 'simulator:fixture',
    destinationReceiver: '0x7000000000000000000000000000000000000007',
    refundReceiver: BORROWER,
    fundingProvider: '0x8000000000000000000000000000000000000008',
    reservationHash: `0x${'bb'.repeat(32)}`,
    payoutAsset: destinationDebtAsset,
    payoutReceiver: '0x8000000000000000000000000000000000000008',
    principalMaxUnits: '10000000000',
    feeMaxUnits: '50000000',
    financing: {
      modelVersion: 1,
      evaluatedAt: '2026-11-09T12:00:00.000Z',
      validUntil: '1999999900',
      capacityEvidenceHash: `0x${'dd'.repeat(32)}`,
      liquidityBufferBps: 1000,
      stressCollateralDropBps: 1000,
      settlementAsset: destinationDebtAsset,
      sourceDebtPayoffAssetUnits: '10000000000',
      sourceDebtPayoffUnits: '10000000000',
      sourceConversionQuoteHash: `0x${'cc'.repeat(32)}`,
      borrowerDebtPrepaymentAssetUnits: '0',
      borrowerDebtPrepaymentUnits: '0',
      costs: [],
      solverAdvancedCostUnits: '0',
      solverPrincipalUnits: '10000000000',
      solverFeeUnits: '50000000',
      capitalizedCostUnits: '0',
      separatelyPaidCostUnits: '0',
      totalRequiredRepaymentAndFinancedCostUnits: '10050000000',
      externalFunding: [],
      confirmedExternalFundingUnits: '0',
      protocolBorrowCapacityUnits: '12000000000',
      policyBorrowCapacityUnits: '11000000000',
      liquidityBorrowCapacityUnits: '13000000000',
      signedBorrowCapacityUnits: '10050000000',
      maximumSafeBorrowingCapacityUnits: '10050000000',
      requiredDestinationBorrowUnits: '10050000000',
      fundingShortfallUnits: '0',
    },
    routeHash: `0x${'00'.repeat(32)}`,
    deadline: '1999999900',
    nonce: '2',
  });
  const plan = executionPlanSchema.parse({ ...rawPlan, routeHash: computeRouteHash(rawPlan) });
  const signedIntent: SignedRefinanceIntent = { intent, intentHash, signature: SIGNATURE };
  const signedPlan: SignedExecutionPlan = {
    plan,
    planHash: hashExecutionPlan(plan, VERIFYING_CONTRACT),
    signature: SIGNATURE,
  };
  const quote = providerQuoteSchema.parse({
    quoteId: 'sim-fixture',
    quoteHash: QUOTE_HASH,
    provider: 'DEBTSHIFT_SIMULATOR',
    mode: 'SIMULATED',
    inputAsset: plan.sourceCollateralAsset,
    outputAsset: plan.destinationCollateralAsset,
    amountInUnits: '9900000000000000000',
    expectedAmountOutUnits: '9890000000000000000',
    minAmountOutUnits: '9800000000000000000',
    fees: [],
    destinationReceiver: plan.destinationReceiver,
    refundReceiver: plan.refundReceiver,
    depositAddress: plan.transportDepositAddress,
    expiresAt: '2030-01-01T00:00:00.000Z',
    correlationId: 'sim-fixture',
    rawResponseHash: hashCanonicalText('sim-fixture'),
  });
  const sourceSnapshot = positionSnapshotSchema.parse({
    snapshotId: hashCanonicalText('source-snapshot'),
    position: intent.sourcePosition,
    collateralUnits: '10000000000000000000',
    debtUnits: '10000000000',
    health: { kind: 'AAVE_HEALTH_FACTOR', healthFactorWad: '1500000000000000000' },
    borrowAprBps: 700,
    block: {
      number: '123',
      hash: `0x${'cc'.repeat(32)}`,
      observedAt: '2026-11-09T00:00:00.000Z',
    },
  });
  return { signedIntent, signedPlan, quote, sourceSnapshot };
}

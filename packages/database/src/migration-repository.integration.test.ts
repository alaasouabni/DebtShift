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
import { createAuthorizedMigration, getMigrationDetails } from './migration-repository.js';
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
      'INTENT_AUTHORIZATION',
      'ROUTE_QUOTE',
      'SOURCE_POSITION_SNAPSHOT',
    ]);
    expect(details?.events).toHaveLength(1);
    expect(details?.commands).toHaveLength(1);
    expect(details?.commands[0]?.type).toBe('RESERVE_LIQUIDITY');
    const counts = await postgres.query<{ commands: number; outbox: number }>(`
      SELECT
        (SELECT count(*)::int FROM commands) AS commands,
        (SELECT count(*)::int FROM outbox_messages) AS outbox
    `);
    expect(counts.rows[0]).toEqual({ commands: 1, outbox: 1 });
  });
});

function buildInput() {
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
    feeAsset: {
      chainId: 31_337,
      address: '0x3000000000000000000000000000000000000003',
      decimals: 6,
      symbol: 'sUSDC',
    },
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
    destinationDebtAsset: {
      chainId: 31_338,
      address: '0x5000000000000000000000000000000000000005',
      decimals: 6,
      symbol: 'dUSDC',
    },
    destinationCollateralAsset: {
      chainId: 31_338,
      address: '0x6000000000000000000000000000000000000006',
      decimals: 18,
      symbol: 'dWETH',
    },
    sourceRepaymentMaxUnits: '10000000000',
    sourceCollateralMinUnits: '9900000000000000000',
    targetDebtMaxUnits: '10100000000',
    minDestinationCollateralUnits: '9800000000000000000',
    transportProvider: 'DEBTSHIFT_SIMULATOR',
    transportQuoteHash: QUOTE_HASH,
    transportDepositAddress: 'simulator:fixture',
    destinationReceiver: '0x7000000000000000000000000000000000000007',
    refundReceiver: BORROWER,
    fundingProvider: '0x8000000000000000000000000000000000000008',
    reservationHash: `0x${'bb'.repeat(32)}`,
    payoutAsset: intent.sourcePosition.debtAsset,
    payoutReceiver: '0x8000000000000000000000000000000000000008',
    principalMaxUnits: '10000000000',
    feeMaxUnits: '50000000',
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

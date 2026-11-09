import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import {
  createAuthorizedMigration,
  debtShiftSchema,
  getMigrationDetails,
  publishPendingOutbox,
  type DebtShiftDatabase,
  type OutboxEnvelope,
} from '@debtshift/database';
import {
  computeMigrationId,
  computeRouteHash,
  executionPlanSchema,
  getExecutionPlanTypedData,
  getRefinanceIntentTypedData,
  hashCanonicalText,
  hashExecutionPlan,
  hashRefinanceIntent,
  hashSourcePosition,
  parseDebtShiftEnvironment,
  positionSnapshotSchema,
  refinanceIntentSchema,
  type MigrationPhase,
} from '@debtshift/domain';
import { DeterministicTransportSimulator, transportQuoteRequestSchema } from '@debtshift/intents';
import {
  DEFAULT_ANVIL_BORROWER_KEY,
  DEFAULT_ANVIL_DEPLOYER_KEY,
  deployLocalDebtShift,
  resolveAnvilPath,
  startAnvil,
  type LocalAnvilChain,
  type LocalDebtShiftDeployment,
} from '@debtshift/protocols';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { createSimulatedWorkflowHandlers, PostgresWorkflowContextStore } from './handlers.js';
import { ViemLocalExecutionPort } from './local-execution.js';
import { DurableCommandProcessor, PostgresCommandPersistence } from './processor.js';

const ANVIL_PATH = resolveAnvilPath();
const ANVIL_AVAILABLE = spawnSync(ANVIL_PATH, ['--version'], { windowsHide: true }).status === 0;
const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/database/migrations/', import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
type WorkflowScenario = 'SUCCESS' | 'REFUNDED' | 'TIMEOUT';

describe.skipIf(!ANVIL_AVAILABLE)('durable dual-chain workflow', () => {
  it('advances the persisted happy path to settled with one side effect per command', async () => {
    await withWorkflow(
      'SUCCESS',
      async ({ database, deployment, source, destination, createProcessor }) => {
        const migrationId = await createMigration(database, deployment, source, 'SUCCESS');
        await runUntil(database, createProcessor, migrationId, 'SETTLED');
        const details = await getMigrationDetails(database, migrationId);

        expect(details?.migration.phase).toBe('SETTLED');
        expect(details?.evidence.map((record) => record.type)).toEqual(
          expect.arrayContaining([
            'LIQUIDITY_RESERVATION',
            'SOURCE_CLOSE',
            'TRANSPORT_ORIGIN',
            'TRANSPORT_DESTINATION',
            'TARGET_POSITION',
            'LIQUIDITY_SETTLEMENT',
            'LEDGER_RECONCILIATION',
          ]),
        );
        expect(details?.commands.filter((command) => command.status === 'SUCCEEDED')).toHaveLength(
          6,
        );

        const targetArtifact = await import('@debtshift/protocols').then(
          ({ loadFoundryArtifact }) => loadFoundryArtifact('MockTargetLending'),
        );
        const targetPosition = await destination.publicClient.readContract({
          address: deployment.destination.lending,
          abi: targetArtifact.abi,
          functionName: 'positions',
          args: [deployment.borrower],
        });
        expect(targetPosition).toEqual([9_900_000_000_000_000_000n, 10_050_000_000n]);
      },
    );
  }, 60_000);

  it('derives recovery from refund evidence and terminates failed-safe with full collateral', async () => {
    await withWorkflow('REFUNDED', async ({ database, deployment, source, createProcessor }) => {
      const migrationId = await createMigration(database, deployment, source, 'REFUNDED');
      await runUntil(database, createProcessor, migrationId, 'FAILED_SAFE');
      const details = await getMigrationDetails(database, migrationId);

      expect(details?.migration.phase).toBe('FAILED_SAFE');
      expect(details?.evidence.map((record) => record.type)).toEqual(
        expect.arrayContaining(['RECOVERY_OPENED', 'RECOVERY_COMPLETED']),
      );
      const tokenArtifact = await import('@debtshift/protocols').then(({ loadFoundryArtifact }) =>
        loadFoundryArtifact('TestToken'),
      );
      const refund = await source.publicClient.readContract({
        address: deployment.source.collateralToken,
        abi: tokenArtifact.abi,
        functionName: 'balanceOf',
        args: [deployment.borrower],
      });
      expect(refund).toBe(10n * 10n ** 18n);
    });
  }, 60_000);

  it('moves known transport custody into recovery after the signed deadline', async () => {
    await withWorkflow('TIMEOUT', async ({ database, deployment, source, createProcessor }) => {
      const migrationId = await createMigration(database, deployment, source, 'TIMEOUT');
      await runUntil(database, createProcessor, migrationId, 'FAILED_SAFE', true);
      const details = await getMigrationDetails(database, migrationId);

      expect(details?.evidence.map((record) => record.type)).toEqual(
        expect.arrayContaining(['MIGRATION_EXPIRED', 'RECOVERY_OPENED', 'RECOVERY_COMPLETED']),
      );
    });
  }, 60_000);
});

interface WorkflowFixture {
  readonly database: DebtShiftDatabase;
  readonly deployment: LocalDebtShiftDeployment;
  readonly source: LocalAnvilChain;
  readonly destination: LocalAnvilChain;
  readonly createProcessor: () => DurableCommandProcessor;
}

async function withWorkflow(
  outcome: WorkflowScenario,
  test: (fixture: WorkflowFixture) => Promise<void>,
): Promise<void> {
  const source = await startAnvil({ chainId: 31_337, port: 19_555, anvilPath: ANVIL_PATH });
  const destination = await startAnvil({ chainId: 31_338, port: 19_556, anvilPath: ANVIL_PATH });
  const postgres = new PGlite();
  try {
    for (const migrationFile of migrationFiles) {
      await postgres.exec(readFileSync(`${migrationsDirectory}/${migrationFile}`, 'utf8'));
    }
    const database = createPgliteDrizzle(postgres, {
      schema: debtShiftSchema,
    }) as unknown as DebtShiftDatabase;
    const deployment = await deployLocalDebtShift(
      source.chain,
      source.publicClient,
      destination.chain,
      destination.publicClient,
    );
    const environment = parseDebtShiftEnvironment({
      DEBTSHIFT_ENV: 'local',
      SOURCE_RPC_URL: source.rpcUrl,
      DESTINATION_RPC_URL: destination.rpcUrl,
      LOCAL_EXECUTOR_PRIVATE_KEY: DEFAULT_ANVIL_DEPLOYER_KEY,
      SOURCE_DEBT_TOKEN_ADDRESS: deployment.source.debtToken,
      SOURCE_COLLATERAL_TOKEN_ADDRESS: deployment.source.collateralToken,
      SOURCE_VAULT_ADDRESS: deployment.source.vault,
      SOURCE_ESCROW_ADDRESS: deployment.source.escrow,
      SOURCE_ADAPTER_ADDRESS: deployment.source.adapter,
      DESTINATION_DEBT_TOKEN_ADDRESS: deployment.destination.debtToken,
      DESTINATION_COLLATERAL_TOKEN_ADDRESS: deployment.destination.collateralToken,
      DESTINATION_ESCROW_ADDRESS: deployment.destination.escrow,
      DESTINATION_ADAPTER_ADDRESS: deployment.destination.adapter,
    });
    const createProcessor = () => {
      const simulator = new DeterministicTransportSimulator({
        outcome: outcome === 'TIMEOUT' ? 'SUCCESS' : outcome,
        feeBps: 100,
        processingPolls: outcome === 'TIMEOUT' ? 100 : 1,
      });
      return new DurableCommandProcessor(
        new PostgresCommandPersistence(database),
        createSimulatedWorkflowHandlers(
          new PostgresWorkflowContextStore(database),
          new ViemLocalExecutionPort(environment),
          simulator,
        ),
      );
    };
    await test({ database, deployment, source, destination, createProcessor });
  } finally {
    await postgres.close();
    await Promise.all([source.stop(), destination.stop()]);
  }
}

async function createMigration(
  database: DebtShiftDatabase,
  deployment: LocalDebtShiftDeployment,
  source: LocalAnvilChain,
  outcome: WorkflowScenario,
): Promise<string> {
  const borrower = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
  const block = await source.publicClient.getBlock({ blockTag: 'latest' });
  if (block.hash === null) throw new Error('Latest source block was not finalized.');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const intent = refinanceIntentSchema.parse({
    borrower: deployment.borrower,
    accountType: 'EOA',
    sourcePosition: {
      market: {
        chainId: 31_337,
        protocol: 'LOCAL_AAVE_MOCK',
        deployment: deployment.source.lending,
        marketId: `0x${'21'.repeat(32)}`,
      },
      borrower: deployment.borrower,
      collateralAsset: {
        chainId: 31_337,
        address: deployment.source.collateralToken,
        decimals: 18,
        symbol: 'sWETH',
      },
      debtAsset: {
        chainId: 31_337,
        address: deployment.source.debtToken,
        decimals: 6,
        symbol: 'sUSDC',
      },
    },
    allowedTargets: [
      {
        chainId: 31_338,
        protocol: 'LOCAL_MORPHO_MOCK',
        deployment: deployment.destination.lending,
        marketId: `0x${'22'.repeat(32)}`,
      },
    ],
    feeAsset: {
      chainId: 31_337,
      address: deployment.source.debtToken,
      decimals: 6,
      symbol: 'sUSDC',
    },
    maxSourceDebtUnits: '10000000000',
    minSourceCollateralUnits: '10000000000000000000',
    maxTotalFeeUnits: '100000000',
    maxSlippageBps: 100,
    minAprReductionBps: 100,
    safetyPolicy: {
      kind: 'MAX_LTV_BPS',
      maximumLtvBps: 7000,
      stressMaximumLtvBps: 6500,
    },
    maxDurationSeconds: 600,
    expiration: (nowSeconds + 600).toString(),
    nonce: outcome === 'SUCCESS' ? '1' : outcome === 'REFUNDED' ? '3' : '5',
  });
  const intentHash = hashRefinanceIntent(intent, deployment.source.adapter);
  const simulator = new DeterministicTransportSimulator({
    outcome: outcome === 'TIMEOUT' ? 'SUCCESS' : outcome,
    feeBps: 100,
    processingPolls: 1,
  });
  const quote = await simulator.getQuote(
    transportQuoteRequestSchema.parse({
      inputAsset: intent.sourcePosition.collateralAsset,
      outputAsset: {
        chainId: 31_338,
        address: deployment.destination.collateralToken,
        decimals: 18,
        symbol: 'dWETH',
      },
      amountInUnits: '10000000000000000000',
      maxSlippageBps: intent.maxSlippageBps,
      destinationReceiver: deployment.destination.escrow,
      refundReceiver: deployment.borrower,
    }),
  );
  const planNonce = outcome === 'SUCCESS' ? 2n : outcome === 'REFUNDED' ? 4n : 6n;
  const migrationId = computeMigrationId(intentHash, quote.quoteHash, planNonce);
  const unsignedPlan = executionPlanSchema.parse({
    intentHash,
    migrationId,
    borrower: deployment.borrower,
    sourcePositionId: hashSourcePosition(intent.sourcePosition),
    sourceMarket: intent.sourcePosition.market,
    targetMarket: intent.allowedTargets[0],
    sourceDebtAsset: intent.sourcePosition.debtAsset,
    sourceCollateralAsset: intent.sourcePosition.collateralAsset,
    destinationDebtAsset: {
      chainId: 31_338,
      address: deployment.destination.debtToken,
      decimals: 6,
      symbol: 'dUSDC',
    },
    destinationCollateralAsset: quote.outputAsset,
    sourceRepaymentMaxUnits: '10000000000',
    sourceCollateralMinUnits: '10000000000000000000',
    targetDebtMaxUnits: '10100000000',
    minDestinationCollateralUnits: '9800000000000000000',
    transportProvider: 'DEBTSHIFT_SIMULATOR',
    transportQuoteHash: quote.quoteHash,
    transportDepositAddress: quote.depositAddress,
    destinationReceiver: deployment.destination.escrow,
    refundReceiver: deployment.borrower,
    fundingProvider: deployment.source.vault,
    reservationHash: hashCanonicalText(`reservation:${migrationId}`),
    payoutAsset: intent.sourcePosition.debtAsset,
    payoutReceiver: deployment.deployer,
    principalMaxUnits: '10000000000',
    feeMaxUnits: '50000000',
    routeHash: `0x${'00'.repeat(32)}`,
    deadline: (nowSeconds + (outcome === 'TIMEOUT' ? 5 : 300)).toString(),
    nonce: planNonce.toString(),
  });
  const plan = executionPlanSchema.parse({
    ...unsignedPlan,
    routeHash: computeRouteHash(unsignedPlan),
  });
  const [intentSignature, planSignature] = await Promise.all([
    borrower.signTypedData(getRefinanceIntentTypedData(intent, deployment.source.adapter)),
    borrower.signTypedData(getExecutionPlanTypedData(plan, deployment.source.adapter)),
  ]);
  const sourceSnapshot = positionSnapshotSchema.parse({
    snapshotId: hashCanonicalText(`snapshot:${migrationId}`),
    position: intent.sourcePosition,
    collateralUnits: '10000000000000000000',
    debtUnits: '10000000000',
    health: { kind: 'AAVE_HEALTH_FACTOR', healthFactorWad: '1500000000000000000' },
    borrowAprBps: 700,
    block: {
      number: block.number.toString(),
      hash: block.hash,
      observedAt: new Date().toISOString(),
    },
  });
  await createAuthorizedMigration(database, {
    signedIntent: { intent, intentHash, signature: intentSignature },
    signedPlan: {
      plan,
      planHash: hashExecutionPlan(plan, deployment.source.adapter),
      signature: planSignature,
    },
    quote,
    sourceSnapshot,
  });
  return migrationId;
}

async function runUntil(
  database: DebtShiftDatabase,
  createProcessor: () => DurableCommandProcessor,
  migrationId: string,
  terminalPhase: MigrationPhase,
  waitForTimeout = false,
): Promise<void> {
  const ready: OutboxEnvelope[] = [];
  let active: OutboxEnvelope | undefined;
  let timeoutWaited = false;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const details = await getMigrationDetails(database, migrationId);
    if (details?.migration.phase === terminalPhase) return;
    if (waitForTimeout && details?.migration.phase === 'ROUTING' && !timeoutWaited) {
      timeoutWaited = true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 6_000));
    }

    if (active === undefined) {
      await publishPendingOutbox(database, async (message) => {
        ready.push(message);
      });
      active = ready.shift();
      if (active === undefined) throw new Error('Workflow has no ready durable command.');
    }

    try {
      await createProcessor().process(active);
      active = undefined;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'RetryableCommandError') throw error;
    }
  }
  throw new Error(`Workflow did not reach ${terminalPhase} within the command budget.`);
}

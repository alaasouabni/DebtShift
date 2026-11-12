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
  loadFoundryArtifact,
  resolveAnvilPath,
  startAnvil,
  write,
  type LocalAnvilChain,
  type LocalDebtShiftDeployment,
} from '@debtshift/protocols';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { createWorkflowHandlers, PostgresWorkflowContextStore } from './handlers.js';
import { DualAnvilSandboxExecutionPort } from './simulator/dual-anvil-execution.js';
import { DurableCommandProcessor, PostgresCommandPersistence } from './processor.js';
import {
  PendingSandboxRegistryPort,
  sandboxEvidenceProviders,
  SimulatedTransportExecutionPort,
} from './sandbox/simulated-transport.js';

const ANVIL_PATH = resolveAnvilPath();
const ANVIL_AVAILABLE = spawnSync(ANVIL_PATH, ['--version'], { windowsHide: true }).status === 0;
const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/database/migrations/', import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
type WorkflowScenario =
  | 'SUCCESS'
  | 'REFUNDED'
  | 'TIMEOUT'
  | 'CAPACITY_DETERIORATED'
  | 'PRE_SOURCE_CAPACITY_DETERIORATED'
  | 'PRE_SOURCE_PRICE_DETERIORATED'
  | 'PRE_SOURCE_RATE_DETERIORATED'
  | 'POST_SOURCE_PRICE_DETERIORATED'
  | 'POST_SOURCE_RATE_DETERIORATED'
  | 'POST_SOURCE_RISK_PARAMETER_DETERIORATED'
  | 'SOURCE_RESERVATION_REORGED'
  | 'DESTINATION_DELIVERY_REORGED';

const scenarioNonces: Readonly<
  Record<WorkflowScenario, { readonly intent: string; readonly plan: bigint }>
> = {
  SUCCESS: { intent: '1', plan: 2n },
  REFUNDED: { intent: '3', plan: 4n },
  TIMEOUT: { intent: '5', plan: 6n },
  CAPACITY_DETERIORATED: { intent: '7', plan: 8n },
  PRE_SOURCE_CAPACITY_DETERIORATED: { intent: '9', plan: 10n },
  PRE_SOURCE_PRICE_DETERIORATED: { intent: '11', plan: 12n },
  PRE_SOURCE_RATE_DETERIORATED: { intent: '13', plan: 14n },
  POST_SOURCE_PRICE_DETERIORATED: { intent: '15', plan: 16n },
  POST_SOURCE_RATE_DETERIORATED: { intent: '17', plan: 18n },
  POST_SOURCE_RISK_PARAMETER_DETERIORATED: { intent: '19', plan: 20n },
  SOURCE_RESERVATION_REORGED: { intent: '21', plan: 22n },
  DESTINATION_DELIVERY_REORGED: { intent: '23', plan: 24n },
};

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
        const reservations = await database
          .select({ status: debtShiftSchema.liquidityReservations.status })
          .from(debtShiftSchema.liquidityReservations);
        expect(reservations[0]?.status).toBe('SETTLED');

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

  it('halts before source close when the finalized reservation block is orphaned', async () => {
    await withWorkflow(
      'SOURCE_RESERVATION_REORGED',
      async ({ database, deployment, source, createProcessor }) => {
        const migrationId = await createMigration(
          database,
          deployment,
          source,
          'SOURCE_RESERVATION_REORGED',
        );
        const snapshotId = await anvilSnapshot(source.rpcUrl);
        await runUntil(database, createProcessor, migrationId, 'RESERVED');
        await anvilRevert(source.rpcUrl, snapshotId);
        await runUntil(database, createProcessor, migrationId, 'RECOVERY');
        const details = await getMigrationDetails(database, migrationId);

        expect(details?.migration.phase).toBe('RECOVERY');
        expect(details?.evidence.some(({ type }) => type === 'SOURCE_CLOSE')).toBe(false);
        expect(
          details?.evidence.some(
            ({ type, verificationState }) =>
              type === 'LIQUIDITY_RESERVATION' && verificationState === 'RETRACTED',
          ),
        ).toBe(true);
        expect(details?.recoveryCases[0]).toEqual(
          expect.objectContaining({
            status: 'OPEN',
            reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
            policy: 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION',
          }),
        );
        expect(details?.reservations[0]?.status).toBe('RELEASED');
        expect(details?.commands.some(({ type }) => type === 'EXECUTE_RECOVERY')).toBe(false);
      },
    );
  }, 60_000);

  it('halts before target opening when destination delivery is orphaned', async () => {
    await withWorkflow(
      'DESTINATION_DELIVERY_REORGED',
      async ({ database, deployment, source, destination, createProcessor }) => {
        const migrationId = await createMigration(
          database,
          deployment,
          source,
          'DESTINATION_DELIVERY_REORGED',
        );
        await runUntil(database, createProcessor, migrationId, 'ROUTING');
        const snapshotId = await anvilSnapshot(destination.rpcUrl);
        await runUntil(database, createProcessor, migrationId, 'DEST_FUNDED');
        const deliveredDetails = await getMigrationDetails(database, migrationId);
        const deliveryEvidence = deliveredDetails?.evidence.find(
          ({ type, verificationState }) =>
            type === 'TRANSPORT_DESTINATION' && verificationState === 'FINALIZED',
        );
        if (deliveryEvidence?.blockNumber === null || deliveryEvidence?.blockNumber === undefined) {
          throw new Error('Destination delivery evidence did not record its finalized block.');
        }
        await anvilRevert(destination.rpcUrl, snapshotId);
        await anvilMineTo(destination, BigInt(deliveryEvidence.blockNumber));
        await runUntil(database, createProcessor, migrationId, 'RECOVERY');
        const details = await getMigrationDetails(database, migrationId);

        expect(details?.migration.phase).toBe('RECOVERY');
        expect(details?.evidence.some(({ type }) => type === 'TARGET_POSITION')).toBe(false);
        expect(
          details?.evidence.some(
            ({ type, verificationState }) =>
              type === 'TRANSPORT_DESTINATION' && verificationState === 'RETRACTED',
          ),
        ).toBe(true);
        expect(details?.recoveryCases[0]).toEqual(
          expect.objectContaining({
            status: 'OPEN',
            reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
            policy: 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION',
          }),
        );
        expect(
          details?.evidence.find(({ type }) => type === 'RECOVERY_OPENED')?.normalizedPayload,
        ).toEqual(
          expect.objectContaining({
            failures: expect.arrayContaining([
              expect.objectContaining({ reason: 'CANONICAL_BLOCK_HASH_MISMATCH' }),
            ]),
          }),
        );
        expect(details?.commands.some(({ type }) => type === 'EXECUTE_RECOVERY')).toBe(false);
      },
    );
  }, 60_000);

  it('records custody and solver exposure when destination liquidity deteriorates after source close', async () => {
    await withWorkflow(
      'CAPACITY_DETERIORATED',
      async ({ database, deployment, source, destination, createProcessor }) => {
        const migrationId = await createMigration(
          database,
          deployment,
          source,
          'CAPACITY_DETERIORATED',
        );
        await runUntil(database, createProcessor, migrationId, 'DEST_FUNDED');
        await consumeDestinationLiquidity(deployment, destination);
        await runUntil(database, createProcessor, migrationId, 'FAILED_SAFE');
        const details = await getMigrationDetails(database, migrationId);

        expect(details?.migration.phase).toBe('FAILED_SAFE');
        expect(details?.evidence.map((record) => record.type)).toEqual(
          expect.arrayContaining([
            'FINANCING_REVALIDATION',
            'RECOVERY_OPENED',
            'RECOVERY_COMPLETED',
          ]),
        );
        expect(details?.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'FINANCING_REVALIDATION',
              normalizedPayload: expect.objectContaining({
                reason: 'DESTINATION_CAPACITY_DETERIORATED_AFTER_SOURCE_CLOSE',
                financingRevalidation: expect.objectContaining({
                  checkpoint: 'BEFORE_TARGET_BORROW',
                  maximumSafeBorrowingCapacityUnits: '7272727272',
                  requiredDestinationBorrowUnits: '10050000000',
                  fundingShortfallUnits: '2777272728',
                }),
              }),
            }),
          ]),
        );
        expect(details?.evidence.some((record) => record.type === 'TARGET_POSITION')).toBe(false);
        const recovery = details?.recoveryCases[0];
        expect(recovery).toEqual(
          expect.objectContaining({
            status: 'RESOLVED_FAILED_SAFE',
            reason: 'DESTINATION_CAPACITY_DETERIORATED_AFTER_SOURCE_CLOSE',
            policy: 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
          }),
        );
        expect(recovery?.residualAssets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'COLLATERAL_CUSTODY',
              amountUnits: '9900000000000000000',
              disposition: 'HELD_FOR_SIGNED_RECOVERY',
            }),
            expect.objectContaining({
              kind: 'SOLVER_RECEIVABLE',
              principalUnits: '10000000000',
              feeUnits: '50000000',
              totalClaimUnits: '10050000000',
            }),
          ]),
        );

        const [targetArtifact, tokenArtifact, vaultArtifact] = await Promise.all([
          loadFoundryArtifact('MockTargetLending'),
          loadFoundryArtifact('TestToken'),
          loadFoundryArtifact('TestLiquidityVault'),
        ]);
        const [targetPosition, borrowerRefund, reservation] = await Promise.all([
          destination.publicClient.readContract({
            address: deployment.destination.lending,
            abi: targetArtifact.abi,
            functionName: 'positions',
            args: [deployment.borrower],
          }),
          destination.publicClient.readContract({
            address: deployment.destination.collateralToken,
            abi: tokenArtifact.abi,
            functionName: 'balanceOf',
            args: [deployment.borrower],
          }),
          source.publicClient.readContract({
            address: deployment.source.vault,
            abi: vaultArtifact.abi,
            functionName: 'reservations',
            args: [migrationId],
          }),
        ]);
        expect(targetPosition).toEqual([0n, 0n]);
        expect(borrowerRefund).toBe(9_900_000_000_000_000_000n);
        expect(Array.isArray(reservation) ? reservation[8] : undefined).toBe(10_000_000_000n);
      },
    );
  }, 60_000);

  it('releases the reservation and preserves the source position when capacity falls before close', async () => {
    await withWorkflow(
      'PRE_SOURCE_CAPACITY_DETERIORATED',
      async ({ database, deployment, source, destination, createProcessor }) => {
        const migrationId = await createMigration(
          database,
          deployment,
          source,
          'PRE_SOURCE_CAPACITY_DETERIORATED',
        );
        await runUntil(database, createProcessor, migrationId, 'RESERVED');
        await consumeDestinationLiquidity(deployment, destination);
        await runUntil(database, createProcessor, migrationId, 'REQUOTE_REQUIRED');
        const details = await getMigrationDetails(database, migrationId);

        expect(details?.migration.phase).toBe('REQUOTE_REQUIRED');
        expect(details?.evidence.map((record) => record.type)).toEqual(
          expect.arrayContaining(['FINANCING_REVALIDATION', 'REQUOTE_REQUIRED']),
        );
        expect(details?.evidence.some((record) => record.type === 'SOURCE_CLOSE')).toBe(false);
        expect(details?.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'REQUOTE_REQUIRED',
              normalizedPayload: expect.objectContaining({
                reason: 'DESTINATION_CAPACITY_DETERIORATED_BEFORE_SOURCE_CLOSE',
                financingRevalidation: expect.objectContaining({
                  checkpoint: 'BEFORE_SOURCE_CLOSE',
                  maximumSafeBorrowingCapacityUnits: '7272727272',
                  fundingShortfallUnits: '2777272728',
                }),
                reservation: expect.objectContaining({
                  status: 'RELEASED',
                  principalReceivableUnits: '0',
                }),
                sourcePosition: expect.objectContaining({ disposition: 'UNCHANGED' }),
              }),
            }),
          ]),
        );
        expect(details?.reservations[0]?.status).toBe('RELEASED');
        expect(details?.recoveryCases).toHaveLength(0);

        const [sourceArtifact, vaultArtifact] = await Promise.all([
          loadFoundryArtifact('MockSourceLending'),
          loadFoundryArtifact('TestLiquidityVault'),
        ]);
        const [sourcePosition, reservation, reservedUndrawn] = await Promise.all([
          source.publicClient.readContract({
            address: deployment.source.lending,
            abi: sourceArtifact.abi,
            functionName: 'positions',
            args: [deployment.borrower],
          }),
          source.publicClient.readContract({
            address: deployment.source.vault,
            abi: vaultArtifact.abi,
            functionName: 'reservations',
            args: [migrationId],
          }),
          source.publicClient.readContract({
            address: deployment.source.vault,
            abi: vaultArtifact.abi,
            functionName: 'reservedUndrawn',
            args: [deployment.source.debtToken],
          }),
        ]);
        expect(sourcePosition).toEqual([10_000_000_000_000_000_000n, 10_000_000_000n]);
        expect(Array.isArray(reservation) ? reservation[6] : undefined).toBe(4);
        expect(Array.isArray(reservation) ? reservation[8] : undefined).toBe(0n);
        expect(reservedUndrawn).toBe(0n);
      },
    );
  }, 60_000);

  for (const testCase of [
    {
      name: 'collateral price deteriorates before source close',
      scenario: 'PRE_SOURCE_PRICE_DETERIORATED',
      marketState: [1_500n * 10n ** 18n, 7_500, 500] as const,
      expectedRevalidation: {
        collateralPriceInDebtWad: '1500000000000000000000',
        maximumSafeBorrowingCapacityUnits: '8599500000',
        fundingShortfallUnits: '1450500000',
      },
    },
    {
      name: 'the target rate breaches the signed savings policy before source close',
      scenario: 'PRE_SOURCE_RATE_DETERIORATED',
      marketState: [2_000n * 10n ** 18n, 7_500, 650] as const,
      expectedRevalidation: {
        observedTargetBorrowAprBps: 650,
        maximumTargetBorrowAprBps: 600,
        policyFailureCodes: ['TARGET_RATE_EXCEEDS_SIGNED_MAXIMUM'],
        maximumSafeBorrowingCapacityUnits: '0',
        fundingShortfallUnits: '10050000000',
      },
    },
  ] as const) {
    it(`requires a fresh plan when ${testCase.name}`, async () => {
      await withWorkflow(
        testCase.scenario,
        async ({ database, deployment, source, destination, createProcessor }) => {
          const migrationId = await createMigration(
            database,
            deployment,
            source,
            testCase.scenario,
          );
          await runUntil(database, createProcessor, migrationId, 'RESERVED');
          await setDestinationMarketState(
            deployment,
            destination,
            testCase.marketState[0],
            testCase.marketState[1],
            testCase.marketState[2],
          );
          await runUntil(database, createProcessor, migrationId, 'REQUOTE_REQUIRED');
          const details = await getMigrationDetails(database, migrationId);

          expect(details?.migration.phase).toBe('REQUOTE_REQUIRED');
          expect(details?.evidence.some((record) => record.type === 'SOURCE_CLOSE')).toBe(false);
          expect(details?.reservations[0]?.status).toBe('RELEASED');
          expect(details?.recoveryCases).toHaveLength(0);
          expect(details?.evidence).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'REQUOTE_REQUIRED',
                normalizedPayload: expect.objectContaining({
                  financingRevalidation: expect.objectContaining({
                    checkpoint: 'BEFORE_SOURCE_CLOSE',
                    ...testCase.expectedRevalidation,
                  }),
                  reservation: expect.objectContaining({
                    status: 'RELEASED',
                    principalReceivableUnits: '0',
                  }),
                  sourcePosition: expect.objectContaining({ disposition: 'UNCHANGED' }),
                }),
              }),
            ]),
          );
        },
      );
    }, 60_000);
  }

  for (const testCase of [
    {
      name: 'collateral price deteriorates after source close',
      scenario: 'POST_SOURCE_PRICE_DETERIORATED',
      marketState: [1_500n * 10n ** 18n, 7_500, 500] as const,
      expectedRevalidation: {
        collateralPriceInDebtWad: '1500000000000000000000',
        maximumSafeBorrowingCapacityUnits: '8687250000',
        fundingShortfallUnits: '1362750000',
      },
    },
    {
      name: 'the target rate breaches the signed savings policy after source close',
      scenario: 'POST_SOURCE_RATE_DETERIORATED',
      marketState: [2_000n * 10n ** 18n, 7_500, 650] as const,
      expectedRevalidation: {
        observedTargetBorrowAprBps: 650,
        maximumTargetBorrowAprBps: 600,
        policyFailureCodes: ['TARGET_RATE_EXCEEDS_SIGNED_MAXIMUM'],
        maximumSafeBorrowingCapacityUnits: '0',
        fundingShortfallUnits: '10050000000',
      },
    },
    {
      name: 'the protocol maximum LTV deteriorates after source close',
      scenario: 'POST_SOURCE_RISK_PARAMETER_DETERIORATED',
      marketState: [2_000n * 10n ** 18n, 4_500, 500] as const,
      expectedRevalidation: {
        protocolMaximumLtvBps: 4_500,
        maximumSafeBorrowingCapacityUnits: '8910000000',
        fundingShortfallUnits: '1140000000',
      },
    },
  ] as const) {
    it(`opens failed-safe recovery when ${testCase.name}`, async () => {
      await withWorkflow(
        testCase.scenario,
        async ({ database, deployment, source, destination, createProcessor }) => {
          const migrationId = await createMigration(
            database,
            deployment,
            source,
            testCase.scenario,
          );
          await runUntil(database, createProcessor, migrationId, 'DEST_FUNDED');
          await setDestinationMarketState(
            deployment,
            destination,
            testCase.marketState[0],
            testCase.marketState[1],
            testCase.marketState[2],
          );
          await runUntil(database, createProcessor, migrationId, 'FAILED_SAFE');
          const details = await getMigrationDetails(database, migrationId);

          expect(details?.migration.phase).toBe('FAILED_SAFE');
          expect(details?.evidence.some((record) => record.type === 'TARGET_POSITION')).toBe(false);
          expect(details?.recoveryCases[0]).toEqual(
            expect.objectContaining({
              status: 'RESOLVED_FAILED_SAFE',
              reason: 'DESTINATION_CAPACITY_DETERIORATED_AFTER_SOURCE_CLOSE',
            }),
          );
          expect(details?.evidence).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'FINANCING_REVALIDATION',
                normalizedPayload: expect.objectContaining({
                  financingRevalidation: expect.objectContaining({
                    checkpoint: 'BEFORE_TARGET_BORROW',
                    ...testCase.expectedRevalidation,
                  }),
                }),
              }),
            ]),
          );
        },
      );
    }, 60_000);
  }
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
      DEBTSHIFT_MODE: 'sandbox',
      SOURCE_RPC_URL: source.rpcUrl,
      DESTINATION_RPC_URL: destination.rpcUrl,
      SANDBOX_EXECUTOR_PRIVATE_KEY: DEFAULT_ANVIL_DEPLOYER_KEY,
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
        outcome: outcome === 'REFUNDED' ? 'REFUNDED' : 'SUCCESS',
        feeBps: 100,
        processingPolls: outcome === 'TIMEOUT' ? 100 : 1,
      });
      return new DurableCommandProcessor(
        new PostgresCommandPersistence(database),
        createWorkflowHandlers({
          store: new PostgresWorkflowContextStore(database),
          execution: new DualAnvilSandboxExecutionPort(environment),
          transport: new SimulatedTransportExecutionPort(simulator),
          registry: new PendingSandboxRegistryPort(),
          evidenceProviders: sandboxEvidenceProviders,
        }),
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
  const destinationDebtAsset = {
    chainId: 31_338,
    address: deployment.destination.debtToken,
    decimals: 6,
    symbol: 'dUSDC',
  } as const;
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
    feeAsset: destinationDebtAsset,
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
    nonce: scenarioNonces[outcome].intent,
  });
  const intentHash = hashRefinanceIntent(intent, deployment.source.adapter);
  const simulator = new DeterministicTransportSimulator({
    outcome: outcome === 'REFUNDED' ? 'REFUNDED' : 'SUCCESS',
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
  const planNonce = scenarioNonces[outcome].plan;
  const migrationId = computeMigrationId(intentHash, quote.quoteHash, planNonce);
  const planDeadline = nowSeconds + (outcome === 'TIMEOUT' ? 5 : 300);
  const unsignedPlan = executionPlanSchema.parse({
    intentHash,
    migrationId,
    borrower: deployment.borrower,
    sourcePositionId: hashSourcePosition(intent.sourcePosition),
    sourceMarket: intent.sourcePosition.market,
    targetMarket: intent.allowedTargets[0],
    sourceDebtAsset: intent.sourcePosition.debtAsset,
    sourceCollateralAsset: intent.sourcePosition.collateralAsset,
    destinationDebtAsset,
    destinationCollateralAsset: quote.outputAsset,
    sourceRepaymentMaxUnits: '10000000000',
    sourceCollateralMinUnits: '10000000000000000000',
    targetDebtMaxUnits: '10050000000',
    minDestinationCollateralUnits: '9800000000000000000',
    transportProvider: 'DEBTSHIFT_SIMULATOR',
    transportQuoteHash: quote.quoteHash,
    transportDepositAddress: quote.depositAddress,
    destinationReceiver: deployment.destination.escrow,
    transportRefundReceiver: deployment.source.escrow,
    refundReceiver: deployment.borrower,
    fundingProvider: deployment.source.vault,
    reservationHash: hashCanonicalText(`reservation:${migrationId}`),
    payoutAsset: destinationDebtAsset,
    payoutReceiver: deployment.deployer,
    principalMaxUnits: '10000000000',
    feeMaxUnits: '50000000',
    financing: {
      modelVersion: 1,
      evaluatedAt: new Date(nowSeconds * 1_000).toISOString(),
      validUntil: planDeadline.toString(),
      capacityEvidenceHash: hashCanonicalText(`capacity:${migrationId}`),
      liquidityBufferBps: 1000,
      stressCollateralDropBps: 1000,
      settlementAsset: destinationDebtAsset,
      sourceDebtPayoffAssetUnits: '10000000000',
      sourceDebtPayoffUnits: '10000000000',
      sourceConversionQuoteHash: hashCanonicalText(`conversion:${migrationId}`),
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
    deadline: planDeadline.toString(),
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
    sourceLendingAuthorization: {
      kind: 'NONE',
      authorization: { kind: 'NONE' },
    },
    signedIntent: { intent, intentHash, signature: intentSignature },
    signedPlan: {
      plan,
      planHash: hashExecutionPlan(plan, deployment.source.adapter),
      signature: planSignature,
    },
    quote,
    sourceSnapshot,
    targetLendingAuthorization: {
      authorization: { kind: 'NONE' },
      encodedAuthorization: '0x',
    },
  });
  return migrationId;
}

async function consumeDestinationLiquidity(
  deployment: LocalDebtShiftDeployment,
  destination: LocalAnvilChain,
): Promise<void> {
  const account = privateKeyToAccount(DEFAULT_ANVIL_DEPLOYER_KEY);
  const wallet = createWalletClient({
    account,
    chain: destination.chain,
    transport: http(destination.rpcUrl),
  });
  const [tokenArtifact, targetArtifact] = await Promise.all([
    loadFoundryArtifact('TestToken'),
    loadFoundryArtifact('MockTargetLending'),
  ]);
  const collateralUnits = 100n * 10n ** 18n;
  await write(
    wallet,
    destination.publicClient,
    tokenArtifact.abi,
    deployment.destination.collateralToken,
    'mint',
    [account.address, collateralUnits],
  );
  await write(
    wallet,
    destination.publicClient,
    tokenArtifact.abi,
    deployment.destination.collateralToken,
    'approve',
    [deployment.destination.lending, collateralUnits],
  );
  await write(
    wallet,
    destination.publicClient,
    targetArtifact.abi,
    deployment.destination.lending,
    'openPosition',
    [account.address, account.address, account.address, collateralUnits, 92_000_000_000n, '0x'],
  );
}

async function setDestinationMarketState(
  deployment: LocalDebtShiftDeployment,
  destination: LocalAnvilChain,
  collateralPriceInDebtWad: bigint,
  maximumLtvBps: number,
  borrowAprBps: number,
): Promise<void> {
  const account = privateKeyToAccount(DEFAULT_ANVIL_DEPLOYER_KEY);
  const wallet = createWalletClient({
    account,
    chain: destination.chain,
    transport: http(destination.rpcUrl),
  });
  const targetArtifact = await loadFoundryArtifact('MockTargetLending');
  await write(
    wallet,
    destination.publicClient,
    targetArtifact.abi,
    deployment.destination.lending,
    'setMarketState',
    [collateralPriceInDebtWad, maximumLtvBps, borrowAprBps],
  );
}

async function anvilSnapshot(rpcUrl: string): Promise<string> {
  const result = await anvilRpc(rpcUrl, 'evm_snapshot', []);
  if (typeof result !== 'string') throw new Error('Anvil returned an invalid snapshot identifier.');
  return result;
}

async function anvilRevert(rpcUrl: string, snapshotId: string): Promise<void> {
  const result = await anvilRpc(rpcUrl, 'evm_revert', [snapshotId]);
  if (result !== true) throw new Error(`Anvil failed to revert snapshot ${snapshotId}.`);
}

async function anvilMineTo(chain: LocalAnvilChain, targetBlock: bigint): Promise<void> {
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const rawBlockNumber = await anvilRpc(chain.rpcUrl, 'eth_blockNumber', []);
    if (typeof rawBlockNumber !== 'string') {
      throw new Error('Anvil returned an invalid block number.');
    }
    if (BigInt(rawBlockNumber) >= targetBlock) return;
    await anvilRpc(chain.rpcUrl, 'evm_mine', []);
  }
  throw new Error(`Anvil did not reach replacement block ${targetBlock.toString()}.`);
}

async function anvilRpc(
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Anvil RPC ${method} failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    readonly result?: unknown;
    readonly error?: { readonly message?: unknown };
  };
  if (payload.error !== undefined) {
    throw new Error(
      `Anvil RPC ${method} failed: ${String(payload.error.message ?? 'unknown error')}.`,
    );
  }
  return payload.result;
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

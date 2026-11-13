import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { debtShiftSchema, getMigrationDetails, type DebtShiftDatabase } from '@debtshift/database';
import {
  getExecutionPlanTypedData,
  getRefinanceIntentTypedData,
  parseDebtShiftEnvironment,
} from '@debtshift/domain';
import {
  DEFAULT_ANVIL_BORROWER_KEY,
  DEFAULT_ANVIL_DEPLOYER_KEY,
  deployLocalDebtShift,
  resolveAnvilPath,
  startAnvil,
} from '@debtshift/protocols';
import { ConfigService } from '@nestjs/config';
import { drizzle as createPgliteDrizzle } from 'drizzle-orm/pglite';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { DatabaseService } from './database.service.js';
import { LocalMarketToolsService } from './simulator/local-market-tools.service.js';
import { LocalProtocolService } from './simulator/local-protocol.service.js';
import { MigrationsService } from './migrations.service.js';
import { PreparationService } from './preparation.service.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { TransportService } from './transport.service.js';

const ANVIL_PATH = resolveAnvilPath();
const ANVIL_AVAILABLE = spawnSync(ANVIL_PATH, ['--version'], { windowsHide: true }).status === 0;
const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/database/migrations/', import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();

describe.skipIf(!ANVIL_AVAILABLE)('signed migration API flow', () => {
  it('prepares live local state, validates both signatures, and deduplicates execute', async () => {
    const source = await startAnvil({ chainId: 31_337, port: 19_565, anvilPath: ANVIL_PATH });
    const destination = await startAnvil({
      chainId: 31_338,
      port: 19_566,
      anvilPath: ANVIL_PATH,
    });
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
        EIP712_VERIFYING_CONTRACT: deployment.source.adapter,
        SANDBOX_EXECUTOR_PRIVATE_KEY: DEFAULT_ANVIL_DEPLOYER_KEY,
        SOURCE_DEBT_TOKEN_ADDRESS: deployment.source.debtToken,
        SOURCE_COLLATERAL_TOKEN_ADDRESS: deployment.source.collateralToken,
        SOURCE_LENDING_ADDRESS: deployment.source.lending,
        SOURCE_VAULT_ADDRESS: deployment.source.vault,
        SOURCE_ESCROW_ADDRESS: deployment.source.escrow,
        SOURCE_ADAPTER_ADDRESS: deployment.source.adapter,
        DESTINATION_DEBT_TOKEN_ADDRESS: deployment.destination.debtToken,
        DESTINATION_COLLATERAL_TOKEN_ADDRESS: deployment.destination.collateralToken,
        DESTINATION_LENDING_ADDRESS: deployment.destination.lending,
        DESTINATION_ESCROW_ADDRESS: deployment.destination.escrow,
        DESTINATION_ADAPTER_ADDRESS: deployment.destination.adapter,
        EXECUTOR_ADDRESS: deployment.deployer,
      });
      const config = new ConfigService(environment);
      const databaseService = { db: database } as DatabaseService;
      const protocols = new LocalProtocolService(config);
      const marketTools = new LocalMarketToolsService(protocols, config);
      const routeAnalysis = new RouteAnalysisService(marketTools, config);
      const preparation = new PreparationService(
        databaseService,
        protocols,
        marketTools,
        routeAnalysis,
        new TransportService(),
        config,
      );
      await expect(
        preparation.prepare({ borrower: deployment.borrower }, deployment.deployer),
      ).rejects.toThrow('Wallet session does not match the requested borrower.');
      const prepared = await preparation.prepare(
        { borrower: deployment.borrower },
        deployment.borrower,
      );
      const borrower = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
      const [intentSignature, planSignature] = await Promise.all([
        borrower.signTypedData(
          getRefinanceIntentTypedData(prepared.intent, prepared.verifyingContract),
        ),
        borrower.signTypedData(
          getExecutionPlanTypedData(prepared.plan, prepared.verifyingContract),
        ),
      ]);
      const request = {
        signedIntent: {
          intent: prepared.intent,
          intentHash: prepared.intentHash,
          signature: intentSignature,
        },
        signedPlan: {
          plan: prepared.plan,
          planHash: prepared.planHash,
          signature: planSignature,
        },
        quote: prepared.quote,
        sourceSnapshot: prepared.sourceSnapshot,
        sourceAuthorization: prepared.sourceAuthorization,
        targetAuthorization: prepared.targetAuthorization,
      };
      const lockedMainnet = new MigrationsService(
        databaseService,
        protocols,
        marketTools,
        new ConfigService({
          ...environment,
          DEBTSHIFT_MODE: 'mainnet',
          MAINNET_EXECUTION_ENABLED: false,
        }),
      );
      await expect(lockedMainnet.execute(request, deployment.borrower)).rejects.toThrow(
        'Mainnet execution is disabled by MAINNET_EXECUTION_ENABLED=false.',
      );
      const migrations = new MigrationsService(databaseService, protocols, marketTools, config);
      await expect(migrations.execute(request, deployment.deployer)).rejects.toThrow(
        'Wallet session does not match the signed borrower.',
      );
      const created = await migrations.execute(request, deployment.borrower);
      expect(created.created).toBe(true);

      const repeated = await migrations.execute(request, deployment.borrower);
      expect(repeated).toEqual({ created: false, migrationId: created.migrationId });
      const details = await getMigrationDetails(database, created.migrationId);
      expect(details?.migration.phase).toBe('AUTHORIZED');
      expect(details?.commands[0]?.type).toBe('RESERVE_LIQUIDITY');
      await expect(migrations.getIntent(prepared.intentHash, deployment.borrower)).resolves.toEqual(
        request.signedIntent,
      );
      await expect(migrations.getPlan(prepared.planHash, deployment.borrower)).resolves.toEqual(
        request.signedPlan,
      );
      await expect(migrations.getIntent(prepared.intentHash, deployment.deployer)).rejects.toThrow(
        'Intent not found.',
      );
      await expect(migrations.getPlan(prepared.planHash, deployment.deployer)).rejects.toThrow(
        'Execution plan not found.',
      );
      await postgres.exec(`
        UPDATE commands SET status = 'RUNNING'
        WHERE migration_id = '${created.migrationId}'
      `);
      await expect(migrations.cancel(created.migrationId, deployment.borrower)).rejects.toThrow(
        'cannot race a running financial command',
      );
      await postgres.exec(`
        UPDATE commands SET status = 'PENDING'
        WHERE migration_id = '${created.migrationId}'
      `);
      await expect(migrations.cancel(created.migrationId, deployment.borrower)).resolves.toEqual({
        migrationId: created.migrationId,
        phase: 'CANCELLED',
        cancellationRequested: true,
      });
      await expect(migrations.cancel(created.migrationId, deployment.borrower)).resolves.toEqual({
        migrationId: created.migrationId,
        phase: 'CANCELLED',
        cancellationRequested: true,
      });
      const cancelled = await getMigrationDetails(database, created.migrationId);
      expect(cancelled?.migration.phase).toBe('CANCELLED');
      expect(cancelled?.commands[0]?.status).toBe('CANCELLED');
      expect(cancelled?.reservations[0]?.status).toBe('RELEASED');
      expect(cancelled?.evidence.map(({ type }) => type)).toContain(
        'MIGRATION_CANCELLATION_REQUESTED',
      );
      expect(prepared.execution).toMatchObject({
        mode: 'sandbox',
        transportMode: 'SIMULATED',
        simulatedTransport: true,
      });
      expect(prepared.routeAnalysis.analysis.analyses[0]?.comparison.evaluations).toHaveLength(2);
      expect(prepared.routeAnalysis.analysis.analyses[0]?.comparison.selectedCandidateId).toBe(
        'local-morpho-balanced',
      );
    } finally {
      await postgres.close();
      await Promise.all([source.stop(), destination.stop()]);
    }
  }, 60_000);
});

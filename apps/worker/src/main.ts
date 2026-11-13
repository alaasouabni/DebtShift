import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

import {
  createDebtShiftDatabaseFromUrl,
  listActiveFinalizedEvidence,
  publishPendingOutbox,
  recoverStaleCommands,
  scanOperationalAlerts,
  type DebtShiftDatabase,
} from '@debtshift/database';
import { parseDebtShiftEnvironment, type DebtShiftEnvironment } from '@debtshift/domain';
import {
  DeterministicTransportSimulator,
  OneClickCommittedClient,
  type OneClickClientConfig,
} from '@debtshift/intents';
import { initializeTracing } from '@debtshift/observability';
import { Logger } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';

import { composeWorkflowHandlers, type WorkflowAdapterSet } from './composition.js';
import { PostgresWorkflowContextStore } from './handlers.js';
import { ProductionEvmExecutionPort } from './production/evm-execution.js';
import { NearReceiptRegistryPort } from './production/near-receipt-registry.js';
import {
  OneClickTransportExecutionPort,
  PostgresOneClickObservationStore,
} from './production/one-click-transport.js';
import { FundedTestnetTransportExecutionPort } from './production/testnet-transport.js';
import { DualAnvilSandboxExecutionPort } from './simulator/dual-anvil-execution.js';
import { DurableCommandProcessor, PostgresCommandPersistence } from './processor.js';
import { BullCommandPublisher, createCommandQueue, createCommandWorker } from './queue.js';
import {
  PendingSandboxRegistryPort,
  sandboxEvidenceProviders,
  SimulatedTransportExecutionPort,
} from './sandbox/simulated-transport.js';

async function bootstrap(): Promise<void> {
  loadLocalEnvironment();
  const environment = parseDebtShiftEnvironment(process.env);
  const tracing = initializeTracing({
    ...(environment.OTEL_EXPORTER_OTLP_ENDPOINT.length === 0
      ? {}
      : { endpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT }),
    serviceName: 'debtshift-worker',
    serviceVersion: '0.1.0',
    environment: environment.DEBTSHIFT_MODE,
  });
  try {
    const databaseClient = createDebtShiftDatabaseFromUrl(environment.DATABASE_URL);
    await databaseClient.pool.query('select 1');

    const redis = redisConnection(environment.REDIS_URL);
    const queue = createCommandQueue(redis);
    const commandQueuePolicy = {
      maximumAttempts: environment.WORKFLOW_COMMAND_MAX_ATTEMPTS,
      retryDelayMs: environment.WORKFLOW_COMMAND_RETRY_DELAY_MS,
      maximumRetryDelayMs: environment.WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS,
    } as const;
    const publisher = new BullCommandPublisher(queue, commandQueuePolicy);
    const modeAdapters = createModeAdapters(environment, databaseClient.db);
    await modeAdapters.adapters?.registry.assertReady?.();
    const handlers = composeWorkflowHandlers({
      environment,
      store: new PostgresWorkflowContextStore(databaseClient.db),
      ...modeAdapters,
    });
    const processor = new DurableCommandProcessor(
      new PostgresCommandPersistence(databaseClient.db),
      handlers,
      (event) => Logger.log(JSON.stringify(event), 'Workflow'),
      environment.DEBTSHIFT_MODE,
    );
    const worker = createCommandWorker(redis, processor, commandQueuePolicy);

    worker.on('failed', (job, error) => {
      Logger.warn(
        `Command job ${job?.id ?? 'unknown'} failed and will follow queue retry policy: ${error.message}`,
        'CommandWorker',
      );
    });
    worker.on('error', (error) => Logger.error(error.message, error.stack, 'CommandWorker'));

    const recovered = await recoverStaleCommands(
      databaseClient.db,
      new Date(Date.now() - environment.WORKFLOW_COMMAND_STALE_AFTER_MS),
    );
    let closing = false;
    let activePublication: Promise<void> = Promise.resolve();
    let activeAlertScan: Promise<void> = Promise.resolve();
    const publish = (): void => {
      if (closing) return;
      activePublication = activePublication
        .then(async () => {
          const count = await publishPendingOutbox(databaseClient.db, publisher.publish);
          if (count > 0) Logger.debug(`Published ${count} durable command(s).`, 'Outbox');
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Unknown outbox failure';
          Logger.error(message, undefined, 'Outbox');
        });
    };
    publish();
    const outboxTimer = setInterval(publish, 250);
    const scanAlerts = (): void => {
      if (closing) return;
      activeAlertScan = activeAlertScan
        .then(async () => {
          const report = await scanOperationalAlerts(
            databaseClient.db,
            {
              deadlineLeadMs: environment.ALERT_DEADLINE_LEAD_MS,
              staleMigrationMs: environment.ALERT_STALE_MIGRATION_MS,
              staleRecoveryMs: environment.ALERT_STALE_RECOVERY_MS,
            },
            new Date(),
          );
          if (report.openedCount > 0 || report.resolvedCount > 0) {
            Logger.warn(
              JSON.stringify({
                event: 'operational_alert_scan',
                openedCount: report.openedCount,
                resolvedCount: report.resolvedCount,
                active: report.active.map((alert) => ({
                  alertId: alert.alertId,
                  migrationId: alert.migrationId,
                  type: alert.type,
                  severity: alert.severity,
                  message: alert.message,
                })),
              }),
              'OperationalAlerts',
            );
          }
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Unknown operational alert failure';
          Logger.error(message, undefined, 'OperationalAlerts');
        });
    };
    scanAlerts();
    const alertTimer = setInterval(scanAlerts, environment.ALERT_SCAN_INTERVAL_MS);

    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      clearInterval(outboxTimer);
      clearInterval(alertTimer);
      Logger.log(`Received ${signal}; draining the command worker.`, 'Bootstrap');
      await activePublication;
      await activeAlertScan;
      await worker.close();
      await queue.close();
      await databaseClient.close();
      await tracing.shutdown();
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    Logger.log(
      `DebtShift worker ready in ${environment.DEBTSHIFT_MODE}; recovered ${recovered} stale command(s).`,
      'Bootstrap',
    );
  } catch (error) {
    await tracing.shutdown();
    throw error;
  }
}

function createModeAdapters(
  environment: ReturnType<typeof parseDebtShiftEnvironment>,
  database: DebtShiftDatabase,
): {
  readonly adapters?: WorkflowAdapterSet;
} {
  if (environment.DEBTSHIFT_MODE === 'sandbox') {
    const simulator = new DeterministicTransportSimulator({
      outcome: environment.SIMULATOR_TERMINAL_OUTCOME,
      processingPolls: environment.SIMULATOR_PROCESSING_POLLS,
    });
    return {
      adapters: {
        mode: 'sandbox',
        execution: new DualAnvilSandboxExecutionPort(environment),
        transport: new SimulatedTransportExecutionPort(simulator),
        registry: hasNearRegistryConfiguration(environment)
          ? nearRegistry(environment, database)
          : new PendingSandboxRegistryPort(),
        evidenceProviders: sandboxEvidenceProviders,
      },
    };
  }
  if (
    environment.DEBTSHIFT_MODE === 'mainnet-readonly' ||
    (environment.DEBTSHIFT_MODE === 'mainnet' && !environment.MAINNET_EXECUTION_ENABLED)
  ) {
    return {};
  }
  if (environment.DEBTSHIFT_MODE === 'testnet') {
    const simulator = new DeterministicTransportSimulator({
      outcome: environment.SIMULATOR_TERMINAL_OUTCOME,
      processingPolls: environment.SIMULATOR_PROCESSING_POLLS,
    });
    return {
      adapters: {
        mode: 'testnet',
        execution: new ProductionEvmExecutionPort(environment),
        transport: new FundedTestnetTransportExecutionPort(environment, simulator),
        registry: nearRegistry(environment, database),
        evidenceProviders: productionEvidenceProviders,
      },
    };
  }
  return {
    adapters: {
      mode: 'mainnet',
      execution: new ProductionEvmExecutionPort(environment),
      transport: new OneClickTransportExecutionPort(
        new OneClickCommittedClient(oneClickClientConfiguration(environment)),
        new PostgresOneClickObservationStore(database),
      ),
      registry: nearRegistry(environment, database),
      evidenceProviders: productionEvidenceProviders,
    },
  };
}

const productionEvidenceProviders = Object.freeze({
  financing: 'DEBTSHIFT_RISK_VALIDATOR',
  liquidity: 'DEBTSHIFT_LIQUIDITY_VAULT',
  source: 'AAVE_V3_SOURCE_ADAPTER',
  target: 'MORPHO_BLUE_DESTINATION_ADAPTER',
  ledger: 'DEBTSHIFT_LEDGER',
  recovery: 'DEBTSHIFT_RECOVERY',
});

function nearRegistry(
  environment: DebtShiftEnvironment,
  database: DebtShiftDatabase,
): NearReceiptRegistryPort {
  return new NearReceiptRegistryPort({
    environment,
    loadActiveFinalizedEvidence: (migrationId) =>
      listActiveFinalizedEvidence(database, migrationId),
  });
}

function hasNearRegistryConfiguration(environment: DebtShiftEnvironment): boolean {
  return (
    environment.NEAR_REGISTRY_ACCOUNT.length !== 0 &&
    environment.NEAR_REGISTRY_OWNER_ACCOUNT.length !== 0 &&
    environment.NEAR_REGISTRY_WASM_SHA256.length !== 0 &&
    environment.NEAR_SIGNER_ACCOUNT_ID.length !== 0 &&
    environment.NEAR_SIGNER_PRIVATE_KEY.length !== 0
  );
}

function oneClickClientConfiguration(environment: DebtShiftEnvironment): OneClickClientConfig {
  return {
    baseUrl: environment.INTENTS_BASE_URL,
    authToken: environment.INTENTS_AUTH_TOKEN,
    requestTimeoutMs: environment.INTENTS_REQUEST_TIMEOUT_MS,
    responseLimitBytes: environment.INTENTS_RESPONSE_LIMIT_BYTES,
    catalogCacheTtlMs: environment.INTENTS_CATALOG_CACHE_TTL_MS,
    resilience: {
      maximumAttempts: environment.INTENTS_MAX_ATTEMPTS,
      baseRetryDelayMs: environment.INTENTS_RETRY_BASE_DELAY_MS,
      maximumRetryDelayMs: environment.INTENTS_RETRY_MAX_DELAY_MS,
      circuitFailureThreshold: environment.INTENTS_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: environment.INTENTS_CIRCUIT_RESET_MS,
      rateLimitCapacity: environment.INTENTS_RATE_LIMIT_CAPACITY,
      rateLimitWindowMs: environment.INTENTS_RATE_LIMIT_WINDOW_MS,
      maximumCacheEntries: environment.INTENTS_CACHE_MAX_ENTRIES,
    },
  };
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);
  const databasePath = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: parsed.port.length === 0 ? 6379 : Number(parsed.port),
    ...(parsed.username.length === 0 ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password.length === 0 ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(databasePath.length === 0 ? {} : { db: Number(databasePath) }),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

function loadLocalEnvironment(): void {
  const environmentPath = resolve(process.env.INIT_CWD ?? process.cwd(), '.env');
  if (existsSync(environmentPath)) loadEnvFile(environmentPath);
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown worker bootstrap failure';
  const stack = error instanceof Error ? error.stack : undefined;
  Logger.error(message, stack, 'Bootstrap');
  process.exitCode = 1;
});

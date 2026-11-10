import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

import {
  createDebtShiftDatabaseFromUrl,
  publishPendingOutbox,
  recoverStaleCommands,
} from '@debtshift/database';
import { parseDebtShiftEnvironment } from '@debtshift/domain';
import { DeterministicTransportSimulator } from '@debtshift/intents';
import { Logger } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';

import { createSimulatedWorkflowHandlers, PostgresWorkflowContextStore } from './handlers.js';
import { DualAnvilSimulationExecutionPort } from './simulator/dual-anvil-execution.js';
import { DurableCommandProcessor, PostgresCommandPersistence } from './processor.js';
import { BullCommandPublisher, createCommandQueue, createCommandWorker } from './queue.js';

async function bootstrap(): Promise<void> {
  loadLocalEnvironment();
  const environment = parseDebtShiftEnvironment(process.env);
  const databaseClient = createDebtShiftDatabaseFromUrl(environment.DATABASE_URL);
  await databaseClient.pool.query('select 1');

  const redis = redisConnection(environment.REDIS_URL);
  const queue = createCommandQueue(redis);
  const publisher = new BullCommandPublisher(queue);
  const simulator = new DeterministicTransportSimulator({
    outcome: environment.SIMULATOR_TERMINAL_OUTCOME,
    processingPolls: environment.SIMULATOR_PROCESSING_POLLS,
  });
  const execution = new DualAnvilSimulationExecutionPort(environment);
  const handlers = createSimulatedWorkflowHandlers(
    new PostgresWorkflowContextStore(databaseClient.db),
    execution,
    simulator,
  );
  const processor = new DurableCommandProcessor(
    new PostgresCommandPersistence(databaseClient.db),
    handlers,
  );
  const worker = createCommandWorker(redis, processor);

  worker.on('failed', (job, error) => {
    Logger.warn(
      `Command job ${job?.id ?? 'unknown'} failed and will follow queue retry policy: ${error.message}`,
      'CommandWorker',
    );
  });
  worker.on('error', (error) => Logger.error(error.message, error.stack, 'CommandWorker'));

  const recovered = await recoverStaleCommands(
    databaseClient.db,
    new Date(Date.now() - 5 * 60 * 1000),
  );
  let closing = false;
  let activePublication: Promise<void> = Promise.resolve();
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

  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(outboxTimer);
    Logger.log(`Received ${signal}; draining the command worker.`, 'Bootstrap');
    await activePublication;
    await worker.close();
    await queue.close();
    await databaseClient.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  Logger.log(
    `DebtShift worker ready in ${environment.DEBTSHIFT_ENV}; recovered ${recovered} stale command(s).`,
    'Bootstrap',
  );
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

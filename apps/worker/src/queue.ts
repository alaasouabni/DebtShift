import type { OutboxEnvelope, OutboxPublisher } from '@debtshift/database';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, JobsOptions } from 'bullmq';

import type { DurableCommandProcessor } from './processor.js';

export const COMMAND_QUEUE_NAME = 'debtshift-commands-v1';

export interface CommandQueuePolicy {
  readonly maximumAttempts: number;
  readonly retryDelayMs: number;
  readonly maximumRetryDelayMs: number;
}

const defaultCommandQueuePolicy: CommandQueuePolicy = Object.freeze({
  maximumAttempts: 25,
  retryDelayMs: 500,
  maximumRetryDelayMs: 30_000,
});

export class BullCommandPublisher {
  readonly publish: OutboxPublisher;

  constructor(
    private readonly queue: Queue<OutboxEnvelope>,
    policy: CommandQueuePolicy = defaultCommandQueuePolicy,
  ) {
    const jobOptions = commandJobOptions(policy);
    this.publish = async (message) => {
      await this.queue.add(message.topic, message, {
        ...jobOptions,
        jobId: message.commandId,
      });
    };
  }
}

export function commandJobOptions(policy: CommandQueuePolicy): JobsOptions {
  if (!Number.isInteger(policy.maximumAttempts) || policy.maximumAttempts < 1) {
    throw new Error('Command maximum attempts must be a positive integer.');
  }
  if (!Number.isInteger(policy.retryDelayMs) || policy.retryDelayMs < 100) {
    throw new Error('Command retry delay must be an integer of at least 100 milliseconds.');
  }
  if (
    !Number.isInteger(policy.maximumRetryDelayMs) ||
    policy.maximumRetryDelayMs < policy.retryDelayMs
  ) {
    throw new Error(
      'Command maximum retry delay must be an integer at least as large as its base.',
    );
  }
  return {
    attempts: policy.maximumAttempts,
    backoff: { type: 'custom', delay: policy.retryDelayMs },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 604_800, count: 25_000 },
  };
}

export function commandRetryDelay(policy: CommandQueuePolicy, attemptsMade: number): number {
  commandJobOptions(policy);
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new Error('Command attempts made must be a positive integer.');
  }
  return Math.min(policy.maximumRetryDelayMs, policy.retryDelayMs * 2 ** (attemptsMade - 1));
}

export function createCommandQueue(connection: ConnectionOptions): Queue<OutboxEnvelope> {
  return new Queue<OutboxEnvelope>(COMMAND_QUEUE_NAME, { connection });
}

export function createCommandWorker(
  connection: ConnectionOptions,
  processor: DurableCommandProcessor,
  policy: CommandQueuePolicy = defaultCommandQueuePolicy,
): Worker<OutboxEnvelope> {
  commandJobOptions(policy);
  return new Worker<OutboxEnvelope>(
    COMMAND_QUEUE_NAME,
    async (job) => processor.process(job.data),
    {
      connection,
      concurrency: 4,
      settings: { backoffStrategy: (attemptsMade) => commandRetryDelay(policy, attemptsMade) },
    },
  );
}

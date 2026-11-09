import type { OutboxEnvelope, OutboxPublisher } from '@debtshift/database';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, JobsOptions } from 'bullmq';

import type { DurableCommandProcessor } from './processor.js';

export const COMMAND_QUEUE_NAME = 'debtshift-commands-v1';

const jobOptions: JobsOptions = {
  attempts: 25,
  backoff: { type: 'exponential', delay: 500 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800, count: 25_000 },
};

export class BullCommandPublisher {
  readonly publish: OutboxPublisher;

  constructor(private readonly queue: Queue<OutboxEnvelope>) {
    this.publish = async (message) => {
      await this.queue.add(message.topic, message, {
        ...jobOptions,
        jobId: message.commandId,
      });
    };
  }
}

export function createCommandQueue(connection: ConnectionOptions): Queue<OutboxEnvelope> {
  return new Queue<OutboxEnvelope>(COMMAND_QUEUE_NAME, { connection });
}

export function createCommandWorker(
  connection: ConnectionOptions,
  processor: DurableCommandProcessor,
): Worker<OutboxEnvelope> {
  return new Worker<OutboxEnvelope>(
    COMMAND_QUEUE_NAME,
    async (job) => processor.process(job.data),
    { connection, concurrency: 4 },
  );
}

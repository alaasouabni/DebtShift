import type { OutboxEnvelope } from '@debtshift/database';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { BullCommandPublisher, commandJobOptions, commandRetryDelay } from './queue.js';

describe('durable command queue policy', () => {
  it('publishes every command with the configured bounded exponential retry budget', async () => {
    const add = vi.fn(async () => undefined);
    const publisher = new BullCommandPublisher({ add } as unknown as Queue<OutboxEnvelope>, {
      maximumAttempts: 12,
      retryDelayMs: 750,
      maximumRetryDelayMs: 15_000,
    });
    const message: OutboxEnvelope = {
      outboxId: '00000000-0000-0000-0000-000000000001',
      commandId: `0x${'11'.repeat(32)}`,
      topic: 'debtshift.commands.v1',
      partitionKey: `0x${'22'.repeat(32)}`,
      payload: { migrationId: `0x${'22'.repeat(32)}` },
    };

    await publisher.publish(message);

    expect(add).toHaveBeenCalledWith(
      message.topic,
      message,
      expect.objectContaining({
        jobId: message.commandId,
        attempts: 12,
        backoff: { type: 'custom', delay: 750 },
      }),
    );
  });

  it('rejects unbounded or busy-loop retry policies', () => {
    expect(() =>
      commandJobOptions({
        maximumAttempts: 0,
        retryDelayMs: 500,
        maximumRetryDelayMs: 30_000,
      }),
    ).toThrow('positive integer');
    expect(() =>
      commandJobOptions({ maximumAttempts: 1, retryDelayMs: 99, maximumRetryDelayMs: 30_000 }),
    ).toThrow('at least 100 milliseconds');
    expect(() =>
      commandJobOptions({
        maximumAttempts: 1,
        retryDelayMs: 1_000,
        maximumRetryDelayMs: 999,
      }),
    ).toThrow('at least as large as its base');
  });

  it('caps exponential delay so a retry cannot disappear beyond the custody window', () => {
    const policy = { maximumAttempts: 25, retryDelayMs: 500, maximumRetryDelayMs: 30_000 };
    expect(commandRetryDelay(policy, 1)).toBe(500);
    expect(commandRetryDelay(policy, 6)).toBe(16_000);
    expect(commandRetryDelay(policy, 7)).toBe(30_000);
    expect(commandRetryDelay(policy, 25)).toBe(30_000);
  });
});

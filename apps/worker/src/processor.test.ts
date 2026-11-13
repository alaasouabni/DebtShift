import type { DurableCommand, OutboxEnvelope } from '@debtshift/database';
import type { Evidence, EvidenceType } from '@debtshift/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  DurableCommandProcessor,
  RetryableCommandError,
  type CommandPersistence,
} from './processor.js';

const MIGRATION_ID = `0x${'11'.repeat(32)}` as const;
const COMMAND_ID = `0x${'22'.repeat(32)}` as const;

function command(type = 'RESERVE_LIQUIDITY'): DurableCommand {
  const now = new Date('2026-11-09T00:00:00.000Z');
  return {
    commandId: COMMAND_ID,
    migrationId: MIGRATION_ID,
    type,
    idempotencyKey: `reserve:${MIGRATION_ID}`,
    status: 'DISPATCHED',
    logicalAttempt: 0,
    payload: { migrationId: MIGRATION_ID },
    payloadHash: `0x${'33'.repeat(32)}` as const,
    lastError: null,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function evidence(type: EvidenceType): Evidence {
  return {
    evidenceId: `0x${'44'.repeat(32)}` as const,
    migrationId: MIGRATION_ID,
    type,
    schemaVersion: 1,
    provider: 'TEST',
    network: 'anvil:31337',
    rawObservationHash: `0x${'55'.repeat(32)}` as const,
    normalizedPayload: {},
    observedAt: '2026-11-09T00:00:00.000Z',
    verificationState: 'FINALIZED',
    verificationMethod: 'TEST',
    verifierVersion: '1',
  };
}

function envelope(): OutboxEnvelope {
  return {
    outboxId: '00000000-0000-0000-0000-000000000001',
    commandId: COMMAND_ID,
    topic: 'debtshift.commands.v1',
    partitionKey: MIGRATION_ID,
    payload: { commandId: COMMAND_ID },
  };
}

function persistence(overrides: Partial<CommandPersistence> = {}): CommandPersistence {
  return {
    begin: vi.fn(async () => command()),
    hasEvidence: vi.fn(async () => false),
    advance: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('durable command processor', () => {
  it('executes, advances evidence, and completes one command', async () => {
    const store = persistence();
    const execute = vi.fn(async () => [evidence('LIQUIDITY_RESERVATION')]);
    const processor = new DurableCommandProcessor(
      store,
      new Map([['RESERVE_LIQUIDITY', { execute }]]),
    );

    await processor.process(envelope());
    expect(execute).toHaveBeenCalledOnce();
    expect(store.advance).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledWith(COMMAND_ID);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('checks evidence before side effects on duplicate delivery', async () => {
    const store = persistence({ hasEvidence: vi.fn(async () => true) });
    const execute = vi.fn(async () => [evidence('LIQUIDITY_RESERVATION')]);
    const processor = new DurableCommandProcessor(
      store,
      new Map([['RESERVE_LIQUIDITY', { execute }]]),
    );

    await processor.process(envelope());
    expect(execute).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledOnce();
  });

  it('marks retryable failures and rethrows for queue backoff', async () => {
    const store = persistence();
    const error = new RetryableCommandError('RPC unavailable');
    const processor = new DurableCommandProcessor(
      store,
      new Map([['RESERVE_LIQUIDITY', { execute: vi.fn(async () => Promise.reject(error)) }]]),
    );

    await expect(processor.process(envelope())).rejects.toThrow('RPC unavailable');
    expect(store.fail).toHaveBeenCalledWith(COMMAND_ID, error, true);
  });

  it('persists retry exhaustion terminally on the final queue attempt', async () => {
    const store = persistence();
    const error = new RetryableCommandError('RPC unavailable');
    const processor = new DurableCommandProcessor(
      store,
      new Map([['RESERVE_LIQUIDITY', { execute: vi.fn(async () => Promise.reject(error)) }]]),
    );

    await expect(processor.process(envelope(), true)).resolves.toBeUndefined();
    expect(store.fail).toHaveBeenCalledWith(COMMAND_ID, error, false);
  });

  it('persists recovery evidence before terminally closing an exhausted financial command', async () => {
    const store = persistence({ begin: vi.fn(async () => command('SETTLE_LIQUIDITY')) });
    const error = new RetryableCommandError('Settlement confirmation unavailable');
    const recovery = evidence('RECOVERY_OPENED');
    const onRetryExhausted = vi.fn(async () => [recovery]);
    const processor = new DurableCommandProcessor(
      store,
      new Map([
        [
          'SETTLE_LIQUIDITY',
          { execute: vi.fn(async () => Promise.reject(error)), onRetryExhausted },
        ],
      ]),
    );

    await processor.process(envelope(), true);

    expect(onRetryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SETTLE_LIQUIDITY' }),
      error,
    );
    expect(store.advance).toHaveBeenCalledWith(recovery);
    expect(store.fail).toHaveBeenCalledWith(COMMAND_ID, error, false);
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('fails terminally when a handler violates its evidence contract', async () => {
    const store = persistence();
    const processor = new DurableCommandProcessor(
      store,
      new Map([['RESERVE_LIQUIDITY', { execute: vi.fn(async () => []) }]]),
    );

    await processor.process(envelope());
    expect(store.fail).toHaveBeenCalledWith(COMMAND_ID, expect.any(Error), false);
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('accepts requote-required as the terminal alternative to source-close evidence', async () => {
    const store = persistence({ begin: vi.fn(async () => command('CLOSE_SOURCE')) });
    const execute = vi.fn(async () => [evidence('REQUOTE_REQUIRED')]);
    const processor = new DurableCommandProcessor(store, new Map([['CLOSE_SOURCE', { execute }]]));

    await processor.process(envelope());

    expect(store.advance).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledWith(COMMAND_ID);
    expect(store.fail).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';

import { planNextCommand } from './workflow.js';

describe('workflow command planning', () => {
  const migrationId = `0x${'ab'.repeat(32)}`;

  it('uses stable logical idempotency keys for every forward action', () => {
    expect(planNextCommand(migrationId, 'AUTHORIZED')).toMatchObject({
      type: 'RESERVE_LIQUIDITY',
      idempotencyKey: `reserve:${migrationId}`,
    });
    expect(planNextCommand(migrationId, 'RESERVED')).toMatchObject({
      type: 'CLOSE_SOURCE',
      idempotencyKey: `source-close:${migrationId}`,
    });
    expect(planNextCommand(migrationId, 'SOURCE_CLOSED')).toMatchObject({
      type: 'DISPATCH_TRANSPORT',
      idempotencyKey: `route-deposit:${migrationId}`,
    });
    expect(planNextCommand(migrationId, 'DEST_FUNDED')).toMatchObject({
      type: 'OPEN_TARGET',
      idempotencyKey: `target-open:${migrationId}`,
    });
    expect(planNextCommand(migrationId, 'TARGET_OPEN')).toMatchObject({
      type: 'SETTLE_LIQUIDITY',
      idempotencyKey: `solver-settle:${migrationId}`,
    });
  });

  it('does not plan work after terminal phases', () => {
    expect(planNextCommand(migrationId, 'COMPLETED')).toBeUndefined();
    expect(planNextCommand(migrationId, 'FAILED_SAFE')).toBeUndefined();
    expect(planNextCommand(migrationId, 'REQUOTE_REQUIRED')).toBeUndefined();
    expect(planNextCommand(migrationId, 'EXPIRED')).toBeUndefined();
    expect(planNextCommand(migrationId, 'CANCELLED')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import {
  persistedSourceLendingAuthorizationSchema,
  preparedSourceLendingAuthorizationSchema,
  submittedSourceLendingAuthorizationSchema,
} from './source-authorization.js';

const TOKEN = '0x1000000000000000000000000000000000000001';
const SPENDER = '0x2000000000000000000000000000000000000002';
const DATA = `0x095ea7b3${'00'.repeat(64)}`;

describe('source lending authorization', () => {
  it('binds an exact ERC-20 approval transaction to its token, spender, chain, and amount', () => {
    expect(preparedSourceLendingAuthorizationSchema.parse(approval())).toEqual(approval());
  });

  it('rejects a transaction directed to a token other than the approved token', () => {
    expect(() =>
      preparedSourceLendingAuthorizationSchema.parse({
        ...approval(),
        transaction: { ...approval().transaction, to: SPENDER },
      }),
    ).toThrow('authorized token');
  });

  it('persists the finalized approval receipt coordinates', () => {
    const authorization = submittedSourceLendingAuthorizationSchema.parse({
      ...approval(),
      transactionHash: `0x${'aa'.repeat(32)}`,
    });
    expect(
      persistedSourceLendingAuthorizationSchema.parse({
        kind: 'ERC20_APPROVAL',
        authorization,
        blockNumber: '123',
        blockHash: `0x${'bb'.repeat(32)}`,
      }),
    ).toMatchObject({ kind: 'ERC20_APPROVAL', blockNumber: '123' });
  });
});

function approval() {
  return {
    kind: 'ERC20_APPROVAL' as const,
    chainId: 8453,
    token: TOKEN,
    spender: SPENDER,
    amountUnits: '1000000000000000000',
    transaction: { to: TOKEN, data: DATA, valueUnits: '0' as const },
  };
}

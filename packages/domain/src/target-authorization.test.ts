import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  getMorphoAuthorizationTypedData,
  persistedTargetLendingAuthorizationSchema,
  preparedTargetLendingAuthorizationSchema,
  signedTargetLendingAuthorizationSchema,
} from './target-authorization.js';

const account = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const MORPHO = '0x2000000000000000000000000000000000000001' as const;
const MODULE = '0x4000000000000000000000000000000000000005' as const;

function prepared() {
  return preparedTargetLendingAuthorizationSchema.parse({
    kind: 'MORPHO_BLUE',
    chainId: 42161,
    morpho: MORPHO,
    module: MODULE,
    enable: {
      authorizer: account.address,
      authorized: MODULE,
      isAuthorized: true,
      nonce: '7',
      deadline: '1800000000',
    },
    disable: {
      authorizer: account.address,
      authorized: MODULE,
      isAuthorized: false,
      nonce: '8',
      deadline: '1800000000',
    },
  });
}

describe('target lending authorization', () => {
  it('binds consecutive native Morpho enable and disable signatures', async () => {
    const authorization = prepared();
    if (authorization.kind !== 'MORPHO_BLUE') throw new Error('Expected Morpho authorization.');
    const [enableSignature, disableSignature] = await Promise.all([
      account.signTypedData(getMorphoAuthorizationTypedData(authorization, 'enable')),
      account.signTypedData(getMorphoAuthorizationTypedData(authorization, 'disable')),
    ]);

    expect(
      signedTargetLendingAuthorizationSchema.parse({
        ...authorization,
        enableSignature,
        disableSignature,
      }),
    ).toMatchObject({ kind: 'MORPHO_BLUE', chainId: 42161, module: MODULE });
  });

  it('rejects a non-consecutive or differently scoped authorization pair', () => {
    const authorization = prepared();
    if (authorization.kind !== 'MORPHO_BLUE') throw new Error('Expected Morpho authorization.');
    expect(() =>
      preparedTargetLendingAuthorizationSchema.parse({
        ...authorization,
        disable: { ...authorization.disable, nonce: '9' },
      }),
    ).toThrow('consecutive enable/disable pair');
    expect(() =>
      preparedTargetLendingAuthorizationSchema.parse({
        ...authorization,
        enable: {
          ...authorization.enable,
          authorized: '0x5000000000000000000000000000000000000005',
        },
      }),
    ).toThrow('consecutive enable/disable pair');
  });

  it('requires encoded bytes only for a signed Morpho authorization', () => {
    expect(
      persistedTargetLendingAuthorizationSchema.parse({
        authorization: { kind: 'NONE' },
        encodedAuthorization: '0x',
      }),
    ).toEqual({ authorization: { kind: 'NONE' }, encodedAuthorization: '0x' });
    expect(() =>
      persistedTargetLendingAuthorizationSchema.parse({
        authorization: { kind: 'NONE' },
        encodedAuthorization: '0x01',
      }),
    ).toThrow('does not match');
  });
});

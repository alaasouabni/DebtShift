import type { TokenReference } from '@debtshift/domain';
import { describe, expect, it } from 'vitest';

import { resolveOneClickAsset, verifyOneClickRouteAssets } from './catalog.js';
import type { OneClickToken } from './one-click.js';

const token: TokenReference = {
  chainId: 42_161,
  address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  decimals: 6,
  symbol: 'USDC',
  providerAssetId: 'nep141:arb-usdc.omft.near',
};

const catalogToken: OneClickToken = {
  assetId: token.providerAssetId ?? '',
  decimals: 6,
  blockchain: 'arb',
  symbol: 'USDC',
  price: 1,
  priceUpdatedAt: '2026-11-14T12:00:00.000Z',
  contractAddress: token.address,
};

describe('1Click catalog asset resolution', () => {
  it('requires one exact asset ID, address, and decimal match', () => {
    expect(resolveOneClickAsset([catalogToken], token)).toMatchObject({
      assetId: token.providerAssetId,
      contractAddress: token.address,
      decimals: 6,
    });
  });

  it('rejects symbol-only or mismatched-address rows', () => {
    expect(() =>
      resolveOneClickAsset(
        [{ ...catalogToken, contractAddress: '0x0000000000000000000000000000000000000001' }],
        token,
      ),
    ).toThrow('does not match');
    expect(() => resolveOneClickAsset([{ ...catalogToken, assetId: 'different' }], token)).toThrow(
      'exactly one row',
    );
  });

  it('rejects duplicate route identities', () => {
    expect(() => verifyOneClickRouteAssets([catalogToken], [token, token])).toThrow(
      'duplicate asset identity',
    );
  });
});

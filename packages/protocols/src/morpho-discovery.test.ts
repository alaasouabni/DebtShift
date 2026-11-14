import { describe, expect, it, vi } from 'vitest';

import { MorphoMarketDiscoveryClient } from './morpho-discovery.js';

const LOAN = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const COLLATERAL = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const ORACLE = '0x282FEB10549fde52bD61A6979424Ddf18A4971A2';
const IRM = '0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA';
const MARKET_A = `0x${'11'.repeat(32)}`;
const MARKET_B = `0x${'22'.repeat(32)}`;

describe('MorphoMarketDiscoveryClient', () => {
  it('paginates, validates the requested boundary, and sorts markets deterministically', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([market(MARKET_B)], 'next'))
      .mockResolvedValueOnce(response([market(MARKET_A)], null));
    const client = testClient(fetcher);

    const result = await client.discoverMarkets({
      chainId: 42_161,
      loanToken: LOAN,
      collateralToken: COLLATERAL,
    });

    expect(result.pages).toBe(2);
    expect(result.markets.map(({ marketId }) => marketId)).toEqual([MARKET_A, MARKET_B]);
    expect(result.responseHashes).toHaveLength(2);
    const secondUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get('cursor')).toBe('next');
    expect(secondUrl.searchParams.get('loan_token')).toBe(`42161:${LOAN}`);
    expect(secondUrl.searchParams.get('collateral_token')).toBe(COLLATERAL);
  });

  it('rejects a provider row outside the exact requested tokens', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        [
          {
            ...market(MARKET_A),
            collateral_token: '0x0000000000000000000000000000000000000001',
          },
        ],
        null,
      ),
    );
    await expect(
      testClient(fetcher).discoverMarkets({
        chainId: 42_161,
        loanToken: LOAN,
        collateralToken: COLLATERAL,
      }),
    ).rejects.toThrow('outside the requested asset boundary');
  });

  it('rejects repeated cursors instead of looping', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([], 'same'))
      .mockResolvedValueOnce(response([], 'same'));
    await expect(
      testClient(fetcher).discoverMarkets({
        chainId: 42_161,
        loanToken: LOAN,
        collateralToken: COLLATERAL,
      }),
    ).rejects.toThrow('repeated pagination cursor');
  });

  it('rejects malformed market identities', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ ...market(MARKET_A), market_id: 'not-a-market' }], null));
    await expect(
      testClient(fetcher).discoverMarkets({
        chainId: 42_161,
        loanToken: LOAN,
        collateralToken: COLLATERAL,
      }),
    ).rejects.toThrow();
  });
});

function testClient(fetcher: typeof fetch): MorphoMarketDiscoveryClient {
  return new MorphoMarketDiscoveryClient({
    baseUrl: 'http://morpho.test',
    allowTestEndpoint: true,
    fetchImplementation: fetcher,
    now: () => new Date('2026-11-14T12:00:00.000Z'),
    pageSize: 2,
  });
}

function market(marketId: string) {
  return {
    chain_id: 42_161,
    market_id: marketId,
    loan_token: LOAN,
    collateral_token: COLLATERAL,
    oracle_address: ORACLE,
    irm_address: IRM,
    lltv_wad: '860000000000000000',
    creation_block_number: '358435191',
    creation_timestamp: 1_750_000_000,
  };
}

function response(data: readonly unknown[], cursor: string | null): Response {
  return new Response(JSON.stringify({ data, cursor }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

import type { TokenReference } from '@debtshift/domain';
import { describe, expect, it, vi } from 'vitest';

import { OneClickReadOnlyClient } from './one-click.js';

const SOURCE: TokenReference = {
  chainId: 8453,
  address: '0x1000000000000000000000000000000000000001',
  decimals: 6,
  symbol: 'USDC',
  providerAssetId: 'nep141:base-usdc.omft.near',
};
const DESTINATION: TokenReference = {
  chainId: 42161,
  address: '0x2000000000000000000000000000000000000002',
  decimals: 6,
  symbol: 'USDC',
  providerAssetId: 'nep141:arb-usdc.omft.near',
};

describe('OneClickReadOnlyClient', () => {
  it('pins production reads to the official origin', () => {
    expect(
      () =>
        new OneClickReadOnlyClient({
          baseUrl: 'https://attacker.example',
          authToken: 'secret',
        }),
    ).toThrow('official production origin');
  });

  it('maps a schema-validated dry quote without exposing a committed method', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        dry: true,
        swapType: 'EXACT_INPUT',
        originAsset: SOURCE.providerAssetId,
        destinationAsset: DESTINATION.providerAssetId,
        amount: '1000000',
      });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return new Response(
        JSON.stringify({
          correlationId: 'dry-quote-1',
          timestamp: '2026-11-10T12:00:00.000Z',
          signature: 'provider-signature',
          quoteRequest: body,
          quote: {
            amountIn: '1000000',
            amountInFormatted: '1',
            amountInUsd: '1',
            minAmountIn: '1000000',
            amountOut: '998000',
            amountOutFormatted: '0.998',
            amountOutUsd: '0.998',
            minAmountOut: '993010',
            timeEstimate: 15,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new OneClickReadOnlyClient({
      baseUrl: 'https://oneclick.test',
      authToken: 'secret',
      allowTestEndpoint: true,
      fetchImplementation: fetchImplementation as typeof fetch,
      signatureVerifier: () => true,
    });
    const quote = await client.getDryQuote({
      inputAsset: SOURCE,
      outputAsset: DESTINATION,
      amountUnits: '1000000',
      amountKind: 'EXACT_INPUT',
      maxSlippageBps: 50,
      destinationReceiver: '0x3000000000000000000000000000000000000003',
      refundReceiver: '0x4000000000000000000000000000000000000004',
      deadline: '2099-11-10T12:05:00.000Z',
    });

    expect(quote).toMatchObject({
      provider: 'NEAR_INTENTS_1CLICK',
      mode: 'DRY',
      amountInUnits: '1000000',
      expectedAmountOutUnits: '998000',
      minAmountOutUnits: '993010',
    });
    expect(quote.depositAddress).toBeUndefined();
    expect('getCommittedQuote' in client).toBe(false);
  });

  it('requires authentication for quote requests', async () => {
    const client = new OneClickReadOnlyClient({
      baseUrl: 'https://oneclick.test',
      allowTestEndpoint: true,
      fetchImplementation: vi.fn() as unknown as typeof fetch,
    });
    await expect(
      client.getDryQuote({
        inputAsset: SOURCE,
        outputAsset: DESTINATION,
        amountUnits: '1',
        amountKind: 'EXACT_INPUT',
        maxSlippageBps: 0,
        destinationReceiver: 'receiver',
        refundReceiver: 'refund',
        deadline: '2099-11-10T12:05:00.000Z',
      }),
    ).rejects.toThrow('bearer token');
  });

  it('caches and coalesces the public token catalog for its configured TTL', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              assetId: SOURCE.providerAssetId,
              decimals: SOURCE.decimals,
              blockchain: 'base',
              symbol: SOURCE.symbol,
              price: 1,
              priceUpdatedAt: '2026-11-10T12:00:00.000Z',
              contractAddress: SOURCE.address,
            },
          ]),
          { status: 200 },
        ),
      ),
    );
    const client = new OneClickReadOnlyClient({
      baseUrl: 'https://oneclick.test',
      allowTestEndpoint: true,
      catalogCacheTtlMs: 60_000,
      fetchImplementation: fetchImplementation as typeof fetch,
    });

    const [first, concurrent] = await Promise.all([
      client.getTokenCatalog(),
      client.getTokenCatalog(),
    ]);
    const cached = await client.getTokenCatalog();
    expect(first).toEqual(concurrent);
    expect(cached).toEqual(first);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('retries transient HTTP failures but not an invalid request response', async () => {
    let attempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      attempts += 1;
      if (attempts === 1) return new Response('{}', { status: 503 });
      const quoteRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          correlationId: 'dry-quote-retry',
          timestamp: '2026-11-10T12:00:00.000Z',
          signature: 'provider-signature',
          quoteRequest,
          quote: {
            amountIn: '1000000',
            amountInFormatted: '1',
            amountInUsd: '1',
            minAmountIn: '1000000',
            amountOut: '998000',
            amountOutFormatted: '0.998',
            amountOutUsd: '0.998',
            minAmountOut: '993010',
          },
        }),
        { status: 200 },
      );
    });
    const client = new OneClickReadOnlyClient({
      baseUrl: 'https://oneclick.test',
      authToken: 'secret',
      allowTestEndpoint: true,
      resilience: { baseRetryDelayMs: 1, maximumRetryDelayMs: 1 },
      fetchImplementation,
      signatureVerifier: () => true,
    });
    await expect(
      client.getDryQuote({
        inputAsset: SOURCE,
        outputAsset: DESTINATION,
        amountUnits: '1000000',
        amountKind: 'EXACT_INPUT',
        maxSlippageBps: 50,
        destinationReceiver: 'receiver',
        refundReceiver: 'refund',
        deadline: '2099-11-10T12:05:00.000Z',
      }),
    ).resolves.toMatchObject({ expectedAmountOutUnits: '998000' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    const invalidFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 400 }));
    const invalidClient = new OneClickReadOnlyClient({
      baseUrl: 'https://oneclick.test',
      authToken: 'secret',
      allowTestEndpoint: true,
      resilience: { baseRetryDelayMs: 1, maximumRetryDelayMs: 1 },
      fetchImplementation: invalidFetch,
    });
    await expect(
      invalidClient.getDryQuote({
        inputAsset: SOURCE,
        outputAsset: DESTINATION,
        amountUnits: '1000000',
        amountKind: 'EXACT_INPUT',
        maxSlippageBps: 50,
        destinationReceiver: 'receiver',
        refundReceiver: 'refund',
        deadline: '2099-11-10T12:05:00.000Z',
      }),
    ).rejects.toThrow('HTTP 400');
    expect(invalidFetch).toHaveBeenCalledTimes(1);
  });
});

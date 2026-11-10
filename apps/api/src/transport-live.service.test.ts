import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from './database.service.js';
import { TransportService } from './transport.service.js';

const storeProviderObservation = vi.hoisted(() =>
  vi.fn<(database: unknown, observation: unknown) => Promise<string>>(
    async () => `0x${'ab'.repeat(32)}`,
  ),
);

vi.mock('@debtshift/database', () => ({
  createDebtShiftDatabaseFromUrl: vi.fn(),
  storeAssetCatalogVersion: vi.fn(),
  storeProviderObservation,
}));

const source = {
  chainId: 8453,
  address: '0x1000000000000000000000000000000000000001',
  decimals: 6,
  symbol: 'USDC',
  providerAssetId: 'nep141:base-usdc.omft.near',
} as const;
const destination = {
  chainId: 42161,
  address: '0x2000000000000000000000000000000000000002',
  decimals: 6,
  symbol: 'USDC',
  providerAssetId: 'nep141:arb-usdc.omft.near',
} as const;

describe('live transport observation persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    storeProviderObservation.mockClear();
  });

  it('stores the exact credential-free 1Click request and response before returning the quote', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          timestamp: '2026-11-10T12:00:00.000Z',
          signature: 'provider-signature',
          quoteRequest: request,
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
    vi.stubGlobal('fetch', fetchImplementation);
    const config = new ConfigService({
      TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
      INTENTS_BASE_URL: 'https://1click.chaindefuser.com',
      INTENTS_AUTH_TOKEN: 'provider-secret',
    });
    const database = { db: { marker: 'database' } } as unknown as DatabaseService;
    const service = new TransportService(config, database);

    const quote = await service.getOneClickDryQuote({
      inputAsset: source,
      outputAsset: destination,
      amountUnits: '1000000',
      amountKind: 'EXACT_INPUT',
      maxSlippageBps: 50,
      destinationReceiver: 'receiver.near',
      refundReceiver: '0x3000000000000000000000000000000000000003',
      deadline: '2099-11-10T12:05:00.000Z',
    });

    expect(quote).toMatchObject({ provider: 'NEAR_INTENTS_1CLICK', mode: 'DRY' });
    expect(storeProviderObservation).toHaveBeenCalledOnce();
    const storedCall = storeProviderObservation.mock.calls[0];
    if (storedCall === undefined) throw new Error('Expected a stored provider observation.');
    const [storedDatabase, observation] = storedCall;
    expect(storedDatabase).toBe(database.db);
    expect(observation).toMatchObject({
      provider: 'NEAR_INTENTS_1CLICK',
      operation: 'DRY_QUOTE',
      correlationId: '2026-11-10T12:00:00.000Z',
      requestPayload: { dry: true, amount: '1000000' },
      responsePayload: { signature: 'provider-signature' },
    });
    expect(JSON.stringify(observation)).not.toContain('provider-secret');
  });
});

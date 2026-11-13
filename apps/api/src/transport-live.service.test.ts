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

vi.mock('@defuse-protocol/one-click-sdk-typescript', () => ({
  verifyQuoteSignature: vi.fn(() => true),
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
          correlationId: 'dry-quote-correlation',
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
      correlationId: 'dry-quote-correlation',
      requestPayload: { dry: true, amount: '1000000' },
      responsePayload: { signature: 'provider-signature' },
    });
    expect(JSON.stringify(observation)).not.toContain('provider-secret');
  });

  it('uses a persisted committed quote for the mainnet workflow without broadcasting funds', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request.dry).toBe(false);
      return new Response(
        JSON.stringify({
          correlationId: 'committed-quote-correlation',
          timestamp: '2026-11-10T12:00:00.000Z',
          signature: 'provider-signature',
          quoteRequest: request,
          quote: {
            depositAddress: '0x4000000000000000000000000000000000000004',
            amountIn: '1000000',
            amountInFormatted: '1',
            amountInUsd: '1',
            minAmountIn: '1000000',
            amountOut: '998000',
            amountOutFormatted: '0.998',
            amountOutUsd: '0.998',
            minAmountOut: '993010',
            deadline: request.deadline,
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchImplementation);
    const config = new ConfigService({
      DEBTSHIFT_MODE: 'mainnet',
      TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
      INTENTS_MODE: 'mainnet',
      MAINNET_EXECUTION_ENABLED: true,
      INTENTS_BASE_URL: 'https://1click.chaindefuser.com',
      INTENTS_AUTH_TOKEN: 'provider-secret',
    });
    const database = { db: { marker: 'database' } } as unknown as DatabaseService;
    const service = new TransportService(config, database);

    const quote = await service.getQuote({
      inputAsset: source,
      outputAsset: destination,
      amountInUnits: '1000000',
      maxSlippageBps: 50,
      destinationReceiver: '0x5000000000000000000000000000000000000005',
      refundReceiver: '0x6000000000000000000000000000000000000006',
    });

    expect(quote).toMatchObject({
      provider: 'NEAR_INTENTS_1CLICK',
      mode: 'COMMITTED',
      depositAddress: '0x4000000000000000000000000000000000000004',
    });
    expect(storeProviderObservation).toHaveBeenCalledWith(
      database.db,
      expect.objectContaining({
        operation: 'COMMITTED_QUOTE',
        correlationId: 'committed-quote-correlation',
        requestPayload: expect.objectContaining({ dry: false }),
      }),
    );
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('permits non-broadcast committed quote construction while mainnet writes are disabled', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          correlationId: 'disabled-write-quote',
          timestamp: '2026-11-10T12:00:00.000Z',
          signature: 'provider-signature',
          quoteRequest: request,
          quote: {
            depositAddress: '0x4000000000000000000000000000000000000004',
            amountIn: '1000000',
            amountInFormatted: '1',
            amountInUsd: '1',
            minAmountIn: '1000000',
            amountOut: '998000',
            amountOutFormatted: '0.998',
            amountOutUsd: '0.998',
            minAmountOut: '993010',
            deadline: request.deadline,
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchImplementation);
    const service = new TransportService(
      new ConfigService({
        DEBTSHIFT_MODE: 'mainnet',
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet',
        MAINNET_EXECUTION_ENABLED: false,
        INTENTS_BASE_URL: 'https://1click.chaindefuser.com',
        INTENTS_AUTH_TOKEN: 'provider-secret',
      }),
      { db: { marker: 'database' } } as unknown as DatabaseService,
    );

    await expect(
      service.getQuote({
        inputAsset: source,
        outputAsset: destination,
        amountInUnits: '1000000',
        maxSlippageBps: 50,
        destinationReceiver: '0x5000000000000000000000000000000000000005',
        refundReceiver: '0x6000000000000000000000000000000000000006',
      }),
    ).resolves.toMatchObject({ mode: 'COMMITTED' });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});

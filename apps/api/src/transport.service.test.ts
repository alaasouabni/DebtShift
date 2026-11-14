import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { TransportService } from './transport.service.js';

describe('transport quote API service', () => {
  it('returns an explicitly simulated, bounded quote', async () => {
    const service = new TransportService();
    const quote = await service.getQuote({
      inputAsset: {
        chainId: 31_337,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 18,
        symbol: 'sWETH',
      },
      outputAsset: {
        chainId: 31_338,
        address: '0x6000000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'dWETH',
      },
      amountInUnits: '10000000000000000000',
      maxSlippageBps: 50,
      destinationReceiver: '0x7000000000000000000000000000000000000007',
      refundReceiver: '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa',
    });

    expect(quote.provider).toBe('DEBTSHIFT_SIMULATOR');
    expect(quote.mode).toBe('SIMULATED');
    expect(BigInt(quote.minAmountOutUnits)).toBeLessThanOrEqual(
      BigInt(quote.expectedAmountOutUnits),
    );
    expect(quote.depositAddress).toMatch(/^simulator:/);
  });

  it('keeps a configured execution window inside the simulator quote lifetime', async () => {
    const before = Date.now();
    const service = new TransportService(
      new ConfigService({
        DEBTSHIFT_MODE: 'testnet',
        TRANSPORT_PROVIDER: 'DEBTSHIFT_SIMULATOR',
        EXECUTION_PLAN_TTL_SECONDS: 900,
      }),
    );
    const quote = await service.getQuote({
      inputAsset: {
        chainId: 11_155_111,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 18,
      },
      outputAsset: {
        chainId: 84_532,
        address: '0x6000000000000000000000000000000000000006',
        decimals: 18,
      },
      amountInUnits: '10000000000000000',
      maxSlippageBps: 50,
      destinationReceiver: '0x7000000000000000000000000000000000000007',
      refundReceiver: '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa',
    });

    const lifetimeMs = Date.parse(quote.expiresAt) - before;
    expect(lifetimeMs).toBeGreaterThanOrEqual(925_000);
    expect(lifetimeMs).toBeLessThanOrEqual(935_000);
  });

  it('rejects ambiguous decimal and negative transport amounts', async () => {
    const service = new TransportService();
    const base = {
      inputAsset: {
        chainId: 31_337,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 18,
      },
      outputAsset: {
        chainId: 31_338,
        address: '0x6000000000000000000000000000000000000006',
        decimals: 18,
      },
      maxSlippageBps: 50,
      destinationReceiver: '0x7000000000000000000000000000000000000007',
      refundReceiver: '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa',
    };
    expect(() => service.getQuote({ ...base, amountInUnits: '1.5' })).toThrow();
    expect(() => service.getQuote({ ...base, amountInUnits: '-1' })).toThrow();
  });

  it('uses explicitly simulated bid/ask analysis quotes in simulator mode', async () => {
    const service = new TransportService();
    const request = {
      inputAsset: {
        chainId: 11_155_111,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 6,
      },
      outputAsset: {
        chainId: 84_532,
        address: '0x6000000000000000000000000000000000000006',
        decimals: 6,
      },
      amountUnits: '5000000',
      maxSlippageBps: 50,
      destinationReceiver: '0x7000000000000000000000000000000000000007',
      refundReceiver: '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa',
      deadline: new Date(Date.now() + 300_000).toISOString(),
    } as const;

    const [exactInput, exactOutput] = await Promise.all([
      service.getAnalysisQuote({ ...request, amountKind: 'EXACT_INPUT' }),
      service.getAnalysisQuote({ ...request, amountKind: 'EXACT_OUTPUT' }),
    ]);

    expect(exactInput).toMatchObject({ provider: 'DEBTSHIFT_SIMULATOR', mode: 'SIMULATED' });
    expect(exactOutput).toMatchObject({ provider: 'DEBTSHIFT_SIMULATOR', mode: 'SIMULATED' });
    expect(exactInput.expectedAmountOutUnits).toBe(request.amountUnits);
    expect(exactOutput.amountInUnits).toBe(request.amountUnits);
    expect(exactOutput.expectedAmountOutUnits).toBe(request.amountUnits);
  });
});

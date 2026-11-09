import { describe, expect, it } from 'vitest';

import {
  DeterministicTransportSimulator,
  normalizeTransportStatus,
  transportQuoteRequestSchema,
  type TransportQuoteRequest,
  type TransportTerminalOutcome,
  verifyTransportDelivery,
  verifyTransportRefund,
} from './transport.js';

const ORIGIN_TRANSACTION = `0x${'01'.repeat(32)}` as const;
const OTHER_ORIGIN_TRANSACTION = `0x${'02'.repeat(32)}` as const;
const now = Date.parse('2026-11-09T00:00:00.000Z');

function quoteRequest(): TransportQuoteRequest {
  return transportQuoteRequestSchema.parse({
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
}

describe('deterministic transport simulator', () => {
  it('quotes, processes, and verifies a successful delivery', async () => {
    const simulator = new DeterministicTransportSimulator({
      processingPolls: 1,
      now: () => now,
    });
    const quote = await simulator.getQuote(quoteRequest());
    expect(quote.provider).toBe('DEBTSHIFT_SIMULATOR');
    expect(quote.mode).toBe('SIMULATED');
    expect(quote.expectedAmountOutUnits).toBe('9990000000000000000');

    expect((await simulator.getStatus(quote.quoteId)).status).toBe('AWAITING_DEPOSIT');
    const reference = await simulator.submitOrigin({
      quoteHash: quote.quoteHash,
      originTransactionHash: ORIGIN_TRANSACTION,
    });
    expect((await simulator.getStatus(reference)).status).toBe('PROCESSING');
    const delivered = await simulator.getStatus(reference);
    expect(delivered.status).toBe('SUCCESS');
    expect(verifyTransportDelivery(quote, delivered)).toEqual({ valid: true, failures: [] });
  });

  it('makes origin submission idempotent but rejects replacement transactions', async () => {
    const simulator = new DeterministicTransportSimulator({ now: () => now });
    const quote = await simulator.getQuote(quoteRequest());
    const submission = { quoteHash: quote.quoteHash, originTransactionHash: ORIGIN_TRANSACTION };
    await expect(simulator.submitOrigin(submission)).resolves.toBe(quote.quoteId);
    await expect(simulator.submitOrigin(submission)).resolves.toBe(quote.quoteId);
    await expect(
      simulator.submitOrigin({
        quoteHash: quote.quoteHash,
        originTransactionHash: OTHER_ORIGIN_TRANSACTION,
      }),
    ).rejects.toThrow('different origin transaction');
  });

  it.each<TransportTerminalOutcome>([
    'INCOMPLETE_DEPOSIT',
    'FAILED_KNOWN_CUSTODY',
    'FAILED_AMBIGUOUS_CUSTODY',
    'UNKNOWN',
  ])('preserves the terminal %s outcome', async (outcome) => {
    const simulator = new DeterministicTransportSimulator({
      outcome,
      processingPolls: 0,
      now: () => now,
    });
    const quote = await simulator.getQuote(quoteRequest());
    await simulator.submitOrigin({
      quoteHash: quote.quoteHash,
      originTransactionHash: ORIGIN_TRANSACTION,
    });
    expect((await simulator.getStatus(quote.quoteId)).status).toBe(outcome);
  });

  it('verifies an exact refund to the configured source receiver', async () => {
    const simulator = new DeterministicTransportSimulator({
      outcome: 'REFUNDED',
      processingPolls: 0,
      now: () => now,
    });
    const quote = await simulator.getQuote(quoteRequest());
    await simulator.submitOrigin({
      quoteHash: quote.quoteHash,
      originTransactionHash: ORIGIN_TRANSACTION,
    });
    const refund = await simulator.getStatus(quote.quoteId);
    expect(verifyTransportRefund(quote, refund)).toEqual({ valid: true, failures: [] });
  });

  it('rejects wrong receiver, wrong token, and below-minimum delivery evidence', async () => {
    const simulator = new DeterministicTransportSimulator({
      processingPolls: 0,
      now: () => now,
      deliveredAmountUnits: '1',
      deliveredReceiver: '0x7100000000000000000000000000000000000007',
      deliveredAsset: {
        chainId: 31_338,
        address: '0x6100000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'WRONG',
      },
    });
    const quote = await simulator.getQuote(quoteRequest());
    await simulator.submitOrigin({
      quoteHash: quote.quoteHash,
      originTransactionHash: ORIGIN_TRANSACTION,
    });
    const verification = verifyTransportDelivery(quote, await simulator.getStatus(quote.quoteId));
    expect(verification.valid).toBe(false);
    expect(verification.failures).toEqual([
      'OUTPUT_ASSET_MISMATCH',
      'DESTINATION_RECEIVER_MISMATCH',
      'OUTPUT_BELOW_MINIMUM',
    ]);
  });

  it('rejects origin submission after quote expiration', async () => {
    let clock = now;
    const simulator = new DeterministicTransportSimulator({
      quoteTtlSeconds: 1,
      now: () => clock,
    });
    const quote = await simulator.getQuote(quoteRequest());
    clock += 2_000;
    await expect(
      simulator.submitOrigin({
        quoteHash: quote.quoteHash,
        originTransactionHash: ORIGIN_TRANSACTION,
      }),
    ).rejects.toThrow('expired');
  });

  it('normalizes known provider variants and fails unknown values closed', () => {
    expect(normalizeTransportStatus('awaiting-deposit')).toBe('AWAITING_DEPOSIT');
    expect(normalizeTransportStatus('processing')).toBe('PROCESSING');
    expect(normalizeTransportStatus('unexpected-new-status')).toBe('UNKNOWN');
  });
});

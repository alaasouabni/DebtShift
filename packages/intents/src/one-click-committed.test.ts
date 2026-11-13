import type { TokenReference } from '@debtshift/domain';
import { describe, expect, it, vi } from 'vitest';

import { OneClickCommittedClient } from './one-click.js';

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
const DEPOSIT = '0x3000000000000000000000000000000000000003';
const RECIPIENT = '0x4000000000000000000000000000000000000004';
const REFUND = '0x5000000000000000000000000000000000000005';
const ORIGIN_TRANSACTION = `0x${'11'.repeat(32)}` as const;
const DESTINATION_TRANSACTION = `0x${'22'.repeat(32)}` as const;

describe('OneClickCommittedClient', () => {
  it('requests an exact-input committed quote and retains the signed deposit binding', async () => {
    const signatureVerifier = vi.fn(() => true);
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({
        dry: false,
        swapType: 'EXACT_INPUT',
        depositType: 'ORIGIN_CHAIN',
        recipientType: 'DESTINATION_CHAIN',
      });
      return new Response(JSON.stringify(quoteResponse(request)), { status: 200 });
    });
    const client = committedClient(fetchImplementation as typeof fetch, signatureVerifier);

    const observation = await client.getCommittedQuoteObservation(committedRequest());

    expect(observation.quote).toMatchObject({
      provider: 'NEAR_INTENTS_1CLICK',
      mode: 'COMMITTED',
      depositAddress: DEPOSIT,
      depositMemo: 'route-7',
      correlationId: 'quote-correlation-1',
      amountInUnits: '1000000',
      minAmountOutUnits: '993010',
    });
    expect(observation.rawRequest).toMatchObject({ dry: false, amount: '1000000' });
    expect(signatureVerifier).toHaveBeenCalledOnce();
  });

  it('fails closed when the official quote signature is invalid', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(quoteResponse(request)), { status: 200 });
    });
    const client = committedClient(fetchImplementation as typeof fetch, () => false);

    await expect(client.getCommittedQuote(committedRequest())).rejects.toThrow(
      'signature is invalid',
    );
  });

  it('submits the origin hash and maps signed success status without inventing evidence', async () => {
    const fetchImplementation = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toBe('/v0/deposit/submit');
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toEqual({
        txHash: ORIGIN_TRANSACTION,
        depositAddress: DEPOSIT,
        memo: 'route-7',
      });
      return new Response(JSON.stringify(statusResponse('SUCCESS')), { status: 200 });
    });
    const client = committedClient(fetchImplementation as typeof fetch, () => true);

    const observation = await client.submitDepositTransaction({
      transactionHash: ORIGIN_TRANSACTION,
      depositAddress: DEPOSIT,
      depositMemo: 'route-7',
    });

    expect(observation).toMatchObject({
      status: 'SUCCESS',
      depositAddress: DEPOSIT,
      depositMemo: 'route-7',
      originTransactionHashes: [ORIGIN_TRANSACTION],
      destinationTransactionHashes: [DESTINATION_TRANSACTION],
      amountOutUnits: '998000',
    });
  });

  it('rejects unknown statuses and deposit bindings that do not match the request', async () => {
    const unknownStatusClient = committedClient(
      vi.fn(async () => {
        const response = statusResponse('SUCCESS') as Record<string, unknown>;
        response.status = 'UNDOCUMENTED_PROVIDER_STATE';
        return new Response(JSON.stringify(response), { status: 200 });
      }) as unknown as typeof fetch,
      () => true,
    );
    await expect(unknownStatusClient.getStatus(DEPOSIT, 'route-7')).rejects.toThrow();

    const mismatchedDepositClient = committedClient(
      vi.fn(async () => {
        const response = statusResponse('PROCESSING');
        response.quoteResponse.quote.depositAddress = '0x6000000000000000000000000000000000000006';
        return new Response(JSON.stringify(response), { status: 200 });
      }) as unknown as typeof fetch,
      () => true,
    );
    await expect(mismatchedDepositClient.getStatus(DEPOSIT, 'route-7')).rejects.toThrow(
      'deposit address does not match',
    );
  });
});

function committedClient(
  fetchImplementation: typeof fetch,
  signatureVerifier: () => boolean,
): OneClickCommittedClient {
  return new OneClickCommittedClient({
    baseUrl: 'https://oneclick.test',
    authToken: 'secret',
    allowTestEndpoint: true,
    fetchImplementation,
    signatureVerifier,
  });
}

function committedRequest() {
  return {
    inputAsset: SOURCE,
    outputAsset: DESTINATION,
    amountUnits: '1000000',
    amountKind: 'EXACT_INPUT' as const,
    maxSlippageBps: 50,
    destinationReceiver: RECIPIENT,
    refundReceiver: REFUND,
    deadline: '2099-11-10T12:05:00.000Z',
  };
}

function providerQuoteRequest() {
  return {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 50,
    originAsset: SOURCE.providerAssetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: DESTINATION.providerAssetId,
    amount: '1000000',
    refundTo: REFUND,
    refundType: 'ORIGIN_CHAIN',
    recipient: RECIPIENT,
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2099-11-10T12:05:00.000Z',
  };
}

function quoteResponse(request: Record<string, unknown>) {
  return {
    correlationId: 'quote-correlation-1',
    timestamp: '2026-11-10T12:00:00.000Z',
    signature: 'provider-signature',
    quoteRequest: request,
    quote: {
      depositAddress: DEPOSIT,
      depositMemo: 'route-7',
      amountIn: '1000000',
      amountInFormatted: '1',
      amountInUsd: '1',
      minAmountIn: '1000000',
      amountOut: '998000',
      amountOutFormatted: '0.998',
      amountOutUsd: '0.998',
      minAmountOut: '993010',
      deadline: '2099-11-10T12:05:00.000Z',
      timeWhenInactive: '2099-11-10T12:04:30.000Z',
      timeEstimate: 15,
    },
  };
}

function statusResponse(status: 'PROCESSING' | 'SUCCESS') {
  return {
    correlationId: 'status-correlation-1',
    quoteResponse: quoteResponse(providerQuoteRequest()),
    status,
    updatedAt: '2026-11-10T12:01:00.000Z',
    swapDetails: {
      intentHashes: ['intent-hash'],
      nearTxHashes: ['near-transaction-hash'],
      originChainTxHashes: [
        { hash: ORIGIN_TRANSACTION, explorerUrl: 'https://source.explorer/tx/origin' },
      ],
      destinationChainTxHashes: [
        {
          hash: DESTINATION_TRANSACTION,
          explorerUrl: 'https://destination.explorer/tx/destination',
        },
      ],
      amountIn: '1000000',
      amountOut: '998000',
      depositedAmount: '1000000',
    },
  };
}

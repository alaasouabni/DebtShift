import type { MigrationExecutionContext } from '@debtshift/database';
import { providerQuoteSchema } from '@debtshift/domain';
import type { OneClickStatusObservation } from '@debtshift/intents';
import { describe, expect, it, vi } from 'vitest';

import {
  OneClickTransportExecutionPort,
  type OneClickObservationStore,
} from './one-click-transport.js';

const MIGRATION_ID = `0x${'01'.repeat(32)}` as const;
const QUOTE_HASH = `0x${'02'.repeat(32)}` as const;
const ORIGIN_TRANSACTION = `0x${'03'.repeat(32)}` as const;
const DESTINATION_TRANSACTION = `0x${'04'.repeat(32)}` as const;
const REFUND_TRANSACTION = `0x${'05'.repeat(32)}` as const;
const RESPONSE_HASH = `0x${'06'.repeat(32)}` as const;
const DEPOSIT = '0x1000000000000000000000000000000000000001';
const DESTINATION_RECEIVER = '0x2000000000000000000000000000000000000002';
const REFUND_RECEIVER = '0x3000000000000000000000000000000000000003';

describe('OneClickTransportExecutionPort', () => {
  it('binds the committed deposit to the exact finalized origin transaction', async () => {
    const submitDepositTransaction = vi.fn(async () =>
      providerObservation('KNOWN_DEPOSIT_TX', {
        originTransactionHashes: [ORIGIN_TRANSACTION],
      }),
    );
    const store = observationStore();
    const port = new OneClickTransportExecutionPort(
      { submitDepositTransaction, getStatus: vi.fn() },
      store,
    );

    await expect(port.bindOrigin(context(), ORIGIN_TRANSACTION)).resolves.toEqual({
      providerReference: DEPOSIT,
      observationCount: 3,
    });
    expect(submitDepositTransaction).toHaveBeenCalledWith({
      transactionHash: ORIGIN_TRANSACTION,
      depositAddress: DEPOSIT,
      depositMemo: 'debtshift-route',
    });
    expect(store.store).toHaveBeenCalledWith('DEPOSIT_SUBMIT', expect.any(Object));
  });

  it('rejects a provider binding to a different origin transaction', async () => {
    const port = new OneClickTransportExecutionPort(
      {
        submitDepositTransaction: vi.fn(async () =>
          providerObservation('KNOWN_DEPOSIT_TX', {
            originTransactionHashes: [`0x${'ff'.repeat(32)}`],
          }),
        ),
        getStatus: vi.fn(),
      },
      observationStore(),
    );

    await expect(port.bindOrigin(context(), ORIGIN_TRANSACTION)).rejects.toThrow(
      'different origin transaction',
    );
  });

  it('maps success only when the provider supplies a concrete destination transaction', async () => {
    const getStatus = vi.fn(async () =>
      providerObservation('SUCCESS', {
        originTransactionHashes: [ORIGIN_TRANSACTION],
        destinationTransactionHashes: [DESTINATION_TRANSACTION],
        amountOutUnits: '995000',
      }),
    );
    const store = observationStore();
    const port = new OneClickTransportExecutionPort(
      { submitDepositTransaction: vi.fn(), getStatus },
      store,
    );

    const result = await port.observe(context({ originTransactionHash: ORIGIN_TRANSACTION }));

    expect(result.observation).toMatchObject({
      provider: 'NEAR_INTENTS_1CLICK',
      simulated: false,
      status: 'SUCCESS',
      destinationTransactionHash: DESTINATION_TRANSACTION,
      receiver: DESTINATION_RECEIVER,
      observedAmountOutUnits: '995000',
      rawObservationHash: RESPONSE_HASH,
    });
    expect(result.observationCount).toBe(3);
    expect(store.store).toHaveBeenCalledWith('STATUS', expect.any(Object));
  });

  it('maps failed custody conservatively and identifies only a distinct refund transaction', async () => {
    const failedPort = new OneClickTransportExecutionPort(
      {
        submitDepositTransaction: vi.fn(),
        getStatus: vi.fn(async () => providerObservation('FAILED')),
      },
      observationStore(),
    );
    await expect(failedPort.observe(context())).resolves.toMatchObject({
      observation: { status: 'FAILED_AMBIGUOUS_CUSTODY' },
    });

    const refundedPort = new OneClickTransportExecutionPort(
      {
        submitDepositTransaction: vi.fn(),
        getStatus: vi.fn(async () =>
          providerObservation('REFUNDED', {
            originTransactionHashes: [ORIGIN_TRANSACTION, REFUND_TRANSACTION],
            refundedAmountUnits: '1000000',
          }),
        ),
      },
      observationStore(),
    );
    await expect(
      refundedPort.observe(context({ originTransactionHash: ORIGIN_TRANSACTION })),
    ).resolves.toMatchObject({
      observation: {
        status: 'REFUNDED',
        refundTransactionHash: REFUND_TRANSACTION,
        receiver: REFUND_RECEIVER,
        observedAmountOutUnits: '1000000',
      },
    });
  });
});

function observationStore(): OneClickObservationStore & { store: ReturnType<typeof vi.fn> } {
  return { store: vi.fn(async () => {}) };
}

function context(
  transportOverrides: Partial<MigrationExecutionContext['transportLeg']> = {},
): MigrationExecutionContext {
  const quote = providerQuoteSchema.parse({
    quoteId: 'oneclick-quote-correlation',
    quoteHash: QUOTE_HASH,
    provider: 'NEAR_INTENTS_1CLICK',
    mode: 'COMMITTED',
    inputAsset: {
      chainId: 8453,
      address: '0x4000000000000000000000000000000000000004',
      decimals: 6,
      symbol: 'USDC',
      providerAssetId: 'nep141:base-usdc.omft.near',
    },
    outputAsset: {
      chainId: 42161,
      address: '0x5000000000000000000000000000000000000005',
      decimals: 6,
      symbol: 'USDC',
      providerAssetId: 'nep141:arb-usdc.omft.near',
    },
    amountInUnits: '1000000',
    expectedAmountOutUnits: '995000',
    minAmountOutUnits: '990000',
    fees: [],
    destinationReceiver: DESTINATION_RECEIVER,
    refundReceiver: REFUND_RECEIVER,
    depositAddress: DEPOSIT,
    depositMemo: 'debtshift-route',
    expiresAt: '2099-11-10T12:05:00.000Z',
    correlationId: 'quote-correlation',
    rawResponseHash: RESPONSE_HASH,
  });
  const now = new Date('2026-11-10T12:00:00.000Z');
  return {
    migration: {
      migrationId: MIGRATION_ID,
      intentHash: `0x${'07'.repeat(32)}`,
      planHash: `0x${'08'.repeat(32)}`,
      quoteHash: QUOTE_HASH,
      phase: 'ROUTING',
      version: 1,
      expiresAt: new Date(quote.expiresAt),
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    signedIntent: {} as MigrationExecutionContext['signedIntent'],
    signedPlan: {} as MigrationExecutionContext['signedPlan'],
    targetLendingAuthorization: {
      authorization: { kind: 'NONE' },
      encodedAuthorization: '0x',
    },
    sourceSnapshot: {} as MigrationExecutionContext['sourceSnapshot'],
    quote,
    transportLeg: {
      migrationId: MIGRATION_ID,
      legIndex: 0,
      provider: quote.provider,
      quoteHash: quote.quoteHash,
      inputAsset: quote.inputAsset,
      outputAsset: quote.outputAsset,
      inputUnits: quote.amountInUnits,
      minimumOutputUnits: quote.minAmountOutUnits,
      observedOutputUnits: null,
      providerState: 'PROCESSING',
      providerReference: DEPOSIT,
      depositAddress: DEPOSIT,
      originTransactionHash: null,
      destinationTransactionHash: null,
      refundTransactionHash: null,
      observationCount: 2,
      createdAt: now,
      updatedAt: now,
      ...transportOverrides,
    },
  };
}

function providerObservation(
  status: OneClickStatusObservation['status'],
  overrides: Partial<OneClickStatusObservation> = {},
): OneClickStatusObservation {
  return {
    status,
    correlationId: 'status-correlation',
    depositAddress: DEPOSIT,
    depositMemo: 'debtshift-route',
    originTransactionHashes: [],
    destinationTransactionHashes: [],
    nearTransactionHashes: [],
    requestHash: `0x${'09'.repeat(32)}`,
    responseHash: RESPONSE_HASH,
    rawRequest: { depositAddress: DEPOSIT },
    rawResponse: { status },
    providerUpdatedAt: '2026-11-10T12:01:00.000Z',
    observedAt: '2026-11-10T12:01:01.000Z',
    ...overrides,
  };
}

import type { Address, PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { ChainlinkOracleFreshnessReader, ChainlinkPriceReader } from './chainlink-oracle.js';

const MORPHO_ORACLE = '0x1000000000000000000000000000000000000001';
const FEED_A = '0x2000000000000000000000000000000000000002';
const FEED_B = '0x3000000000000000000000000000000000000003';
const SEQUENCER = '0x4000000000000000000000000000000000000004';

describe('Chainlink oracle freshness reader', () => {
  it('uses the oldest valid feed timestamp and enforces the L2 recovery grace', async () => {
    const client = fakeClient({
      [FEED_A]: [11n, 2_000_000_000n, 9_900n, 9_950n, 11n],
      [FEED_B]: [22n, 1_000_000n, 9_850n, 9_900n, 22n],
      [SEQUENCER]: [33n, 0n, 5_000n, 5_000n, 33n],
    });
    const reader = new ChainlinkOracleFreshnessReader(client, {
      morphoOracle: MORPHO_ORACLE,
      feeds: [
        { address: FEED_A, maximumAgeSeconds: 100 },
        { address: FEED_B, maximumAgeSeconds: 100 },
      ],
      sequencerUptimeFeed: { address: SEQUENCER, recoveryGraceSeconds: 3_600 },
    });

    const result = await reader.readUpdatedAt({
      oracle: MORPHO_ORACLE,
      blockNumber: 123n,
      blockObservedAt: new Date(10_000_000).toISOString(),
    });

    expect(result.updatedAt).toBe(new Date(9_900_000).toISOString());
    expect(result.provenance).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('fails closed for stale price data or a recovering sequencer', async () => {
    const staleReader = new ChainlinkOracleFreshnessReader(
      fakeClient({ [FEED_A]: [11n, 1n, 9_000n, 9_000n, 11n] }),
      {
        morphoOracle: MORPHO_ORACLE,
        feeds: [{ address: FEED_A, maximumAgeSeconds: 100 }],
      },
    );
    await expect(
      staleReader.readUpdatedAt({
        oracle: MORPHO_ORACLE,
        blockNumber: 123n,
        blockObservedAt: new Date(10_000_000).toISOString(),
      }),
    ).rejects.toThrow('stale');

    const recoveringReader = new ChainlinkOracleFreshnessReader(
      fakeClient({
        [FEED_A]: [11n, 1n, 9_900n, 9_950n, 11n],
        [SEQUENCER]: [33n, 0n, 9_000n, 9_000n, 33n],
      }),
      {
        morphoOracle: MORPHO_ORACLE,
        feeds: [{ address: FEED_A, maximumAgeSeconds: 100 }],
        sequencerUptimeFeed: { address: SEQUENCER, recoveryGraceSeconds: 3_600 },
      },
    );
    await expect(
      recoveringReader.readUpdatedAt({
        oracle: MORPHO_ORACLE,
        blockNumber: 123n,
        blockObservedAt: new Date(10_000_000).toISOString(),
      }),
    ).rejects.toThrow('grace');
  });

  it('returns an exact pinned price and rejects answered-in-earlier-round data', async () => {
    const reader = new ChainlinkPriceReader(
      fakeClient({ [FEED_A]: [11n, 2_000_000_000n, 9_900n, 9_950n, 11n] }),
    );
    await expect(
      reader.readAtBlock(
        { address: FEED_A, maximumAgeSeconds: 100 },
        123n,
        new Date(10_000_000).toISOString(),
      ),
    ).resolves.toMatchObject({
      feed: FEED_A,
      answer: 2_000_000_000n,
      decimals: 8,
      blockNumber: '123',
    });

    const incomplete = new ChainlinkPriceReader(
      fakeClient({ [FEED_A]: [11n, 2_000_000_000n, 9_900n, 9_950n, 10n] }),
    );
    await expect(
      incomplete.readAtBlock(
        { address: FEED_A, maximumAgeSeconds: 100 },
        123n,
        new Date(10_000_000).toISOString(),
      ),
    ).rejects.toThrow('incomplete round');
  });
});

function fakeClient(
  rounds: Readonly<Record<string, readonly [bigint, bigint, bigint, bigint, bigint]>>,
): PublicClient {
  return {
    readContract: vi.fn(async (request: unknown) => {
      const call = request as { readonly address: Address; readonly functionName: string };
      if (call.functionName === 'decimals') return 8;
      const round = rounds[call.address];
      if (round === undefined) throw new Error(`Missing round for ${call.address}.`);
      return round;
    }),
  } as unknown as PublicClient;
}

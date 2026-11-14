import { hashCanonicalText } from '@debtshift/domain';
import { getAddress, isAddressEqual, type Address, type PublicClient } from 'viem';

import type { MorphoOracleFreshnessReader } from './morpho-blue.js';

export const CHAINLINK_AGGREGATOR_V3_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'description',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'description', type: 'string' }],
  },
] as const;

export interface ChainlinkFeedPolicy {
  readonly address: Address;
  readonly maximumAgeSeconds: number;
}

export interface ChainlinkSequencerPolicy {
  readonly address: Address;
  readonly recoveryGraceSeconds: number;
}

export interface ChainlinkOracleFreshnessConfig {
  readonly morphoOracle: Address;
  readonly feeds: readonly ChainlinkFeedPolicy[];
  readonly sequencerUptimeFeed?: ChainlinkSequencerPolicy;
}

export interface ChainlinkPriceObservation {
  readonly feed: Address;
  readonly answer: bigint;
  readonly decimals: number;
  readonly updatedAt: string;
  readonly blockNumber: string;
}

/** Direct USD/feed price read pinned to a caller-selected canonical block. */
export class ChainlinkPriceReader {
  constructor(
    private readonly client: PublicClient,
    private readonly sequencer?: ChainlinkSequencerPolicy,
  ) {
    if (
      sequencer !== undefined &&
      (!Number.isInteger(sequencer.recoveryGraceSeconds) || sequencer.recoveryGraceSeconds < 3_600)
    ) {
      throw new Error('L2 sequencer recovery grace must be at least 3600 seconds.');
    }
  }

  async readAtBlock(
    feedInput: ChainlinkFeedPolicy,
    blockNumber: bigint,
    blockObservedAt: string,
  ): Promise<ChainlinkPriceObservation> {
    const feed = getAddress(feedInput.address);
    if (!Number.isInteger(feedInput.maximumAgeSeconds) || feedInput.maximumAgeSeconds <= 0) {
      throw new Error('Chainlink feed maximum age must be a positive integer.');
    }
    const observedAtSeconds = BigInt(Math.floor(Date.parse(blockObservedAt) / 1_000));
    if (observedAtSeconds <= 0n) throw new Error('Invalid oracle observation timestamp.');
    const [round, decimals, sequencerRound] = await Promise.all([
      this.client.readContract({
        address: feed,
        abi: CHAINLINK_AGGREGATOR_V3_ABI,
        functionName: 'latestRoundData',
        blockNumber,
      }),
      this.client.readContract({
        address: feed,
        abi: CHAINLINK_AGGREGATOR_V3_ABI,
        functionName: 'decimals',
        blockNumber,
      }),
      this.sequencer === undefined
        ? Promise.resolve(undefined)
        : this.client.readContract({
            address: getAddress(this.sequencer.address),
            abi: CHAINLINK_AGGREGATOR_V3_ABI,
            functionName: 'latestRoundData',
            blockNumber,
          }),
    ]);
    if (sequencerRound !== undefined && this.sequencer !== undefined) {
      assertSequencerAvailable(
        sequencerRound,
        observedAtSeconds,
        this.sequencer.recoveryGraceSeconds,
      );
    }
    const [roundId, answer, , updatedAt, answeredInRound] = round;
    assertCompleteRound(feed, roundId, answer, updatedAt, answeredInRound, observedAtSeconds);
    if (observedAtSeconds - updatedAt > BigInt(feedInput.maximumAgeSeconds)) {
      throw new Error(`Chainlink feed ${feed} is stale.`);
    }
    return {
      feed,
      answer,
      decimals,
      updatedAt: new Date(Number(updatedAt) * 1_000).toISOString(),
      blockNumber: blockNumber.toString(),
    };
  }
}

/**
 * Verifies the configured feed proxies at the exact Morpho snapshot block.
 * The Morpho oracle price is still read independently by MorphoBlueReadAdapter.
 */
export class ChainlinkOracleFreshnessReader implements MorphoOracleFreshnessReader {
  readonly #oracle: Address;
  readonly #feeds: readonly ChainlinkFeedPolicy[];
  readonly #sequencer?: ChainlinkSequencerPolicy;

  constructor(
    private readonly client: PublicClient,
    config: ChainlinkOracleFreshnessConfig,
  ) {
    this.#oracle = getAddress(config.morphoOracle);
    if (config.feeds.length === 0) throw new Error('At least one Chainlink feed is required.');
    this.#feeds = config.feeds.map((feed) => {
      if (!Number.isInteger(feed.maximumAgeSeconds) || feed.maximumAgeSeconds <= 0) {
        throw new Error('Chainlink feed maximum age must be a positive integer.');
      }
      return { address: getAddress(feed.address), maximumAgeSeconds: feed.maximumAgeSeconds };
    });
    if (config.sequencerUptimeFeed !== undefined) {
      if (
        !Number.isInteger(config.sequencerUptimeFeed.recoveryGraceSeconds) ||
        config.sequencerUptimeFeed.recoveryGraceSeconds < 3_600
      ) {
        throw new Error('L2 sequencer recovery grace must be at least 3600 seconds.');
      }
      this.#sequencer = {
        address: getAddress(config.sequencerUptimeFeed.address),
        recoveryGraceSeconds: config.sequencerUptimeFeed.recoveryGraceSeconds,
      };
    }
  }

  async readUpdatedAt(input: {
    readonly oracle: Address;
    readonly blockNumber: bigint;
    readonly blockObservedAt: string;
  }): Promise<{ readonly updatedAt: string; readonly provenance: string }> {
    if (!isAddressEqual(getAddress(input.oracle), this.#oracle)) {
      throw new Error('Morpho oracle does not match the approved Chainlink feed policy.');
    }
    const observedAtSeconds = BigInt(Math.floor(Date.parse(input.blockObservedAt) / 1_000));
    if (observedAtSeconds <= 0n) throw new Error('Invalid oracle observation timestamp.');
    const [feedResults, sequencerResult] = await Promise.all([
      Promise.all(
        this.#feeds.map(async (feed) => ({
          feed,
          round: await this.client.readContract({
            address: feed.address,
            abi: CHAINLINK_AGGREGATOR_V3_ABI,
            functionName: 'latestRoundData',
            blockNumber: input.blockNumber,
          }),
          decimals: await this.client.readContract({
            address: feed.address,
            abi: CHAINLINK_AGGREGATOR_V3_ABI,
            functionName: 'decimals',
            blockNumber: input.blockNumber,
          }),
        })),
      ),
      this.#sequencer === undefined
        ? Promise.resolve(undefined)
        : this.client.readContract({
            address: this.#sequencer.address,
            abi: CHAINLINK_AGGREGATOR_V3_ABI,
            functionName: 'latestRoundData',
            blockNumber: input.blockNumber,
          }),
    ]);
    if (sequencerResult !== undefined && this.#sequencer !== undefined) {
      assertSequencerAvailable(
        sequencerResult,
        observedAtSeconds,
        this.#sequencer.recoveryGraceSeconds,
      );
    }
    let oldestUpdatedAt = observedAtSeconds;
    const provenance: string[] = [];
    for (const { feed, round, decimals } of feedResults) {
      const [roundId, answer, , updatedAt, answeredInRound] = round;
      assertCompleteRound(
        feed.address,
        roundId,
        answer,
        updatedAt,
        answeredInRound,
        observedAtSeconds,
      );
      if (observedAtSeconds - updatedAt > BigInt(feed.maximumAgeSeconds)) {
        throw new Error(`Chainlink feed ${feed.address} is stale.`);
      }
      if (updatedAt < oldestUpdatedAt) oldestUpdatedAt = updatedAt;
      provenance.push(`${feed.address.toLowerCase()}:${roundId}:${decimals}`);
    }
    return {
      updatedAt: new Date(Number(oldestUpdatedAt) * 1_000).toISOString(),
      provenance: hashCanonicalText(
        `debtshift.chainlink-freshness.v1:${input.blockNumber}:${provenance.sort().join('|')}`,
      ),
    };
  }
}

function assertCompleteRound(
  feed: Address,
  roundId: bigint,
  answer: bigint,
  updatedAt: bigint,
  answeredInRound: bigint,
  observedAtSeconds: bigint,
): void {
  if (roundId === 0n || answer <= 0n || updatedAt === 0n || answeredInRound < roundId) {
    throw new Error(`Chainlink feed ${feed} returned an incomplete round.`);
  }
  if (updatedAt > observedAtSeconds) {
    throw new Error(`Chainlink feed ${feed} is newer than the observed block.`);
  }
}

function assertSequencerAvailable(
  round: readonly [bigint, bigint, bigint, bigint, bigint],
  observedAtSeconds: bigint,
  recoveryGraceSeconds: number,
): void {
  if (round[1] !== 0n) throw new Error('The L2 sequencer is reported down.');
  if (round[2] === 0n || observedAtSeconds < round[2]) {
    throw new Error('The L2 sequencer status round is incomplete.');
  }
  if (observedAtSeconds - round[2] < BigInt(recoveryGraceSeconds)) {
    throw new Error('The L2 sequencer recovery grace period has not elapsed.');
  }
}

import {
  decodeAbiParameters,
  decodeFunctionData,
  hashTypedData,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  buildMorphoOpenPositionTransactions,
  buildMorphoAuthorizationPair,
  encodeMorphoAuthorizationPair,
  MORPHO_AUTHORIZATION_PAIR_PARAMETERS,
  MORPHO_BLUE_WRITE_ABI,
  MorphoBlueReadAdapter,
  morphoAuthorizationTypedData,
  morphoMarketId,
  ratePerSecondToApyBps,
  wTaylorCompounded,
  type MorphoMarketParams,
} from './morpho-blue.js';

const MORPHO = '0x5000000000000000000000000000000000000005';
const LOAN = '0x1111111111111111111111111111111111111111';
const COLLATERAL = '0x2222222222222222222222222222222222222222';
const ORACLE = '0x3333333333333333333333333333333333333333';
const IRM = '0x4444444444444444444444444444444444444444';
const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa';
const CALLER = '0x6000000000000000000000000000000000000006';
const RECEIVER = '0x7000000000000000000000000000000000000007';
const ENABLE_SIGNATURE = `0x${'11'.repeat(64)}1b` as Hex;
const DISABLE_SIGNATURE = `0x${'22'.repeat(64)}1c` as Hex;
const PARAMS: MorphoMarketParams = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: ORACLE,
  irm: IRM,
  lltv: 750_000_000_000_000_000n,
};
const MARKET_ID = '0xd8bd6e73328098bccecff386da5cb69c1b1bf7e3ec6c1d649719bdcf022c3d3b';

describe('Morpho Blue direct-read adapter', () => {
  it('re-derives market identity and reads accrued liquidity, rates, oracle, and position state', async () => {
    const readContract = vi.fn(async (request: unknown) => {
      const call = request as {
        readonly address: Address;
        readonly functionName: string;
        readonly args?: readonly unknown[];
      };
      if (call.functionName === 'idToMarketParams') {
        return [LOAN, COLLATERAL, ORACLE, IRM, PARAMS.lltv];
      }
      if (call.functionName === 'market') {
        return [
          100_000_000_000n,
          100_000_000_000_000n,
          80_000_000_000n,
          80_000_000_000_000n,
          1_000n,
          0n,
        ];
      }
      if (call.functionName === 'borrowRateView') {
        const market = call.args?.[1] as { readonly totalBorrowAssets: bigint };
        return market.totalBorrowAssets > 85_000_000_000n ? 2_000_000_000n : 1_000_000_000n;
      }
      if (call.functionName === 'price') return 2n * 10n ** 36n;
      if (call.functionName === 'balanceOf') return 15_000_000_000n;
      if (call.functionName === 'decimals') return 6;
      if (call.functionName === 'symbol') return call.address === LOAN ? 'USDC' : 'wCOLL';
      if (call.functionName === 'position') {
        return [0n, 10_000_000_000_000n, 10_000_000_000n];
      }
      throw new Error(`Unexpected ${call.functionName}.`);
    });
    const client = {
      getChainId: vi.fn(async () => 8453),
      getBlock: vi.fn(async () => ({
        number: 200n,
        hash: `0x${'23'.repeat(32)}`,
        timestamp: 1_100n,
      })),
      readContract,
    } as unknown as PublicClient;
    const freshness = {
      readUpdatedAt: vi.fn(async (input: { readonly blockObservedAt: string }) => ({
        updatedAt: input.blockObservedAt,
        provenance: 'chainlink-round-data-fixture',
      })),
    };
    const adapter = new MorphoBlueReadAdapter(client, { chainId: 8453, morpho: MORPHO }, freshness);

    const market = await adapter.readMarket(MARKET_ID, 10_000_000_000n);

    expect(market.marketId).toBe(MARKET_ID);
    expect(market.availableBorrowUnits).toBe('15000000000');
    expect(market.currentBorrowAprBps).toBe(320);
    expect(market.projectedBorrowAprBps).toBe(651);
    expect(market.snapshot).toMatchObject({
      borrowAprBps: 320,
      availableBorrowUnits: '15000000000',
      lltvBps: 7500,
      oracle: { priceMantissa: `${2n * 10n ** 36n}`, priceDecimals: 36 },
      block: { number: '200', hash: `0x${'23'.repeat(32)}` },
    });
    expect(market.accruedMarket.lastUpdate).toBe(1_100n);
    expect(market.accruedMarket.totalBorrowAssets).toBeGreaterThan(80_000_000_000n);

    const position = await adapter.readPosition(MARKET_ID, BORROWER);
    expect(BigInt(position.debtUnits)).toBeGreaterThan(10_000_000_000n);
    expect(position.collateralUnits).toBe('10000000000');
    expect(position.ltvBps).toBeGreaterThanOrEqual(5000);
  });

  it('matches the Solidity abi.encode market-id fixture and builds bounded target calls', () => {
    expect(morphoMarketId(PARAMS)).toBe(MARKET_ID);
    const prepared = buildMorphoOpenPositionTransactions(MORPHO, PARAMS, {
      caller: CALLER,
      borrower: BORROWER,
      debtReceiver: RECEIVER,
      collateralUnits: 10_000_000_000n,
      borrowUnits: 10_050_000_000n,
    });

    expect(prepared.marketId).toBe(MARKET_ID);
    expect(prepared.requiresMorphoAuthorization).toBe(true);
    expect(prepared.transactions).toHaveLength(3);
    expect(
      decodeFunctionData({
        abi: MORPHO_BLUE_WRITE_ABI,
        data: prepared.transactions[1]?.data ?? '0x',
      }),
    ).toMatchObject({
      functionName: 'supplyCollateral',
      args: [PARAMS, 10_000_000_000n, BORROWER, '0x'],
    });
    expect(
      decodeFunctionData({
        abi: MORPHO_BLUE_WRITE_ABI,
        data: prepared.transactions[2]?.data ?? '0x',
      }),
    ).toMatchObject({
      functionName: 'borrow',
      args: [PARAMS, 10_050_000_000n, 0n, BORROWER, RECEIVER],
    });
  });

  it('builds consecutive native Morpho authorizations and their Solidity-compatible bytes', () => {
    const pair = buildMorphoAuthorizationPair(BORROWER, CALLER, 7n, 1_800_000_000n);
    const enableTypedData = morphoAuthorizationTypedData(8453, MORPHO, pair.enable);
    const disableTypedData = morphoAuthorizationTypedData(8453, MORPHO, pair.disable);

    expect(pair).toEqual({
      enable: {
        authorizer: BORROWER,
        authorized: CALLER,
        isAuthorized: true,
        nonce: 7n,
        deadline: 1_800_000_000n,
      },
      disable: {
        authorizer: BORROWER,
        authorized: CALLER,
        isAuthorized: false,
        nonce: 8n,
        deadline: 1_800_000_000n,
      },
    });
    expect(enableTypedData.domain).toEqual({ chainId: 8453, verifyingContract: MORPHO });
    expect(hashTypedData(enableTypedData)).not.toBe(hashTypedData(disableTypedData));

    const encoded = encodeMorphoAuthorizationPair(pair, ENABLE_SIGNATURE, DISABLE_SIGNATURE);
    const decoded = decodeAbiParameters(MORPHO_AUTHORIZATION_PAIR_PARAMETERS, encoded);
    expect(decoded[0]).toEqual(pair.enable);
    expect(decoded[1]).toEqual({
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'11'.repeat(32)}`,
    });
    expect(decoded[2]).toEqual(pair.disable);
    expect(decoded[3]).toEqual({
      v: 28,
      r: `0x${'22'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    });
  });

  it('rejects malformed authorization signatures before contract submission', () => {
    const pair = buildMorphoAuthorizationPair(BORROWER, CALLER, 0n, 1n);
    expect(() => encodeMorphoAuthorizationPair(pair, '0x1234', DISABLE_SIGNATURE)).toThrow(
      '65 bytes',
    );
    expect(() =>
      encodeMorphoAuthorizationPair(pair, `0x${'11'.repeat(64)}02`, DISABLE_SIGNATURE),
    ).toThrow('v must be 27 or 28');
  });

  it('uses Morpho third-order WAD Taylor compounding with integer math', () => {
    expect(wTaylorCompounded(1_000_000_000n, 31_536_000n)).toBe(32_038_486_841_419_776n);
    expect(ratePerSecondToApyBps(1_000_000_000n)).toBe(320);
    expect(ratePerSecondToApyBps(2_000_000_000n)).toBe(651);
  });
});

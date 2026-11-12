import { decodeFunctionData, type Address, type PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  AAVE_POOL_WRITE_ABI,
  AaveV3ReadAdapter,
  buildAaveCollateralClaimAuthorization,
  buildAaveBorrowerCloseTransactions,
  ERC20_METADATA_ABI,
  rayToBps,
  readAaveReserveTokenAddresses,
} from './aave-v3.js';

const POOL = '0x1000000000000000000000000000000000000001';
const DATA_PROVIDER = '0x2000000000000000000000000000000000000002';
const COLLATERAL = '0x3000000000000000000000000000000000000003';
const DEBT = '0x4000000000000000000000000000000000000004';
const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa';
const RECEIVER = '0x5000000000000000000000000000000000000005';

describe('Aave V3 direct-read adapter', () => {
  it('reads one canonical block and normalizes an exact variable-debt position', async () => {
    const readContract = vi.fn(async (request: unknown) => {
      const call = request as {
        readonly address: Address;
        readonly functionName: string;
        readonly args?: readonly unknown[];
      };
      if (call.functionName === 'getUserReserveData') {
        return call.args?.[0] === COLLATERAL
          ? [10n * 10n ** 18n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, true]
          : [0n, 0n, 10_000_000_000n, 0n, 10_000_000_000n, 0n, 0n, 0n, false];
      }
      if (call.functionName === 'getReserveData') {
        return [
          0n,
          0n,
          100_000_000_000n,
          0n,
          50_000_000_000n,
          0n,
          5n * 10n ** 25n,
          0n,
          0n,
          10n ** 27n,
          10n ** 27n,
          1_700_000_000,
        ];
      }
      if (call.functionName === 'getUserAccountData') {
        return [20_000_000_000n, 10_000_000_000n, 0n, 8000n, 7500n, 15n * 10n ** 17n];
      }
      if (call.functionName === 'decimals') return call.address === COLLATERAL ? 18 : 6;
      if (call.functionName === 'symbol') return call.address === COLLATERAL ? 'WETH' : 'USDC';
      throw new Error(`Unexpected ${call.functionName}.`);
    });
    const client = {
      getChainId: vi.fn(async () => 8453),
      getBlock: vi.fn(async () => ({
        number: 123n,
        hash: `0x${'12'.repeat(32)}`,
        timestamp: 1_700_000_010n,
      })),
      readContract,
    } as unknown as PublicClient;
    const adapter = new AaveV3ReadAdapter(client, {
      chainId: 8453,
      pool: POOL,
      dataProvider: DATA_PROVIDER,
      collateralAsset: { chainId: 8453, address: COLLATERAL, decimals: 18, symbol: 'WETH' },
      debtAsset: { chainId: 8453, address: DEBT, decimals: 6, symbol: 'USDC' },
    });

    const position = await adapter.readPosition(BORROWER);

    expect(position).toMatchObject({
      collateralUnits: '10000000000000000000',
      debtUnits: '10000000000',
      borrowAprBps: 500,
      health: { kind: 'AAVE_HEALTH_FACTOR', healthFactorWad: '1500000000000000000' },
      block: { number: '123', hash: `0x${'12'.repeat(32)}` },
    });
    expect(position?.position.collateralAsset.symbol).toBe('WETH');
    expect(position?.position.debtAsset.symbol).toBe('USDC');
    expect(readContract).toHaveBeenCalledTimes(8);
    for (const [call] of readContract.mock.calls) {
      expect((call as { blockNumber?: bigint }).blockNumber).toBe(123n);
    }
  });

  it('constructs a borrower-direct approve, variable repay, and bounded withdraw sequence', () => {
    const transactions = buildAaveBorrowerCloseTransactions(
      {
        pool: POOL,
        collateralAsset: { chainId: 8453, address: COLLATERAL, decimals: 18 },
        debtAsset: { chainId: 8453, address: DEBT, decimals: 6 },
      },
      {
        borrower: BORROWER,
        debtUnits: 10_000_000_000n,
        collateralUnits: 10n * 10n ** 18n,
        collateralReceiver: RECEIVER,
      },
    );

    expect(transactions).toHaveLength(3);
    expect(
      decodeFunctionData({ abi: ERC20_METADATA_ABI, data: transactions[0]?.data ?? '0x' }),
    ).toMatchObject({ functionName: 'approve', args: [POOL, 10_000_000_000n] });
    expect(
      decodeFunctionData({ abi: AAVE_POOL_WRITE_ABI, data: transactions[1]?.data ?? '0x' }),
    ).toMatchObject({ functionName: 'repay', args: [DEBT, 10_000_000_000n, 2n, BORROWER] });
    expect(
      decodeFunctionData({ abi: AAVE_POOL_WRITE_ABI, data: transactions[2]?.data ?? '0x' }),
    ).toMatchObject({
      functionName: 'withdraw',
      args: [COLLATERAL, 10n * 10n ** 18n, RECEIVER],
    });
  });

  it('constructs only the exact aToken claim approval for atomic adapter execution', () => {
    const transaction = buildAaveCollateralClaimAuthorization(
      COLLATERAL,
      DATA_PROVIDER,
      10n * 10n ** 18n,
    );

    expect(transaction.to).toBe(COLLATERAL);
    expect(decodeFunctionData({ abi: ERC20_METADATA_ABI, data: transaction.data })).toMatchObject({
      functionName: 'approve',
      args: [DATA_PROVIDER, 10n * 10n ** 18n],
    });
    expect(() => buildAaveCollateralClaimAuthorization(COLLATERAL, DATA_PROVIDER, 0n)).toThrow(
      'must be positive',
    );
  });

  it('reads and normalizes the reserve-specific aToken and debt-token identities', async () => {
    const aToken = '0x5000000000000000000000000000000000000005';
    const stableDebtToken = '0x6000000000000000000000000000000000000006';
    const variableDebtToken = '0x7000000000000000000000000000000000000007';
    const client = {
      readContract: vi.fn(async () => [aToken, stableDebtToken, variableDebtToken]),
    } as unknown as PublicClient;

    await expect(
      readAaveReserveTokenAddresses(client, DATA_PROVIDER, COLLATERAL, 123n),
    ).resolves.toEqual({
      aToken,
      stableDebtToken,
      variableDebtToken,
    });
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: DATA_PROVIDER,
        functionName: 'getReserveTokensAddresses',
        args: [COLLATERAL],
        blockNumber: 123n,
      }),
    );
  });

  it('converts Aave ray rates to nearest basis points without floating point math', () => {
    expect(rayToBps(5n * 10n ** 25n)).toBe(500);
    expect(rayToBps(12_345n * 10n ** 20n)).toBe(12);
  });
});

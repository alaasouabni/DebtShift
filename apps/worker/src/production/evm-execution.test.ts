import { describe, expect, it } from 'vitest';

import {
  conservativeFeasibilityTimestamp,
  descendingInclusiveBlockRanges,
  financingFeasibilityHash,
  isRestrictedRpcLogRangeError,
  settlementReconciliationPayload,
} from './evm-execution.js';

describe('conservative feasibility timestamp', () => {
  it('lags the observed head enough to tolerate adjacent public RPC backends', () => {
    expect(conservativeFeasibilityTimestamp(1_000n)).toBe(970n);
  });

  it('does not underflow at chain genesis', () => {
    expect(conservativeFeasibilityTimestamp(20n)).toBe(0n);
  });
});

describe('financing feasibility hash', () => {
  it('matches the hash recorded by the Sepolia liquidity vault', () => {
    expect(
      financingFeasibilityHash(
        '0xece17b2ff0fc8c28c5878e5fccef6cfaf108b3ef99d66f719b1165d151db8475',
        '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
        {
          planHash: '0x57d59199b26df81816a8408fe60ab3e07335c63b1029a0c00d1ce93e71ca8c58',
          analysisHash: '0xb56903278a1e355e32e8e529f123a5dd3ab05a3ef10663c44ea59c78428a9063',
          externalFundingEvidenceHash:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
          solverPrincipalUnits: 5_005_059n,
          solverFeeUnits: 0n,
          capitalizedCostUnits: 0n,
          totalRequiredUnits: 5_005_059n,
          confirmedExternalFundingUnits: 0n,
          maximumSafeBorrowingCapacityUnits: 5_005_059n,
          requiredDestinationBorrowUnits: 5_005_059n,
          fundingShortfallUnits: 0n,
          sequence: 2n,
          evaluatedAt: 1_794_636_546n,
          validUntil: 1_794_640_011n,
        },
      ),
    ).toBe('0xb0840fcfe6010ec5acb32bcd1b0a2a9a375d2827d97d4cf653e09e420a382f3d');
  });
});

describe('settlement reconciliation payload', () => {
  it('restores every accounting field required after an already-finalized settlement', () => {
    expect(
      settlementReconciliationPayload(
        '0x662C3218f0f2bE4f40f06a4f4Bc730dCe1996233',
        5_000_106n,
        0n,
        '0x662C3218f0f2bE4f40f06a4f4Bc730dCe1996233',
        5_005_059n,
      ),
    ).toEqual({
      payer: '0x662C3218f0f2bE4f40f06a4f4Bc730dCe1996233',
      principalUnits: '5000106',
      feeUnits: '0',
      repaymentUnits: '5000106',
      recoveryReserveProvider: '0x662C3218f0f2bE4f40f06a4f4Bc730dCe1996233',
      recoveryReserveMaximumUnits: '5005059',
    });
  });
});

describe('restricted RPC log scans', () => {
  it('walks inclusive ranges backward without gaps or overlap', () => {
    expect([...descendingInclusiveBlockRanges(100n, 650n, 200n)]).toEqual([
      { fromBlock: 451n, toBlock: 650n },
      { fromBlock: 251n, toBlock: 450n },
      { fromBlock: 100n, toBlock: 250n },
    ]);
  });

  it('recognizes provider block-range limit errors without swallowing unrelated RPC failures', () => {
    expect(isRestrictedRpcLogRangeError(new Error('eth_getLogs is limited to a 200 range'))).toBe(
      true,
    );
    expect(isRestrictedRpcLogRangeError(new Error('exceed maximum block range: 50000'))).toBe(true);
    expect(isRestrictedRpcLogRangeError(new Error('execution reverted'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  conservativeFeasibilityTimestamp,
  descendingInclusiveBlockRanges,
  isRestrictedRpcLogRangeError,
} from './evm-execution.js';

describe('conservative feasibility timestamp', () => {
  it('lags the observed head enough to tolerate adjacent public RPC backends', () => {
    expect(conservativeFeasibilityTimestamp(1_000n)).toBe(970n);
  });

  it('does not underflow at chain genesis', () => {
    expect(conservativeFeasibilityTimestamp(20n)).toBe(0n);
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

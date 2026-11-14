import { describe, expect, it } from 'vitest';

import { conservativeFeasibilityTimestamp } from './evm-execution.js';

describe('conservative feasibility timestamp', () => {
  it('lags the observed head enough to tolerate adjacent public RPC backends', () => {
    expect(conservativeFeasibilityTimestamp(1_000n)).toBe(970n);
  });

  it('does not underflow at chain genesis', () => {
    expect(conservativeFeasibilityTimestamp(20n)).toBe(0n);
  });
});

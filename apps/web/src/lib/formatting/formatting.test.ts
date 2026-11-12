import { describe, expect, it } from 'vitest';

import {
  bpsPercent,
  bpsToPoints,
  compareAmounts,
  displayScaleFor,
  formatAmount,
  formatBaseUnits,
  formatBps,
  formatDuration,
  formatInteger,
  formatRelativeAge,
  formatTimestamp,
  formatUnixTimestamp,
  formatUsdMicro,
  formatWad,
  humanizeIdentifier,
  isTruncatedAtDisplay,
  isZeroAmount,
  ratioPercent,
  secondsUntilIso,
  secondsUntilUnix,
  truncateHex,
} from './index';

describe('formatBaseUnits', () => {
  it('formats the seeded local collateral exactly', () => {
    // 10 sWETH at 18 decimals, the position local:chains seeds.
    expect(formatBaseUnits('10000000000000000000', 18)).toBe('10.0000');
  });

  it('formats the seeded local debt with thousands grouping', () => {
    // 10 000 sUSDC at 6 decimals.
    expect(formatBaseUnits('10000000000', 6)).toBe('10,000.00');
  });

  it('handles a value far above Number.MAX_SAFE_INTEGER without losing a digit', () => {
    // 123456789012345678901234567890 wei. Number() would mangle this.
    expect(formatBaseUnits('123456789012345678901234567890', 18, { fractionDigits: 18 })).toBe(
      '123,456,789,012.345678901234567890',
    );
  });

  it('truncates rather than rounds, so a displayed amount never exceeds the real one', () => {
    // 0.99999 at 5 decimals shown to 2 places must not become 1.00.
    expect(formatBaseUnits('99999', 5, { fractionDigits: 2 })).toBe('0.99');
  });

  it('keeps the scale fixed so a column of amounts aligns', () => {
    expect(formatBaseUnits('5000000', 6)).toBe('5.00');
    expect(formatBaseUnits('1234500000000000000', 18)).toBe('1.2345');
    // Trailing zeros are kept: the width must not change while polling.
    expect(formatBaseUnits('1200000000000000000', 18)).toBe('1.2000');
  });

  it('formats zero and sub-unit amounts', () => {
    expect(formatBaseUnits('0', 18)).toBe('0.0000');
    expect(formatBaseUnits('1', 18, { fractionDigits: 18 })).toBe('0.000000000000000001');
  });

  it('formats a zero-decimal value', () => {
    expect(formatBaseUnits('42', 0)).toBe('42');
  });

  it('renders negative zero as zero', () => {
    expect(formatBaseUnits('-0', 6)).toBe('0.00');
  });

  it('keeps a real negative sign', () => {
    expect(formatBaseUnits('-1500000', 6)).toBe('-1.50');
  });

  it('can switch grouping off', () => {
    expect(formatBaseUnits('10000000000', 6, { group: false })).toBe('10000.00');
  });

  it('rejects anything that is not an integer string', () => {
    expect(() => formatBaseUnits('1.5', 18)).toThrow(TypeError);
    expect(() => formatBaseUnits('1e18', 18)).toThrow(TypeError);
    expect(() => formatBaseUnits('', 18)).toThrow(TypeError);
    // A number would silently lose precision, so it is refused outright.
    expect(() => formatBaseUnits(1e18 as unknown as string, 18)).toThrow(TypeError);
  });

  it('rejects an out-of-range decimals argument', () => {
    expect(() => formatBaseUnits('1', -1)).toThrow(RangeError);
    expect(() => formatBaseUnits('1', 37)).toThrow(RangeError);
  });

  it('rejects a negative display scale', () => {
    expect(() => formatBaseUnits('1', 18, { fractionDigits: -2 })).toThrow(RangeError);
  });
});

describe('displayScaleFor', () => {
  it('gives two places to a stablecoin-shaped asset and four to a volatile one', () => {
    expect(displayScaleFor(6)).toBe(2);
    expect(displayScaleFor(18)).toBe(4);
    expect(displayScaleFor(0)).toBe(0);
  });
});

describe('isTruncatedAtDisplay', () => {
  it('reports a hidden non-zero digit', () => {
    expect(isTruncatedAtDisplay('1234567890000000000', 18, 4)).toBe(true);
  });

  it('reports nothing hidden when the tail is all zeros', () => {
    expect(isTruncatedAtDisplay('1200000000000000000', 18, 4)).toBe(false);
  });

  it('reports nothing hidden when decimals fit inside the display', () => {
    expect(isTruncatedAtDisplay('123456', 2, 4)).toBe(false);
  });
});

describe('formatAmount', () => {
  it('appends the symbol', () => {
    expect(formatAmount('10000000000000000000', 18, 'sWETH')).toBe('10.0000 sWETH');
    expect(formatAmount('10000000000', 6, 'sUSDC')).toBe('10,000.00 sUSDC');
  });
});

describe('formatBps', () => {
  it('formats the seeded source rate', () => {
    expect(formatBps(700)).toBe('7.00%');
  });

  it('formats sub-percent and fractional rates', () => {
    expect(formatBps(0)).toBe('0.00%');
    expect(formatBps(1)).toBe('0.01%');
    expect(formatBps(25)).toBe('0.25%');
    expect(formatBps(1234)).toBe('12.34%');
  });

  it('groups a very large rate', () => {
    expect(formatBps(1_000_000)).toBe('10,000.00%');
  });

  it('formats a negative rate change', () => {
    expect(formatBps(-250)).toBe('-2.50%');
  });

  it('rejects a non-integer', () => {
    expect(() => formatBps(7.5)).toThrow(TypeError);
  });
});

describe('formatUsdMicro', () => {
  it('formats micro-dollars to two places', () => {
    expect(formatUsdMicro('12340000')).toBe('$12.34');
    expect(formatUsdMicro('0')).toBe('$0.00');
    expect(formatUsdMicro('1234567890123')).toBe('$1,234,567.89');
  });

  it('formats a negative benefit', () => {
    expect(formatUsdMicro('-4500000')).toBe('-$4.50');
  });

  it('truncates, so a cost is never shown smaller than it is after rounding up', () => {
    expect(formatUsdMicro('999999')).toBe('$0.99');
  });
});

describe('formatWad', () => {
  it('formats the seeded health factor', () => {
    expect(formatWad('1500000000000000000')).toBe('1.50');
  });

  it('formats a health factor at the liquidation threshold', () => {
    expect(formatWad('1000000000000000000')).toBe('1.00');
  });

  it('can show more precision on request', () => {
    expect(formatWad('1234567890000000000', 4)).toBe('1.2345');
  });
});

describe('truncateHex', () => {
  it('truncates the seeded borrower address', () => {
    expect(truncateHex('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toBe('0x7099…79C8');
  });

  it('leaves a short value alone', () => {
    expect(truncateHex('0x7099')).toBe('0x7099');
  });
});

describe('formatTimestamp', () => {
  it('formats an ISO instant in UTC', () => {
    expect(formatTimestamp('2026-11-11T15:59:28.000Z')).toBe('11 Nov 2026, 15:59:28 UTC');
  });

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(formatTimestamp('not a date')).toBe('not a date');
  });
});

describe('formatUnixTimestamp', () => {
  it('formats a unix-seconds string', () => {
    expect(formatUnixTimestamp('1794412768')).toBe('11 Nov 2026, 15:59:28 UTC');
  });
});

describe('formatRelativeAge', () => {
  const now = new Date('2026-11-11T15:59:42.000Z');

  it('formats the age quoted on the position screen', () => {
    expect(formatRelativeAge('2026-11-11T15:59:28.000Z', now)).toBe('14 s ago');
  });

  it('formats a future instant', () => {
    expect(formatRelativeAge('2026-11-11T16:01:42.000Z', now)).toBe('in 2 min');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(14)).toBe('14 s');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(106)).toBe('1 min 46 s');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(7380)).toBe('2 h 03 min');
    expect(formatDuration(86_400)).toBe('1 day');
    expect(formatDuration(1_987_200)).toBe('23 days');
  });

  it('clamps a negative duration', () => {
    expect(formatDuration(-5)).toBe('0 s');
  });
});

describe('secondsUntilUnix', () => {
  const now = new Date('2026-11-11T16:00:00.000Z'); // 1794412800

  it('counts down to a deadline', () => {
    expect(secondsUntilUnix('1794412920', now)).toBe(120);
  });

  it('clamps an elapsed deadline at zero', () => {
    expect(secondsUntilUnix('1794412700', now)).toBe(0);
  });

  it('handles a deadline far beyond Number precision without throwing', () => {
    expect(secondsUntilUnix('99999999999999999999', now)).toBe(31_536_000);
  });

  it('rejects a non-integer deadline', () => {
    expect(() => secondsUntilUnix('later', now)).toThrow(TypeError);
  });
});

describe('secondsUntilIso', () => {
  it('counts down to a quote expiry', () => {
    const now = new Date('2026-11-11T16:00:00.000Z');
    expect(secondsUntilIso('2026-11-11T16:00:45.000Z', now)).toBe(45);
    expect(secondsUntilIso('2026-11-11T15:59:00.000Z', now)).toBe(0);
  });
});

describe('compareAmounts', () => {
  it('compares beyond Number precision', () => {
    // These two differ only in the last digit, well past 2^53.
    expect(compareAmounts('9007199254740993000', '9007199254740992000')).toBe(1);
    expect(compareAmounts('9007199254740992000', '9007199254740993000')).toBe(-1);
    expect(compareAmounts('10000000000', '10000000000')).toBe(0);
  });
});

describe('isZeroAmount', () => {
  it('recognises zero whatever the padding', () => {
    expect(isZeroAmount('0')).toBe(true);
    expect(isZeroAmount('0000')).toBe(true);
    expect(isZeroAmount('-0')).toBe(true);
    expect(isZeroAmount('1')).toBe(false);
  });
});

describe('ratioPercent', () => {
  it('computes a bar width from two base-unit amounts', () => {
    // The real capacity chart: 10,500 signed capacity on a 0–20,000 scale.
    expect(ratioPercent('10500000000', '20000000000')).toBe(52.5);
    expect(ratioPercent('16125000000', '20000000000')).toBe(80.62);
  });

  it('divides in BigInt, so a value past Number precision is still exact', () => {
    // Exactly half, with both operands far above 2^53.
    expect(ratioPercent('9007199254740992000', '18014398509481984000')).toBe(50);
  });

  it('caps at 100 so an off-scale value cannot overflow its track', () => {
    expect(ratioPercent('250000000000', '20000000000')).toBe(100);
  });

  it('returns zero for a zero or negative denominator', () => {
    expect(ratioPercent('100', '0')).toBe(0);
  });

  it('returns zero for a zero value', () => {
    expect(ratioPercent('0', '20000000000')).toBe(0);
  });
});

describe('bpsPercent', () => {
  it('scales a rate against the chart maximum', () => {
    // 7.00% on a 0–8% scale.
    expect(bpsPercent(700, 800)).toBe(87.5);
    expect(bpsPercent(438, 800)).toBe(54.75);
  });

  it('caps and floors', () => {
    expect(bpsPercent(1600, 800)).toBe(100);
    expect(bpsPercent(0, 800)).toBe(0);
    expect(bpsPercent(700, 0)).toBe(0);
  });
});

describe('bpsToPoints', () => {
  it('renders a rate saving in percentage points', () => {
    expect(bpsToPoints(262)).toBe('2.62');
    expect(bpsToPoints(28)).toBe('0.28');
    expect(bpsToPoints(700)).toBe('7.00');
    expect(bpsToPoints(-150)).toBe('-1.50');
  });
});

describe('formatInteger', () => {
  it('groups a block number', () => {
    expect(formatInteger('1284')).toBe('1,284');
    expect(formatInteger('17')).toBe('17');
  });
});

describe('humanizeIdentifier', () => {
  it('turns backend identifiers into readable names', () => {
    // The two real identifiers on the recorded sandbox run.
    expect(humanizeIdentifier('LOCAL_AAVE_MOCK')).toBe('Local Aave Mock');
    expect(humanizeIdentifier('local-morpho-balanced')).toBe('Local Morpho Balanced');
  });

  it('handles mixed separators and stray ones', () => {
    expect(humanizeIdentifier('morpho_blue-v1')).toBe('Morpho Blue V1');
    expect(humanizeIdentifier('__aave__')).toBe('Aave');
  });

  it('returns an empty string for an empty identifier', () => {
    expect(humanizeIdentifier('')).toBe('');
  });
});

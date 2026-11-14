/*
 * Display formatting for authoritative backend values.
 *
 * The one rule this module exists to enforce: an authorization or accounting
 * amount never passes through a JavaScript `number`. Every function here takes
 * the backend's integer string and works in `BigInt` or in plain string
 * arithmetic, and every function returns a *display* string while the caller
 * keeps the original value to send back.
 *
 * Fractions are TRUNCATED, never rounded. Rounding an amount the user is about
 * to authorize would show them a number that is not the one they signed. Where
 * truncation hides a non-zero digit the UI offers a raw-value toggle, and the
 * raw string is the authority.
 */

import { now as currentTime } from '../clock';

export interface BaseUnitFormatOptions {
  /**
   * Fraction digits to show, fixed. Extra digits are truncated, not rounded;
   * missing digits are padded with zeros. Defaults to `displayScaleFor`.
   *
   * The scale is deliberately fixed rather than trimmed: a column of amounts
   * that all end at the same place can be compared at a glance, and a figure
   * that changes width while polling is a figure the eye cannot track.
   */
  readonly fractionDigits?: number;
  /** Group the integer part in thousands. */
  readonly group?: boolean;
}

/**
 * The conventional display scale for a token with `decimals` base-unit digits:
 * two places for a stablecoin-shaped asset, four for a volatile one, none for
 * an indivisible one. Override it per call wherever the asset says otherwise.
 */
export function displayScaleFor(decimals: number): number {
  if (decimals === 0) return 0;
  return decimals <= 6 ? 2 : 4;
}

const INTEGER_PATTERN = /^-?\d+$/u;

function assertIntegerString(value: string, label: string): void {
  if (typeof value !== 'string' || !INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an integer string, received: ${String(value)}`);
  }
}

function groupThousands(digits: string): string {
  // Walk from the right in threes. No Number conversion, so a 78-digit
  // integer groups exactly as well as a 3-digit one.
  let out = '';
  for (let index = digits.length; index > 0; index -= 3) {
    const start = Math.max(0, index - 3);
    const chunk = digits.slice(start, index);
    out = out === '' ? chunk : `${chunk},${out}`;
  }
  return out === '' ? '0' : out;
}

/**
 * Format an integer base-unit amount for display.
 *
 * `formatBaseUnits('10000000000000000000', 18)` → `'10.0000'`
 * `formatBaseUnits('10000000000', 6)` → `'10,000.00'`
 */
export function formatBaseUnits(
  value: string,
  decimals: number,
  options: BaseUnitFormatOptions = {},
): string {
  assertIntegerString(value, 'A base-unit amount');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`Decimals must be an integer in 0..36, received: ${String(decimals)}`);
  }

  const { fractionDigits = displayScaleFor(decimals), group = true } = options;
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0) {
    throw new RangeError(
      `fractionDigits must be a non-negative integer, received: ${String(fractionDigits)}`,
    );
  }

  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals === 0 ? '' : padded.slice(padded.length - decimals);

  // Truncate to the display scale, then pad. Never round.
  const shown = fraction.slice(0, fractionDigits).padEnd(fractionDigits, '0');

  const integerPart = group ? groupThousands(whole) : whole.replace(/^0+(?=\d)/u, '');
  const sign = negative && /[1-9]/u.test(digits) ? '-' : '';
  return shown === '' ? `${sign}${integerPart}` : `${sign}${integerPart}.${shown}`;
}

/**
 * True when displaying `value` at `maxFractionDigits` would hide a non-zero
 * digit. Use it to decide whether to mark a figure as approximate.
 */
export function isTruncatedAtDisplay(
  value: string,
  decimals: number,
  fractionDigits = displayScaleFor(decimals),
): boolean {
  assertIntegerString(value, 'A base-unit amount');
  if (decimals <= fractionDigits) return false;
  const digits = value.startsWith('-') ? value.slice(1) : value;
  const padded = digits.padStart(decimals + 1, '0');
  const fraction = padded.slice(padded.length - decimals);
  return /[1-9]/u.test(fraction.slice(fractionDigits));
}

/** Format a base-unit amount with its symbol, e.g. `'10.0000 sWETH'`. */
export function formatAmount(
  value: string,
  decimals: number,
  symbol: string,
  options?: BaseUnitFormatOptions,
): string {
  return `${formatBaseUnits(value, decimals, options)} ${symbol}`;
}

/** Basis points to a percentage, e.g. `700` → `'7.00%'`. */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps)) {
    throw new TypeError(`Basis points must be an integer, received: ${String(bps)}`);
  }
  const negative = bps < 0;
  const absolute = Math.abs(bps);
  const whole = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  return `${negative ? '-' : ''}${groupThousands(String(whole))}.${String(fraction).padStart(2, '0')}%`;
}

/** Integer micro-dollars to a display amount, e.g. `'12340000'` → `'$12.34'`. */
export function formatUsdMicro(value: string): string {
  const negative = value.startsWith('-');
  const formatted = formatBaseUnits(negative ? value.slice(1) : value, 6, { fractionDigits: 2 });
  return `${negative ? '-' : ''}$${formatted}`;
}

/** A WAD (1e18) value to a plain factor, e.g. a health factor `'1.50'`. */
export function formatWad(value: string, fractionDigits = 2): string {
  return formatBaseUnits(value, 18, { fractionDigits });
}

/** `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` → `0x7099…79C8`. */
export function truncateHex(value: string, lead = 6, tail = 4): string {
  if (typeof value !== 'string' || value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** An absolute timestamp, e.g. `'11 Nov 2026, 15:59:28 UTC'`. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][parsed.getUTCMonth()];
  const time = [parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  return `${day} ${month} ${parsed.getUTCFullYear()}, ${time} UTC`;
}

/** Whole seconds between two instants, negative when `iso` is in the future. */
export function secondsSince(iso: string, now: Date = currentTime()): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 0;
  return Math.floor((now.getTime() - parsed) / 1000);
}

/** `'14 s ago'`, `'3 min ago'`, `'in 2 min'`. */
export function formatRelativeAge(iso: string, now: Date = currentTime()): string {
  const seconds = secondsSince(iso, now);
  const future = seconds < 0;
  const magnitude = formatDuration(Math.abs(seconds));
  return future ? `in ${magnitude}` : `${magnitude} ago`;
}

/** A plain duration in seconds, e.g. `'1 min 46 s'`, `'2 h 03 min'`, `'23 days'`. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${String(rest).padStart(2, '0')} s`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes === 0 ? `${hours} h` : `${hours} h ${String(minutes).padStart(2, '0')} min`;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const dayLabel = days === 1 ? 'day' : 'days';
  return hours === 0 ? `${days} ${dayLabel}` : `${days} ${dayLabel} ${hours} h`;
}

/**
 * Seconds remaining until a unix-seconds deadline (as the backend sends it, an
 * integer string). Clamped at zero. Uses BigInt so a far-future deadline cannot
 * overflow.
 */
export function secondsUntilUnix(unixSeconds: string, now: Date = currentTime()): number {
  assertIntegerString(unixSeconds, 'A unix deadline');
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const remaining = BigInt(unixSeconds) - nowSeconds;
  if (remaining <= 0n) return 0;
  // A deadline more than a year out is clamped for display purposes only.
  return remaining > 31_536_000n ? 31_536_000 : Number(remaining);
}

/** Seconds remaining until an ISO timestamp. Clamped at zero. */
export function secondsUntilIso(iso: string, now: Date = currentTime()): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((parsed - now.getTime()) / 1000));
}

/** A unix-seconds string to an absolute display timestamp. */
export function formatUnixTimestamp(unixSeconds: string): string {
  assertIntegerString(unixSeconds, 'A unix timestamp');
  return formatTimestamp(new Date(Number(BigInt(unixSeconds) * 1000n)).toISOString());
}

/** BigInt comparison of two integer strings: -1, 0 or 1. */
export function compareAmounts(left: string, right: string): -1 | 0 | 1 {
  assertIntegerString(left, 'A base-unit amount');
  assertIntegerString(right, 'A base-unit amount');
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** True when an integer string is exactly zero, whatever its padding. */
export function isZeroAmount(value: string): boolean {
  assertIntegerString(value, 'A base-unit amount');
  return BigInt(value) === 0n;
}

/**
 * `value / max` as a percentage, for a bar width.
 *
 * The division happens in BigInt and only the small, bounded result becomes a
 * number. A percentage is a LAYOUT value — it never feeds an amount, a total or
 * anything the user authorizes, and the figure beside every bar is always the
 * formatted base-unit string, not this.
 */
export function ratioPercent(value: string, max: string, cap = 100): number {
  assertIntegerString(value, 'A base-unit amount');
  assertIntegerString(max, 'A base-unit amount');
  const denominator = BigInt(max);
  if (denominator <= 0n) return 0;
  const numerator = BigInt(value);
  if (numerator <= 0n) return 0;
  // Two extra digits of precision before the result leaves BigInt.
  const scaled = (numerator * 10_000n) / denominator;
  const percent = Number(scaled) / 100;
  return percent > cap ? cap : percent;
}

/** The same ratio for two basis-point figures, which are already small integers. */
export function bpsPercent(bps: number, maxBps: number, cap = 100): number {
  if (maxBps <= 0) return 0;
  const percent = (bps / maxBps) * 100;
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return percent > cap ? cap : percent;
}

/** Basis points as plain percentage points, e.g. `262` → `'2.62'`. */
export function bpsToPoints(bps: number): string {
  const negative = bps < 0;
  const absolute = Math.abs(bps);
  return `${negative ? '-' : ''}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** Group a plain integer string in thousands, e.g. a block number. */
export function formatInteger(value: string): string {
  assertIntegerString(value, 'An integer');
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  return `${negative ? '-' : ''}${groupThousands(digits.replace(/^0+(?=\d)/u, ''))}`;
}

/**
 * A backend identifier as readable words: `LOCAL_AAVE_MOCK` → `Local Aave Mock`,
 * `local-morpho-balanced` → `Local Morpho Balanced`.
 *
 * Presentation only. The raw identifier is what the backend means, so wherever
 * identity matters it is still shown, in monospace, beside this.
 */
export function humanizeIdentifier(identifier: string): string {
  return identifier
    .split(/[_\-\s]+/u)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/*
 * The app's clock.
 *
 * Every "how long ago" and every countdown reads the time from here instead of
 * from `new Date()`. In normal use this is the real clock and the indirection
 * costs nothing.
 *
 * It exists for the recorded demo. A recording carries real timestamps,
 * deadlines and hashes from the moment it was captured. Rewriting those values
 * to "now" would show hashes that no longer match the data beside them, so the
 * demo does the opposite: it leaves every recorded value untouched and moves
 * the CLOCK back to the moment of the recording, then lets it run. Countdowns
 * tick, ages grow, and everything on screen is still exactly what the backend
 * sent.
 */

let offsetMs = 0;

/** The current time, real or anchored. */
export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

/**
 * Make the clock read `instant` right now and keep running from there.
 * Only the recorded demo calls this.
 */
export function anchorClock(instant: Date | number): void {
  const target = typeof instant === 'number' ? instant : instant.getTime();
  if (Number.isNaN(target)) return;
  offsetMs = target - Date.now();
}

/** Return to the real clock. */
export function resetClock(): void {
  offsetMs = 0;
}

/** True while the clock is anchored away from real time. */
export function isClockAnchored(): boolean {
  return offsetMs !== 0;
}

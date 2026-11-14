// @vitest-environment jsdom

/*
 * The brand intro's rules: once per browser session, never for a visitor who
 * asked for reduced motion, and the page waits for it only while it plays.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTRO_SEEN_KEY } from '../storage-keys';
import { INTRO_BOOTSTRAP_SCRIPT, INTRO_DURATION_MS, INTRO_REVEAL_MS, introDelayMs } from './index';

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query.includes('reduce'),
    }) as MediaQueryList) as typeof window.matchMedia;
}

function runScript() {
  // The script is what <head> runs before first paint.
  new Function(INTRO_BOOTSTRAP_SCRIPT)();
}

const root = () => document.documentElement;

beforeEach(() => {
  window.sessionStorage.clear();
  root().removeAttribute('data-intro');
  root().removeAttribute('data-intro-start');
  setReducedMotion(false);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the head script', () => {
  it('plays the intro on the first page of a session', () => {
    runScript();
    expect(root().getAttribute('data-intro')).toBe('play');
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBe('1');
  });

  it('does not play it again in the same session', () => {
    runScript();
    root().removeAttribute('data-intro');
    runScript();
    expect(root().getAttribute('data-intro')).toBeNull();
  });

  it('never plays it for a visitor who asked for reduced motion', () => {
    setReducedMotion(true);
    runScript();
    expect(root().getAttribute('data-intro')).toBeNull();
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBeNull();
  });

  it('takes itself away once the intro is over', () => {
    runScript();
    vi.advanceTimersByTime(INTRO_DURATION_MS);
    expect(root().getAttribute('data-intro')).toBeNull();
  });

  it('does not stop the page when storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(runScript).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe('how long the page waits', () => {
  it('waits for nothing when no intro is playing', () => {
    expect(introDelayMs()).toBe(0);
  });

  it('waits until the curtain starts to lift', () => {
    root().setAttribute('data-intro', 'play');
    root().setAttribute('data-intro-start', '1000');
    expect(introDelayMs(1000)).toBe(INTRO_REVEAL_MS);
    expect(introDelayMs(1000 + INTRO_REVEAL_MS - 500)).toBe(500);
    expect(introDelayMs(1000 + INTRO_REVEAL_MS + 300)).toBe(0);
  });
});

/*
 * The brand intro: the DebtShift mark draws itself, the name rises, and the
 * screen lifts away to show the page.
 *
 * It plays once per browser session, never for a visitor who asked for
 * reduced motion, and never without JavaScript. The decision is made by a
 * tiny script in `<head>` before first paint, so nobody sees the page flash
 * before the intro or the intro flash before the page.
 *
 * The animation itself is CSS (`components/intro/intro.css`), so it starts
 * at once, without waiting for the app to load.
 */

import { INTRO_SEEN_KEY } from '../storage-keys';

/** How long the intro covers the page, in milliseconds. Matches the CSS. */
export const INTRO_DURATION_MS = 2400;

/** When the hero may start its own entrance: as the curtain begins to lift. */
export const INTRO_REVEAL_MS = 1750;

/**
 * Sets `data-intro="play"` on `<html>` when the intro should play, and the
 * time it started, then clears it once the intro is over.
 */
export const INTRO_BOOTSTRAP_SCRIPT = `(function(){try{var d=document.documentElement;if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;var s=window.sessionStorage;if(s.getItem(${JSON.stringify(INTRO_SEEN_KEY)}))return;s.setItem(${JSON.stringify(INTRO_SEEN_KEY)},'1');d.setAttribute('data-intro','play');d.setAttribute('data-intro-start',String(Date.now()));setTimeout(function(){d.removeAttribute('data-intro');},${INTRO_DURATION_MS});}catch(e){}})();`;

/**
 * Milliseconds the page should still wait before animating in, or 0 when no
 * intro is playing.
 */
export function introDelayMs(now: number = Date.now()): number {
  if (typeof document === 'undefined') return 0;
  const root = document.documentElement;
  if (root.getAttribute('data-intro') !== 'play') return 0;
  const started = Number(root.getAttribute('data-intro-start'));
  if (!Number.isFinite(started)) return INTRO_REVEAL_MS;
  return Math.max(0, INTRO_REVEAL_MS - (now - started));
}

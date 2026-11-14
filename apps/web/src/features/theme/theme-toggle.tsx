'use client';

/*
 * The theme switch: light or dark, one press.
 *
 * It is a switch, with a sun on one side, a moon on the other and a knob that
 * slides to the theme in force, so nobody has to guess what an icon button
 * does. A visitor who chose nothing gets dark. A stored "system" choice (from
 * an earlier version of this control) is still honoured, and follows the
 * machine, until the visitor presses the switch.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  applyTheme,
  DEFAULT_THEME_CHOICE,
  readStoredChoice,
  resolveTheme,
  storeChoice,
  systemPrefersDark,
  type ResolvedTheme,
  type ThemeChoice,
} from '../../lib/theme';

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(DEFAULT_THEME_CHOICE);
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');
  // The server renders no theme, so the control is only drawn once the
  // client knows which one is active. Avoids a mismatched first paint.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readStoredChoice();
    setChoice(stored);
    setResolved(resolveTheme(stored, systemPrefersDark()));
    setReady(true);
  }, []);

  // While the choice is "system", follow the machine as it changes.
  useEffect(() => {
    if (choice !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = resolveTheme('system', query.matches);
      setResolved(next);
      applyTheme(next);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);

  const toggle = useCallback(() => {
    const next: ResolvedTheme = resolved === 'dark' ? 'light' : 'dark';
    setChoice(next);
    setResolved(next);
    storeChoice(next);
    applyTheme(next);
  }, [resolved]);

  if (!ready) {
    // Reserves the space so the header does not shift when it appears.
    return <span aria-hidden="true" style={{ width: 64, height: 34, display: 'inline-block' }} />;
  }

  const dark = resolved === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggle}
      className="theme-switch"
      data-theme-choice={choice}
      data-on={dark ? 'true' : 'false'}
    >
      <span className="theme-switch__knob" aria-hidden="true" />
      <svg
        className="theme-switch__icon theme-switch__icon--sun"
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
      </svg>
      <svg
        className="theme-switch__icon theme-switch__icon--moon"
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 13.4A8.2 8.2 0 1 1 10.6 4a6.6 6.6 0 0 0 9.4 9.4Z" />
      </svg>
    </button>
  );
}

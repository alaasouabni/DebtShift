'use client';

/*
 * The theme control.
 *
 * It reports the CHOICE, not the resolved theme, because "system" and "light"
 * look identical on a light machine and a control that cannot tell them apart
 * leaves the user unable to find their way back to system.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  applyTheme,
  DEFAULT_THEME_CHOICE,
  nextChoice,
  readStoredChoice,
  resolveTheme,
  storeChoice,
  systemPrefersDark,
  THEME_LABELS,
  type ResolvedTheme,
  type ThemeChoice,
} from '../../lib/theme';

const ICONS: Record<ThemeChoice, React.ReactNode> = {
  system: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </>
  ),
  dark: <path d="M20 13.4A8.2 8.2 0 1 1 10.6 4a6.6 6.6 0 0 0 9.4 9.4Z" />,
};

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

  // While the choice is "system", follow the machine as it changes — a user on
  // a scheduled dark mode should not have to reload at sunset.
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

  const cycle = useCallback(() => {
    const next = nextChoice(choice);
    const theme = resolveTheme(next, systemPrefersDark());
    setChoice(next);
    setResolved(theme);
    storeChoice(next);
    applyTheme(theme);
  }, [choice]);

  if (!ready) {
    // Reserves the space so the header does not shift when it appears.
    return <span aria-hidden="true" style={{ width: 36, height: 36, display: 'inline-block' }} />;
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="copy-btn"
      aria-label={`${THEME_LABELS[choice]}. Activate to change.`}
      title={`${THEME_LABELS[choice]} — currently ${resolved}`}
      data-theme-choice={choice}
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[choice]}
      </svg>
    </button>
  );
}

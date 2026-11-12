/*
 * Light and dark.
 *
 * The design system ships a full dark token set and the canvas renders four
 * dark boards, but it specifies no switch — the boards set `theme="dark"` as a
 * prop. So the behaviour here is a product decision, and it is the
 * conventional one: follow the operating system until the user says otherwise,
 * then remember what they said.
 *
 * Three choices, not two. "System" has to remain reachable, otherwise a user
 * who taps the toggle once is stuck overriding their OS forever.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'debtshift:theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** What a choice resolves to, given what the operating system reports. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'dark') return 'dark';
  if (choice === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

/** The next choice when the toggle is pressed: system → dark → light → system. */
export function nextChoice(current: ThemeChoice): ThemeChoice {
  if (current === 'system') return 'dark';
  if (current === 'dark') return 'light';
  return 'system';
}

export function readStoredChoice(): ThemeChoice {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function storeChoice(choice: ThemeChoice): void {
  if (typeof window === 'undefined') return;
  try {
    // "system" is stored explicitly rather than removed, so that going back to
    // system is a decision the next visit can read, not an absence.
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A privacy mode that refuses storage must not break the toggle.
  }
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Put the resolved theme on `<html>`, where the token blocks are scoped. */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  // Tells the browser to paint form controls and scrollbars to match.
  document.documentElement.style.colorScheme = theme;
}

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/**
 * A script for `<head>`, run before first paint.
 *
 * Without it the server markup is light, the client corrects it after
 * hydration, and a user who chose dark gets a white flash on every navigation.
 * It is deliberately tiny, dependency-free and wrapped in try/catch: it runs
 * before anything else and must never be the reason a page fails to render.
 *
 * Keep it in sync with `resolveTheme` above — they are the same rule, one for
 * React and one for the moment before React exists.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var c=window.localStorage.getItem(k);var d=c==='dark'||((c===null||c==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);var t=d?'dark':'light';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}catch(e){}})();`;

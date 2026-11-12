// @vitest-environment jsdom

/*
 * The theme control.
 *
 * What matters here is not that a class flips — it is that the user can always
 * get back to following their operating system, and that the control says
 * which of the three states it is in rather than only how the page looks.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THEME_STORAGE_KEY } from '../../lib/theme';
import { ThemeToggle } from './theme-toggle';

function setSystemPrefersDark(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: prefersDark,
    addEventListener: (_event: string, handler: () => void) => void listeners.add(handler),
    removeEventListener: (_event: string, handler: () => void) => void listeners.delete(handler),
  };
  window.matchMedia = ((): MediaQueryList =>
    query as unknown as MediaQueryList) as typeof window.matchMedia;
  return {
    change(next: boolean) {
      query.matches = next;
      for (const handler of listeners) handler();
    },
  };
}

/** Waits for the control to replace its placeholder. */
async function findToggle() {
  return waitFor(() => screen.getByRole('button', { name: /^Theme:/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  setSystemPrefersDark(false);
});

afterEach(cleanup);

describe('the initial state', () => {
  it('starts on system when nothing was chosen', async () => {
    render(<ThemeToggle />);
    const button = await findToggle();
    expect(button.getAttribute('data-theme-choice')).toBe('system');
  });

  it('restores a stored choice', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<ThemeToggle />);
    const button = await findToggle();
    expect(button.getAttribute('data-theme-choice')).toBe('dark');
  });

  it('reports light and system differently even though they look the same', async () => {
    // On a light machine both render a light page. The control must still say
    // which one is in force, or the user cannot navigate back to system.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeToggle />);
    expect((await findToggle()).getAttribute('aria-label')).toMatch(/Theme: light/);

    cleanup();
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    render(<ThemeToggle />);
    expect((await findToggle()).getAttribute('aria-label')).toMatch(/Theme: system/);
  });
});

describe('pressing it', () => {
  it('cycles system → dark → light → system', async () => {
    render(<ThemeToggle />);
    const button = await findToggle();

    fireEvent.click(button);
    expect(button.getAttribute('data-theme-choice')).toBe('dark');
    fireEvent.click(button);
    expect(button.getAttribute('data-theme-choice')).toBe('light');
    fireEvent.click(button);
    expect(button.getAttribute('data-theme-choice')).toBe('system');
  });

  it('applies the theme to the document', async () => {
    render(<ThemeToggle />);
    fireEvent.click(await findToggle());

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('persists the choice', async () => {
    render(<ThemeToggle />);
    fireEvent.click(await findToggle());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('resolves system against the machine, not against a default', async () => {
    setSystemPrefersDark(true);
    render(<ThemeToggle />);
    const button = await findToggle();

    // system → dark → light → system, and system on a dark machine is dark.
    fireEvent.click(button);
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('following the machine', () => {
  it('reacts to the system switching while the choice is system', async () => {
    const media = setSystemPrefersDark(false);
    render(<ThemeToggle />);
    await findToggle();

    media.change(true);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
  });

  it('ignores the system once the user has chosen', async () => {
    const media = setSystemPrefersDark(false);
    render(<ThemeToggle />);
    const button = await findToggle();

    fireEvent.click(button);
    fireEvent.click(button); // explicit light
    expect(button.getAttribute('data-theme-choice')).toBe('light');

    media.change(true);
    // The explicit choice wins: no change.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('accessibility', () => {
  it('is a real button with a label that says what pressing it does', async () => {
    render(<ThemeToggle />);
    const button = await findToggle();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toMatch(/Activate to change/i);
  });

  it('hides its icon from assistive technology', async () => {
    render(<ThemeToggle />);
    const button = await findToggle();
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reserves its space before it is ready, so the header does not shift', () => {
    const { container } = render(<ThemeToggle />);
    const placeholder = container.querySelector('[aria-hidden="true"]');
    expect(placeholder).not.toBeNull();
  });
});

describe('when storage is denied', () => {
  it('still toggles', async () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    render(<ThemeToggle />);
    fireEvent.click(await findToggle());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    vi.restoreAllMocks();
    expect(typeof original).toBe('function');
  });
});

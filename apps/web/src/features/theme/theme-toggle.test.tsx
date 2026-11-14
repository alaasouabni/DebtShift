// @vitest-environment jsdom

/*
 * The theme switch.
 *
 * A visible two-way switch: light or dark, one press, and it says which one is
 * on. The app is dark-first. A "system" choice stored by the earlier version
 * of this control keeps following the machine until the visitor presses it.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_THEME_CHOICE, THEME_STORAGE_KEY } from '../../lib/theme';
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

/** Waits for the switch to replace its placeholder. */
async function findSwitch() {
  return waitFor(() => screen.getByRole('switch', { name: /dark mode/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  setSystemPrefersDark(false);
});

afterEach(cleanup);

describe('the initial state', () => {
  it('starts dark when nothing was chosen', async () => {
    render(<ThemeToggle />);
    const control = await findSwitch();
    expect(DEFAULT_THEME_CHOICE).toBe('dark');
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('starts dark even on a machine that prefers light', async () => {
    setSystemPrefersDark(false);
    render(<ThemeToggle />);
    expect((await findSwitch()).getAttribute('aria-checked')).toBe('true');
  });

  it('restores a stored choice', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeToggle />);
    expect((await findSwitch()).getAttribute('aria-checked')).toBe('false');
  });

  it('shows the machine theme for a stored "system" choice', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    setSystemPrefersDark(false);
    render(<ThemeToggle />);
    const control = await findSwitch();
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.getAttribute('data-theme-choice')).toBe('system');
  });
});

describe('pressing it', () => {
  it('switches dark → light → dark', async () => {
    render(<ThemeToggle />);
    const control = await findSwitch();

    fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('applies the theme to the document', async () => {
    render(<ThemeToggle />);
    fireEvent.click(await findSwitch());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('persists the choice', async () => {
    render(<ThemeToggle />);
    fireEvent.click(await findSwitch());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('turns a "system" choice into an explicit one, opposite to what is shown', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    setSystemPrefersDark(true);
    render(<ThemeToggle />);
    const control = await findSwitch();
    expect(control.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(control);
    expect(control.getAttribute('data-theme-choice')).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('following the machine', () => {
  it('reacts to the system switching while the choice is system', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const media = setSystemPrefersDark(false);
    render(<ThemeToggle />);
    await findSwitch();

    media.change(true);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
  });

  it('ignores the system once the user has chosen', async () => {
    const media = setSystemPrefersDark(false);
    render(<ThemeToggle />);
    const control = await findSwitch();

    fireEvent.click(control); // explicit light
    media.change(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores the system on the default too, which is dark by decision', async () => {
    const media = setSystemPrefersDark(true);
    render(<ThemeToggle />);
    await findSwitch();
    media.change(false);
    expect(document.documentElement.getAttribute('data-theme')).not.toBe('light');
  });
});

describe('accessibility', () => {
  it('is a real button acting as a switch, with a label', async () => {
    render(<ThemeToggle />);
    const control = await findSwitch();
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('role')).toBe('switch');
    expect(control.getAttribute('aria-label')).toBe('Dark mode');
  });

  it('hides its icons from assistive technology', async () => {
    render(<ThemeToggle />);
    const control = await findSwitch();
    for (const icon of control.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('reserves its space before it is ready, so the header does not shift', () => {
    const { container } = render(<ThemeToggle />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('when storage is denied', () => {
  it('still switches', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<ThemeToggle />);
    fireEvent.click(await findSwitch());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    vi.restoreAllMocks();
  });
});

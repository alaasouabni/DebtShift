import { describe, expect, it, vi } from 'vitest';

import {
  applyTheme,
  isThemeChoice,
  nextChoice,
  readStoredChoice,
  resolveTheme,
  storeChoice,
  systemPrefersDark,
  THEME_BOOTSTRAP_SCRIPT,
  THEME_STORAGE_KEY,
} from './index';

function installStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

describe('resolveTheme', () => {
  it('honours an explicit choice whatever the machine says', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('follows the machine while the choice is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('nextChoice', () => {
  it('cycles through all three so system stays reachable', () => {
    // A two-state toggle would strand a user who pressed it once.
    expect(nextChoice('system')).toBe('dark');
    expect(nextChoice('dark')).toBe('light');
    expect(nextChoice('light')).toBe('system');
  });

  it('returns to the start after three presses', () => {
    expect(nextChoice(nextChoice(nextChoice('system')))).toBe('system');
  });
});

describe('isThemeChoice', () => {
  it('accepts the three choices and nothing else', () => {
    expect(isThemeChoice('system')).toBe(true);
    expect(isThemeChoice('light')).toBe(true);
    expect(isThemeChoice('dark')).toBe(true);
    expect(isThemeChoice('solarized')).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });
});

describe('storage', () => {
  it('round-trips a choice', () => {
    installStorage();
    storeChoice('dark');
    expect(readStoredChoice()).toBe('dark');
  });

  it('stores system explicitly rather than clearing the key', () => {
    const store = installStorage();
    storeChoice('system');
    expect(store.get(THEME_STORAGE_KEY)).toBe('system');
  });

  it('falls back to system when nothing is stored', () => {
    installStorage();
    expect(readStoredChoice()).toBe('system');
  });

  it('ignores a value it does not recognise', () => {
    installStorage({ [THEME_STORAGE_KEY]: 'neon' });
    expect(readStoredChoice()).toBe('system');
  });

  it('survives storage being unavailable', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(readStoredChoice()).toBe('system');
    expect(() => storeChoice('dark')).not.toThrow();
  });

  it('is safe on the server, where there is no window', () => {
    vi.stubGlobal('window', undefined);
    expect(readStoredChoice()).toBe('system');
    expect(() => storeChoice('dark')).not.toThrow();
    expect(systemPrefersDark()).toBe(false);
    expect(() => applyTheme('dark')).not.toThrow();
  });
});

describe('systemPrefersDark', () => {
  it('reads the media query', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(systemPrefersDark()).toBe(true);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(systemPrefersDark()).toBe(false);
  });

  it('assumes light when matchMedia is missing', () => {
    vi.stubGlobal('window', {});
    expect(systemPrefersDark()).toBe(false);
  });
});

describe('the bootstrap script', () => {
  /*
   * It runs before React exists, so it cannot import `resolveTheme`. These
   * tests execute the real script text against fake globals and assert it
   * reaches the same answer — the two must not drift apart.
   */
  function runBootstrap(stored: string | null, prefersDark: boolean) {
    const element = {
      attributes: {} as Record<string, string>,
      style: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
    };
    const fakeWindow = {
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: prefersDark }),
    };
    const fakeDocument = { documentElement: element };
    new Function('window', 'document', THEME_BOOTSTRAP_SCRIPT)(fakeWindow, fakeDocument);
    return element;
  }

  it('agrees with resolveTheme in every combination', () => {
    const cases: [string | null, boolean][] = [
      ['dark', false],
      ['dark', true],
      ['light', false],
      ['light', true],
      ['system', false],
      ['system', true],
      [null, false],
      [null, true],
    ];
    for (const [stored, prefersDark] of cases) {
      const element = runBootstrap(stored, prefersDark);
      const choice = isThemeChoice(stored) ? stored : 'system';
      expect(element.attributes['data-theme'], `${String(stored)}/${String(prefersDark)}`).toBe(
        resolveTheme(choice, prefersDark),
      );
    }
  });

  it('also sets colorScheme so native controls match', () => {
    expect(runBootstrap('dark', false).style.colorScheme).toBe('dark');
  });

  it('never throws, whatever the environment denies', () => {
    const element = { setAttribute: () => undefined, style: {} };
    const hostile = {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
      matchMedia: () => {
        throw new Error('blocked');
      },
    };
    expect(() =>
      new Function('window', 'document', THEME_BOOTSTRAP_SCRIPT)(hostile, {
        documentElement: element,
      }),
    ).not.toThrow();
  });

  it('carries the same storage key the React code reads', () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});

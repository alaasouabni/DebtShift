import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearApiKey,
  DEFAULT_PREFERENCES,
  hasApiKey,
  loadPreferences,
  savePreferences,
  setApiKey,
  toConfiguration,
  type ExplanationPreferences,
} from './explanation-settings';

/** A minimal localStorage, so these tests can run in vitest's node environment. */
function installStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
  vi.stubGlobal('window', { localStorage: storage });
  return store;
}

describe('API key handling', () => {
  beforeEach(() => {
    installStorage();
    clearApiKey();
  });

  it('never writes the key to storage, whatever else is saved', () => {
    const store = installStorage();
    setApiKey('sk-this-must-never-be-persisted');

    const preferences: ExplanationPreferences = {
      mode: 'USER_API',
      localBaseUrl: 'http://127.0.0.1:11434',
      localModel: 'llama3',
      provider: 'OPENAI',
      userModel: 'gpt-4o',
      userBaseUrl: '',
    };
    savePreferences(preferences);

    const serialized = [...store.values()].join(' ');
    expect(serialized).not.toContain('sk-this-must-never-be-persisted');
    expect(serialized).toContain('gpt-4o');
  });

  it('keeps the key only in memory, so a reload forgets it', () => {
    setApiKey('sk-secret');
    expect(hasApiKey()).toBe(true);
    // A reload loses module state; `clearApiKey` stands in for that here.
    clearApiKey();
    expect(hasApiKey()).toBe(false);
  });

  it('does not leak the key into the saved preference object', () => {
    setApiKey('sk-secret');
    savePreferences({ ...DEFAULT_PREFERENCES, mode: 'USER_API', userModel: 'gpt-4o' });
    const restored = loadPreferences();
    expect(JSON.stringify(restored)).not.toContain('sk-secret');
    expect(Object.keys(restored)).not.toContain('apiKey');
  });
});

describe('preferences round-trip', () => {
  beforeEach(() => {
    installStorage();
    clearApiKey();
  });

  it('restores what was saved', () => {
    const preferences: ExplanationPreferences = {
      mode: 'LOCAL_AI',
      localBaseUrl: 'http://127.0.0.1:11434',
      localModel: 'qwen2.5',
      provider: 'OPENROUTER',
      userModel: 'openrouter/auto',
      userBaseUrl: 'https://example.test/v1',
    };
    savePreferences(preferences);
    expect(loadPreferences()).toEqual(preferences);
  });

  it('falls back to the defaults when storage holds nonsense', () => {
    const store = installStorage();
    store.set('debtshift:explanation-preferences', '{not json');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects an unknown mode from storage rather than passing it on', () => {
    const store = installStorage();
    store.set('debtshift:explanation-preferences', JSON.stringify({ mode: 'ROGUE_MODE' }));
    expect(loadPreferences().mode).toBe('DETERMINISTIC');
  });

  it('defaults to deterministic, with no model and no key', () => {
    expect(DEFAULT_PREFERENCES.mode).toBe('DETERMINISTIC');
    expect(DEFAULT_PREFERENCES.localModel).toBe('');
    expect(DEFAULT_PREFERENCES.userModel).toBe('');
  });
});

describe('toConfiguration', () => {
  it('sends the deterministic mode by default', () => {
    expect(toConfiguration(DEFAULT_PREFERENCES, '')).toEqual({ mode: 'DETERMINISTIC' });
  });

  it('builds a local configuration when both fields are set', () => {
    expect(
      toConfiguration({ ...DEFAULT_PREFERENCES, mode: 'LOCAL_AI', localModel: 'llama3' }, ''),
    ).toEqual({ mode: 'LOCAL_AI', baseUrl: 'http://127.0.0.1:11434', model: 'llama3' });
  });

  it('falls back to deterministic when a local model is missing', () => {
    expect(toConfiguration({ ...DEFAULT_PREFERENCES, mode: 'LOCAL_AI' }, '')).toEqual({
      mode: 'DETERMINISTIC',
    });
  });

  it('builds a user-API configuration with the in-memory key', () => {
    expect(
      toConfiguration(
        { ...DEFAULT_PREFERENCES, mode: 'USER_API', provider: 'OPENAI', userModel: 'gpt-4o' },
        'sk-live',
      ),
    ).toEqual({ mode: 'USER_API', provider: 'OPENAI', model: 'gpt-4o', apiKey: 'sk-live' });
  });

  it('omits baseUrl entirely rather than sending an empty one', () => {
    const config = toConfiguration(
      { ...DEFAULT_PREFERENCES, mode: 'USER_API', userModel: 'gpt-4o', userBaseUrl: '   ' },
      'sk-live',
    );
    expect(Object.keys(config)).not.toContain('baseUrl');
  });

  it('includes a custom baseUrl when one is given', () => {
    const config = toConfiguration(
      {
        ...DEFAULT_PREFERENCES,
        mode: 'USER_API',
        provider: 'CUSTOM',
        userModel: 'local',
        userBaseUrl: 'https://example.test/v1',
      },
      'sk-live',
    );
    expect(config).toMatchObject({ baseUrl: 'https://example.test/v1' });
  });

  it('falls back to deterministic rather than sending a keyless USER_API request', () => {
    // Losing the comparison because the key was forgotten on reload would be a
    // worse outcome than silently describing the result deterministically.
    expect(
      toConfiguration({ ...DEFAULT_PREFERENCES, mode: 'USER_API', userModel: 'gpt-4o' }, ''),
    ).toEqual({ mode: 'DETERMINISTIC' });
  });

  it('trims whitespace out of a model name', () => {
    expect(
      toConfiguration(
        { ...DEFAULT_PREFERENCES, mode: 'USER_API', userModel: '  gpt-4o  ' },
        'sk-live',
      ),
    ).toMatchObject({ model: 'gpt-4o' });
  });
});

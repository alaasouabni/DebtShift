/*
 * Explanation provider settings.
 *
 * The split here is the whole point of the module:
 *
 *   - mode, provider, model and baseUrl are preferences. They persist.
 *   - the API key is a REQUEST-ONLY SECRET. It lives in a module variable for
 *     the lifetime of the tab and is never written to localStorage,
 *     sessionStorage, a cookie, a URL or a log.
 *
 * Reloading the page therefore keeps the user's provider choice and forgets
 * their key, which is the correct trade and is stated on the settings screen.
 */

import type { ExplanationConfiguration } from '../../lib/api/types';

export type ExplanationMode = 'DETERMINISTIC' | 'LOCAL_AI' | 'USER_API';
export type UserApiProvider = 'OPENAI' | 'OPENROUTER' | 'CUSTOM';

export interface ExplanationPreferences {
  readonly mode: ExplanationMode;
  readonly localBaseUrl: string;
  readonly localModel: string;
  readonly provider: UserApiProvider;
  readonly userModel: string;
  readonly userBaseUrl: string;
}

export const DEFAULT_PREFERENCES: ExplanationPreferences = {
  mode: 'DETERMINISTIC',
  localBaseUrl: 'http://127.0.0.1:11434',
  localModel: '',
  provider: 'OPENAI',
  userModel: '',
  userBaseUrl: '',
};

const STORAGE_KEY = 'debtshift:explanation-preferences';

/**
 * The user's API key.
 *
 * Module scope, deliberately. Not React state, so it is not serialized into a
 * server payload or a devtools snapshot of the tree; not storage, so it does
 * not survive a reload.
 */
let apiKeyInMemory = '';

export function setApiKey(value: string): void {
  apiKeyInMemory = value;
}

export function hasApiKey(): boolean {
  return apiKeyInMemory !== '';
}

export function clearApiKey(): void {
  apiKeyInMemory = '';
}

function isMode(value: unknown): value is ExplanationMode {
  return value === 'DETERMINISTIC' || value === 'LOCAL_AI' || value === 'USER_API';
}

function isProvider(value: unknown): value is UserApiProvider {
  return value === 'OPENAI' || value === 'OPENROUTER' || value === 'CUSTOM';
}

export function loadPreferences(): ExplanationPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      mode: isMode(parsed.mode) ? parsed.mode : DEFAULT_PREFERENCES.mode,
      localBaseUrl:
        typeof parsed.localBaseUrl === 'string'
          ? parsed.localBaseUrl
          : DEFAULT_PREFERENCES.localBaseUrl,
      localModel: typeof parsed.localModel === 'string' ? parsed.localModel : '',
      provider: isProvider(parsed.provider) ? parsed.provider : DEFAULT_PREFERENCES.provider,
      userModel: typeof parsed.userModel === 'string' ? parsed.userModel : '',
      userBaseUrl: typeof parsed.userBaseUrl === 'string' ? parsed.userBaseUrl : '',
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: ExplanationPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    // Only these six fields are ever written. The key is not among them, and a
    // test asserts that the serialized value cannot contain it.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: preferences.mode,
        localBaseUrl: preferences.localBaseUrl,
        localModel: preferences.localModel,
        provider: preferences.provider,
        userModel: preferences.userModel,
        userBaseUrl: preferences.userBaseUrl,
      }),
    );
  } catch {
    // A storage quota or a privacy mode refusal must not break the app.
  }
}

/**
 * Build the configuration to send with a route-analysis request.
 *
 * Falls back to DETERMINISTIC whenever the chosen mode is not fully configured,
 * because a half-filled LOCAL_AI or USER_API request would be rejected by the
 * backend and the user would lose their comparison for no reason.
 */
export function toConfiguration(
  preferences: ExplanationPreferences,
  apiKey: string = apiKeyInMemory,
): ExplanationConfiguration {
  if (preferences.mode === 'LOCAL_AI') {
    if (preferences.localBaseUrl.trim() === '' || preferences.localModel.trim() === '') {
      return { mode: 'DETERMINISTIC' };
    }
    return {
      mode: 'LOCAL_AI',
      baseUrl: preferences.localBaseUrl.trim(),
      model: preferences.localModel.trim(),
    };
  }

  if (preferences.mode === 'USER_API') {
    if (preferences.userModel.trim() === '' || apiKey === '') {
      return { mode: 'DETERMINISTIC' };
    }
    const base = {
      mode: 'USER_API' as const,
      provider: preferences.provider,
      model: preferences.userModel.trim(),
      apiKey,
    };
    return preferences.userBaseUrl.trim() === ''
      ? base
      : { ...base, baseUrl: preferences.userBaseUrl.trim() };
  }

  return { mode: 'DETERMINISTIC' };
}

/** The configuration for the current preferences and in-memory key. */
export function readExplanationSettings(): ExplanationConfiguration {
  return toConfiguration(loadPreferences());
}

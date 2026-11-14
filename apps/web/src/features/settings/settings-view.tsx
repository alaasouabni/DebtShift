'use client';

/*
 * `/settings` — the explanation provider.
 *
 * Deterministic is the default and needs nothing. The two model-backed modes
 * are deliberately subordinate: they change the words on the route screen and
 * nothing else, and the page says so in the place where a user might assume
 * otherwise.
 *
 * The API key field is `type="password"`, never autofilled, never echoed back
 * from the server, and never persisted — see `explanation-settings.ts`.
 */

import { useCallback, useEffect, useState } from 'react';

import { Alert, Badge, Button, SectionRule, Section } from '../../components/ui';
import {
  clearApiKey,
  DEFAULT_PREFERENCES,
  hasApiKey,
  loadPreferences,
  savePreferences,
  setApiKey,
  toConfiguration,
  type ExplanationMode,
  type ExplanationPreferences,
  type UserApiProvider,
} from './explanation-settings';

const MODES: { readonly id: ExplanationMode; readonly title: string; readonly body: string }[] = [
  {
    id: 'DETERMINISTIC',
    title: 'Deterministic',
    body: 'Sentences generated from the backend result itself. No model, no key, no third party. This is the default.',
  },
  {
    id: 'LOCAL_AI',
    title: 'A local model',
    body: 'An Ollama-compatible endpoint on this machine. The request never leaves your network.',
  },
  {
    id: 'USER_API',
    title: 'Your own API key',
    body: 'OpenAI, OpenRouter, or a custom HTTPS endpoint the backend has enabled. The key is sent through the DebtShift backend for that one request.',
  },
];

const PROVIDERS: readonly UserApiProvider[] = ['OPENAI', 'OPENROUTER', 'CUSTOM'];

export function SettingsView() {
  const [preferences, setPreferences] = useState<ExplanationPreferences>(DEFAULT_PREFERENCES);
  const [keyInput, setKeyInput] = useState('');
  const [keyHeld, setKeyHeld] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPreferences(loadPreferences());
    setKeyHeld(hasApiKey());
  }, []);

  const update = useCallback((patch: Partial<ExplanationPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      savePreferences(next);
      return next;
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, []);

  const applyKey = useCallback(() => {
    setApiKey(keyInput);
    setKeyHeld(keyInput !== '');
    setKeyInput('');
    setRevealKey(false);
  }, [keyInput]);

  const forgetKey = useCallback(() => {
    clearApiKey();
    setKeyHeld(false);
    setKeyInput('');
  }, []);

  const effective = toConfiguration(preferences, keyHeld ? 'present' : '');

  return (
    <>
      <section
        className="page hero"
        style={{
          padding: '96px var(--page-gutter) 56px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <p className="eyebrow">Explanation settings</p>
        <h1
          className="hero__title"
          style={{
            margin: 0,
            fontSize: 72,
            lineHeight: '76px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            maxWidth: 1000,
          }}
        >
          Who writes the words.{' '}
          <span style={{ color: 'var(--ink-muted)' }}>Never who picks the route.</span>
        </h1>
        <p
          className="hero__lede"
          style={{
            margin: 0,
            fontSize: 22,
            lineHeight: '32px',
            color: 'var(--ink-muted)',
            maxWidth: 760,
          }}
        >
          A model can describe the deterministic result in different words. It cannot change the
          decision hash, eligibility, ranking, an amount, a hash, a signature or an execution.
        </p>

        {saved ? <Badge tone="success">Saved</Badge> : null}
      </section>

      <SectionRule />

      <Section
        id="mode"
        number="01"
        title="The provider"
        note="Deterministic needs nothing and is always available. The other two are optional."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {MODES.map((mode) => {
            const selected = preferences.mode === mode.id;
            return (
              <label
                key={mode.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-4)',
                  alignItems: 'flex-start',
                  padding: 'var(--space-5)',
                  background: selected ? 'var(--accent-soft)' : 'var(--surface-raised)',
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 'var(--radius-lg)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="explanation-mode"
                  value={mode.id}
                  checked={selected}
                  onChange={() => update({ mode: mode.id })}
                  style={{ marginTop: 4, accentColor: 'var(--accent)' }}
                />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 17, lineHeight: '24px', fontWeight: 600 }}>
                    {mode.title}
                    {mode.id === 'DETERMINISTIC' ? (
                      <span style={{ fontWeight: 400, color: 'var(--ink-muted)' }}> · default</span>
                    ) : null}
                  </span>
                  <span style={{ fontSize: 15, lineHeight: '22px', color: 'var(--ink-muted)' }}>
                    {mode.body}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </Section>

      {preferences.mode === 'LOCAL_AI' ? (
        <>
          <SectionRule />
          <Section
            id="local"
            number="02"
            title="The local endpoint"
            note="An Ollama-compatible server. Nothing leaves your machine."
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
                maxWidth: 520,
              }}
            >
              <label className="dsh-field">
                <span className="dsh-field__label">Base URL</span>
                <span className="dsh-field__control">
                  <input
                    className="dsh-field__input"
                    value={preferences.localBaseUrl}
                    onChange={(changed) => update({ localBaseUrl: changed.target.value })}
                    placeholder="http://127.0.0.1:11434"
                    spellCheck={false}
                  />
                </span>
              </label>
              <label className="dsh-field">
                <span className="dsh-field__label">Model</span>
                <span className="dsh-field__control">
                  <input
                    className="dsh-field__input"
                    value={preferences.localModel}
                    onChange={(changed) => update({ localModel: changed.target.value })}
                    placeholder="llama3.2"
                    spellCheck={false}
                  />
                </span>
                <p className="dsh-field__hint">
                  Leave the model empty and DebtShift falls back to the deterministic explanation
                  rather than sending an incomplete request.
                </p>
              </label>
            </div>
          </Section>
        </>
      ) : null}

      {preferences.mode === 'USER_API' ? (
        <>
          <SectionRule />
          <Section
            id="user-api"
            number="02"
            title="Your API key"
            note="A request-only secret. It is held in this tab's memory and nowhere else."
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
                maxWidth: 560,
              }}
            >
              <Alert tone="warning" title="This key is sent through the DebtShift backend">
                In this mode the backend makes the model request on your behalf, so the key leaves
                your browser for that one request. It is never written to storage, a URL, a log or a
                repository file, and a page reload forgets it.
              </Alert>

              <label className="dsh-field">
                <span className="dsh-field__label">Provider</span>
                <span className="dsh-field__control">
                  <select
                    className="dsh-field__input"
                    value={preferences.provider}
                    onChange={(changed) =>
                      update({ provider: changed.target.value as UserApiProvider })
                    }
                  >
                    {PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </span>
              </label>

              <label className="dsh-field">
                <span className="dsh-field__label">Model</span>
                <span className="dsh-field__control">
                  <input
                    className="dsh-field__input"
                    value={preferences.userModel}
                    onChange={(changed) => update({ userModel: changed.target.value })}
                    placeholder="gpt-4o-mini"
                    spellCheck={false}
                  />
                </span>
              </label>

              {preferences.provider === 'CUSTOM' ? (
                <label className="dsh-field">
                  <span className="dsh-field__label">Custom HTTPS endpoint</span>
                  <span className="dsh-field__control">
                    <input
                      className="dsh-field__input"
                      value={preferences.userBaseUrl}
                      onChange={(changed) => update({ userBaseUrl: changed.target.value })}
                      placeholder="https://…"
                      spellCheck={false}
                    />
                  </span>
                  <p className="dsh-field__hint">
                    The backend only accepts a custom endpoint when it has been explicitly enabled.
                  </p>
                </label>
              ) : null}

              <div className="dsh-field">
                <label className="dsh-field__label" htmlFor="explanation-api-key">
                  API key
                </label>
                <span className="dsh-field__control">
                  <input
                    id="explanation-api-key"
                    aria-describedby="explanation-api-key-hint"
                    className="dsh-field__input"
                    type={revealKey ? 'text' : 'password'}
                    value={keyInput}
                    onChange={(changed) => setKeyInput(changed.target.value)}
                    placeholder={keyHeld ? 'A key is held in memory' : 'sk-…'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="dsh-field__affix"
                    onClick={() => setRevealKey((value) => !value)}
                    style={{
                      background: 'none',
                      border: 0,
                      cursor: 'pointer',
                      color: 'var(--accent-strong)',
                    }}
                  >
                    {revealKey ? 'Hide' : 'Show'}
                    <span className="visually-hidden"> API key</span>
                  </button>
                </span>
                <p className="dsh-field__hint" id="explanation-api-key-hint">
                  {keyHeld
                    ? 'A key is held for this tab. Reloading forgets it.'
                    : 'Nothing is held yet. Requests fall back to the deterministic explanation.'}
                </p>
                <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                  <Button size="sm" onClick={applyKey} disabled={keyInput === ''}>
                    Hold this key for this tab
                  </Button>
                  {keyHeld ? (
                    <Button size="sm" variant="secondary" onClick={forgetKey}>
                      Forget it now
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </Section>
        </>
      ) : null}

      <SectionRule />

      <Section
        id="effective"
        number={preferences.mode === 'DETERMINISTIC' ? '02' : '03'}
        title="What will be sent"
        note="The configuration attached to the next route-analysis request."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 'var(--space-4)',
              background: 'var(--surface-raised)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              overflowX: 'auto',
              fontSize: 13,
            }}
          >
            {JSON.stringify(
              // The real key is never rendered, even to its owner, even here.
              'apiKey' in effective ? { ...effective, apiKey: '«held in memory»' } : effective,
              null,
              2,
            )}
          </pre>

          {preferences.mode !== 'DETERMINISTIC' && effective.mode === 'DETERMINISTIC' ? (
            <Alert tone="warning" title="Falling back to deterministic">
              The chosen mode is not fully configured, so DebtShift will send the deterministic
              configuration rather than a request the backend would reject.
            </Alert>
          ) : null}

          <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--ink-muted)' }}>
            Whatever this says, the route result is identical. If a model request fails the
            deterministic explanation is returned and the route screen marks it as a fallback.
          </p>
        </div>
      </Section>
    </>
  );
}

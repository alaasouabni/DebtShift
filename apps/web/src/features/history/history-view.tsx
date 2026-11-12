'use client';

/*
 * `/history` — diagnostics.
 *
 * Explicitly NOT the authoritative position view. These rows come from
 * `GET /positions/:wallet/history`, which reads persisted database rows via a
 * left join, so `snapshot` can legitimately be null. The live position lives
 * at `/position` and this page says so rather than letting a stale row look
 * current.
 */

import { useCallback, useEffect, useState } from 'react';

import { Alert, Badge, Button, ButtonLink, SectionRule, Section } from '../../components/ui';
import { HashValue } from '../../components/shell';
import { ApiError, api } from '../../lib/api/client';
import type { MarketRow, PersistedPositionRow } from '../../lib/api/types';
import { formatTimestamp, truncateHex } from '../../lib/formatting';
import { MIGRATION_STORAGE_KEY } from '../../lib/storage-keys';
import { isConnected, useWallet } from '../wallet/wallet-context';

interface LoadState {
  readonly kind: 'idle' | 'loading' | 'ready' | 'error';
  readonly rows?: readonly PersistedPositionRow[] | undefined;
  readonly markets?: readonly MarketRow[] | undefined;
  readonly error?: ApiError | undefined;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (record === null) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  if (record === null) return undefined;
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

export function HistoryView() {
  const wallet = useWallet();
  const connected = isConnected(wallet);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [lastMigration, setLastMigration] = useState<string | undefined>(undefined);

  useEffect(() => {
    try {
      setLastMigration(window.localStorage.getItem(MIGRATION_STORAGE_KEY) ?? undefined);
    } catch {
      setLastMigration(undefined);
    }
  }, []);

  const load = useCallback(async (account: string) => {
    setState({ kind: 'loading' });
    try {
      const [rows, markets] = await Promise.all([
        api.positionHistory(account),
        api.markets().catch(() => [] as MarketRow[]),
      ]);
      setState({ kind: 'ready', rows, markets });
    } catch (caught) {
      setState({ kind: 'error', error: caught instanceof ApiError ? caught : undefined });
    }
  }, []);

  useEffect(() => {
    if (!connected) {
      setState({ kind: 'idle' });
      return;
    }
    void load(wallet.account);
  }, [connected, wallet.account, wallet.accountEpoch, load]);

  if (!connected) {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <p className="eyebrow">Diagnostics</p>
        <h1 style={{ margin: '24px 0 0', fontSize: 40, lineHeight: '48px' }}>
          Connect a wallet to see its history.
        </h1>
        <div style={{ marginTop: 24 }}>
          <Button onClick={() => void wallet.connect()} disabled={wallet.status === 'unavailable'}>
            Connect wallet
          </Button>
        </div>
      </section>
    );
  }

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
        <p className="eyebrow">Diagnostics</p>
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
          What the database remembers.
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
          Persisted rows, not a live reading. Nothing on this page should be used to decide anything
          — the authoritative position is on its own screen.
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <ButtonLink href="/position" variant="secondary">
            The live position
          </ButtonLink>
          <Button variant="ghost" onClick={() => void load(wallet.account)}>
            Reload
          </Button>
        </div>
      </section>

      <SectionRule />

      <Section
        id="migrations"
        number="01"
        title="Migrations from this browser"
        note="The ids this browser kept so a refresh could resume monitoring. Signatures and prepared payloads are never kept."
      >
        {lastMigration === undefined ? (
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            No migration has been started from this browser yet.
          </p>
        ) : (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-4)',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 'var(--space-5)',
              background: 'var(--surface-raised)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <HashValue value={lastMigration} label="migration ID" />
            <ButtonLink href={`/migrations/${lastMigration}`} size="sm">
              Open the monitor
            </ButtonLink>
          </div>
        )}
      </Section>

      <SectionRule />

      <Section
        id="positions"
        number="02"
        title="Persisted positions"
        note="Rows joined from positions, markets and the latest snapshot. A snapshot can be absent."
      >
        {state.kind === 'loading' || state.kind === 'idle' ? (
          <p aria-busy="true" style={{ margin: 0, color: 'var(--ink-muted)' }}>
            Reading the history…
          </p>
        ) : state.kind === 'error' ? (
          <Alert
            tone="danger"
            title="The history could not be read"
            action={
              <Button size="sm" variant="secondary" onClick={() => void load(wallet.account)}>
                Retry
              </Button>
            }
          >
            {state.error?.message ?? 'An unexpected error occurred.'}
          </Alert>
        ) : (state.rows ?? []).length === 0 ? (
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            No persisted position for <span className="mono">{truncateHex(wallet.account)}</span>.
          </p>
        ) : (
          <ol
            style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '2px solid var(--ink)' }}
          >
            {(state.rows ?? []).map((row, index) => {
              const snapshot = (row.snapshot ?? null) as Record<string, unknown> | null;
              const market = row.market as Record<string, unknown>;
              const position = row.position as Record<string, unknown>;
              const updatedAt = readString(position, 'updatedAt');
              return (
                <li
                  key={readString(position, 'positionId') ?? String(index)}
                  style={{ padding: '18px 0', borderBottom: '1px solid var(--line)' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      gap: '4px 24px',
                      alignItems: 'baseline',
                    }}
                  >
                    <span style={{ fontSize: 17, lineHeight: '24px', fontWeight: 600 }}>
                      {readString(market, 'protocol')?.replace(/_/gu, ' ') ?? 'Unknown market'}
                      {readNumber(market, 'chainId') === undefined
                        ? ''
                        : ` · chain ${readNumber(market, 'chainId')}`}
                    </span>
                    {snapshot === null ? (
                      <Badge tone="neutral">No snapshot</Badge>
                    ) : (
                      <Badge tone="accent">Snapshot stored</Badge>
                    )}
                  </div>
                  <p
                    className="mono"
                    style={{ margin: '4px 0 0', color: 'var(--ink-muted)', wordBreak: 'break-all' }}
                  >
                    {readString(market, 'marketId') ?? ''}
                  </p>
                  {updatedAt ? (
                    <p
                      className="num"
                      style={{ margin: 0, fontSize: 13, color: 'var(--ink-muted)' }}
                    >
                      updated {formatTimestamp(updatedAt)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      <SectionRule />

      <Section
        id="markets"
        number="03"
        title="Enabled markets"
        note="From GET /markets. These are the markets the backend will consider."
      >
        {(state.markets ?? []).length === 0 ? (
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>No enabled market was returned.</p>
        ) : (
          <ol
            style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '2px solid var(--ink)' }}
          >
            {(state.markets ?? []).map((market, index) => (
              <li
                key={`${String(market.chainId)}-${String(market.marketId)}-${index}`}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: '4px 24px',
                  padding: '14px 0',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {String(market.protocol).replace(/_/gu, ' ')} · chain {market.chainId}
                </span>
                <span
                  className="mono"
                  style={{ color: 'var(--ink-muted)', wordBreak: 'break-all' }}
                >
                  {String(market.marketId)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}

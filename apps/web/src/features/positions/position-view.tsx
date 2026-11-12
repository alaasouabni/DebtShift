'use client';

/*
 * `/position` — the live source position with its provenance.
 *
 * Provenance gets as much space as the amounts on purpose. The product's claim
 * is that nothing on the screen is estimated, and the only way to make that
 * checkable is to show the block, the hash, the observation time and the
 * snapshot id next to the figures they produced.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '../../lib/api/client';
import type { PositionSnapshot } from '../../lib/api/types';
import {
  formatAmount,
  formatBps,
  formatBaseUnits,
  formatDuration,
  formatInteger,
  formatRelativeAge,
  formatTimestamp,
  formatWad,
  secondsSince,
} from '../../lib/formatting/index';
import { Alert, Badge, Button, ButtonLink, SectionRule } from '../../components/ui/index';
import { HashValue } from '../../components/shell/index';
import { isConnected, useWallet } from '../wallet/wallet-context';

/*
 * The simulator policy's freshness window, from
 * `apps/api/src/simulator/local-market-tools.service.ts:138`
 * (maxPositionSnapshotAgeSeconds: 30).
 *
 * This is a DISPLAY heuristic only, mirrored here so the page can warn before
 * the user wastes a click. The backend owns the real decision and will reject a
 * route with SOURCE_POSITION_STALE whatever this page shows — the caption says
 * so. Do not grow this into a second copy of the policy.
 */
const DISPLAY_FRESHNESS_WINDOW_SECONDS = 30;

interface LoadState {
  readonly kind: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  readonly snapshot?: PositionSnapshot | undefined;
  readonly error?: ApiError | undefined;
}

function healthBand(factorWad: string): { label: string; tone: 'success' | 'warning' | 'danger' } {
  const factor = BigInt(factorWad);
  if (factor < 1_000_000_000_000_000_000n) return { label: 'liquidatable', tone: 'danger' };
  if (factor < 1_250_000_000_000_000_000n) return { label: 'thin', tone: 'danger' };
  if (factor < 2_000_000_000_000_000_000n) return { label: 'moderate', tone: 'warning' };
  return { label: 'comfortable', tone: 'success' };
}

/** Position of the health marker on the 0 → 3 scale, as a percentage. */
function healthMarkerPercent(factorWad: string): number {
  const scaled = (BigInt(factorWad) * 10_000n) / 3_000_000_000_000_000_000n;
  const clamped = scaled > 10_000n ? 10_000n : scaled;
  return Number(clamped) / 100;
}

export function PositionView() {
  const wallet = useWallet();
  const connected = isConnected(wallet);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [showRaw, setShowRaw] = useState(false);
  // Re-renders the age so the countdown moves without refetching.
  const [, setTick] = useState(0);

  const load = useCallback(async (account: string) => {
    setState({ kind: 'loading' });
    try {
      const snapshot = await api.position(account);
      setState(snapshot === undefined ? { kind: 'empty' } : { kind: 'ready', snapshot });
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : undefined;
      /*
       * The backend answers a wallet with no supported position with HTTP 400
       * ("No supported local source position was found for this wallet."),
       * not with an empty list. Observed on the live stack once a migration
       * had consumed the seeded position. Treating that as a failure would
       * show a red error for what is an ordinary state, so a validation
       * answer here is the empty state, with the backend's own sentence kept
       * on screen.
       */
      if (error?.code === 'VALIDATION') {
        setState({ kind: 'empty', error });
        return;
      }
      setState({ kind: 'error', error });
    }
  }, []);

  useEffect(() => {
    if (!connected) {
      setState({ kind: 'idle' });
      return;
    }
    void load(wallet.account);
  }, [connected, wallet.account, wallet.accountEpoch, load]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!connected) {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <div
          style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <p className="eyebrow">Source position</p>
          <h1 style={{ margin: 0, fontSize: 40, lineHeight: '48px', letterSpacing: '-0.015em' }}>
            Connect a wallet to read your loan.
          </h1>
          <p style={{ margin: 0, fontSize: 18, lineHeight: '28px', color: 'var(--ink-muted)' }}>
            DebtShift reads the position for the account you authorize. It never asks for a key.
          </p>
          <div>
            <Button
              onClick={() => void wallet.connect()}
              disabled={wallet.status === 'unavailable'}
            >
              Connect wallet
            </Button>
          </div>
          {wallet.status === 'unavailable' ? (
            <Alert tone="warning" title="No browser wallet detected">
              Install a wallet that supports EIP-1193, then reload.
            </Alert>
          ) : null}
        </div>
      </section>
    );
  }

  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <p className="eyebrow">Source position</p>
        <h1
          aria-busy="true"
          style={{
            margin: '24px 0 0',
            fontSize: 40,
            lineHeight: '48px',
            color: 'var(--ink-muted)',
          }}
        >
          Reading your position…
        </h1>
      </section>
    );
  }

  if (state.kind === 'error') {
    const unreachable = state.error?.code === 'NETWORK' || state.error?.code === 'TIMEOUT';
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <div
          style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <p className="eyebrow">Source position</p>
          <Alert
            tone="danger"
            title={unreachable ? 'The API could not be reached' : 'The position could not be read'}
            action={
              <Button size="sm" variant="secondary" onClick={() => void load(wallet.account)}>
                Retry
              </Button>
            }
          >
            {state.error?.message ?? 'An unexpected error occurred.'}
            {state.error?.status ? (
              <>
                {' '}
                <span className="mono">HTTP {state.error.status}</span>
              </>
            ) : null}
          </Alert>
        </div>
      </section>
    );
  }

  if (state.kind === 'empty') {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <div
          style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <p className="eyebrow">Source position</p>
          <h1 style={{ margin: 0, fontSize: 40, lineHeight: '48px', letterSpacing: '-0.015em' }}>
            No refinanceable position for this account.
          </h1>
          <p style={{ margin: 0, fontSize: 18, lineHeight: '28px', color: 'var(--ink-muted)' }}>
            DebtShift found no supported loan for <span className="mono">{wallet.account}</span> on
            an enabled source market. A position qualifies when it is on an enabled market, has debt
            outstanding, and has collateral backing it.
          </p>
          {state.error ? (
            <p className="mono" style={{ margin: 0, color: 'var(--ink-muted)' }}>
              Backend: {state.error.message} · HTTP {state.error.status}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => void load(wallet.account)}>
              Check again
            </Button>
            <ButtonLink href="/history" variant="ghost">
              See past positions
            </ButtonLink>
          </div>
        </div>
      </section>
    );
  }

  const snapshot = state.snapshot!;
  const { position } = snapshot;
  const collateral = position.collateralAsset;
  const debt = position.debtAsset;
  const age = secondsSince(snapshot.block.observedAt);
  const remaining = Math.max(0, DISPLAY_FRESHNESS_WINDOW_SECONDS - age);
  const stale = remaining === 0;
  const health = snapshot.health;
  const band =
    health.kind === 'AAVE_HEALTH_FACTOR' ? healthBand(health.healthFactorWad) : undefined;

  return (
    <>
      <section
        className="page hero"
        style={{
          padding: '96px var(--page-gutter) 72px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <p className="eyebrow">
          Source position · {position.market.protocol.replace(/_/gu, ' ')} · chain{' '}
          {position.market.chainId}
        </p>
        <h1
          className="hero__title num"
          style={{
            margin: 0,
            fontSize: 80,
            lineHeight: '84px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            maxWidth: 1040,
          }}
        >
          You owe {formatAmount(snapshot.debtUnits, debt.decimals, debt.symbol)}{' '}
          <span style={{ color: 'var(--ink-muted)' }}>
            at {formatBps(snapshot.borrowAprBps)} a year.
          </span>
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
          Backed by {formatAmount(snapshot.collateralUnits, collateral.decimals, collateral.symbol)}
          {health.kind === 'AAVE_HEALTH_FACTOR'
            ? ` with a health factor of ${formatWad(health.healthFactorWad)}`
            : ` at an LTV of ${formatBps(health.ltvBps)} against a ${formatBps(health.lltvBps)} limit`}
          . Read at block {formatInteger(snapshot.block.number)},{' '}
          {formatRelativeAge(snapshot.block.observedAt)} — nothing on this page is estimated.
        </p>

        <div
          className="actions"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
            alignItems: 'center',
            marginTop: 8,
          }}
        >
          <ButtonLink href="/routes">Compare routes</ButtonLink>
          <Button
            variant="secondary"
            onClick={() => setShowRaw((value) => !value)}
            aria-pressed={showRaw}
          >
            {showRaw ? 'Hide raw values' : 'Show raw values'}
          </Button>
        </div>

        {stale ? (
          <Alert
            tone="warning"
            title="This snapshot has aged past the policy window"
            action={
              <Button size="sm" variant="secondary" onClick={() => void load(wallet.account)}>
                Refresh data
              </Button>
            }
          >
            It was observed {formatRelativeAge(snapshot.block.observedAt)}. The backend will reject
            every route with <span className="mono">SOURCE_POSITION_STALE</span> until a newer block
            is read. On the local stack this usually means Anvil has mined no block while idle
            rather than that anything is wrong.
          </Alert>
        ) : null}
      </section>

      <SectionRule />

      <section aria-labelledby="loan" className="sec">
        <div className="sec__lede">
          <span className="sec__number num">01</span>
          <h2 id="loan" className="sec__title">
            The loan
          </h2>
          <p className="sec__note">
            {position.market.protocol.replace(/_/gu, ' ')} · {collateral.symbol} / {debt.symbol}.
            Market <span className="mono">{position.market.marketId.slice(0, 10)}…</span>,
            deployment <span className="mono">{position.market.deployment.slice(0, 10)}…</span>.
          </p>
          <div>
            <Badge tone="success">Refinanceable</Badge>
          </div>
        </div>

        <dl className="facts sec__body">
          <div className="facts__row facts__row--first">
            <dt className="facts__key">Collateral</dt>
            <dd className="facts__value">
              <span className="num facts__amount">
                {formatBaseUnits(snapshot.collateralUnits, collateral.decimals)}{' '}
                <span className="facts__unit">{collateral.symbol}</span>
              </span>
              {showRaw ? (
                <>
                  <br />
                  <span className="mono facts__raw">
                    {snapshot.collateralUnits} · {collateral.decimals} decimals
                  </span>
                </>
              ) : null}
            </dd>
          </div>

          <div className="facts__row">
            <dt className="facts__key">Debt</dt>
            <dd className="facts__value">
              <span className="num facts__amount">
                {formatBaseUnits(snapshot.debtUnits, debt.decimals)}{' '}
                <span className="facts__unit">{debt.symbol}</span>
              </span>
              {showRaw ? (
                <>
                  <br />
                  <span className="mono facts__raw">
                    {snapshot.debtUnits} · {debt.decimals} decimals
                  </span>
                </>
              ) : null}
            </dd>
          </div>

          <div className="facts__row">
            <dt className="facts__key">Borrow rate</dt>
            <dd className="facts__value">
              <span className="num facts__figure">{formatBps(snapshot.borrowAprBps)} APR</span>
              {showRaw ? (
                <>
                  <br />
                  <span className="mono facts__raw">borrowAprBps {snapshot.borrowAprBps}</span>
                </>
              ) : null}
            </dd>
          </div>

          <div
            className="facts__row facts__row--stacked"
            style={{ borderBottom: '1px solid var(--line)' }}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 'var(--space-2) var(--space-5)',
              }}
            >
              <dt className="facts__key">
                {health.kind === 'AAVE_HEALTH_FACTOR' ? 'Health factor' : 'Loan to value'}
              </dt>
              <dd className="num facts__figure" style={{ margin: 0 }}>
                {health.kind === 'AAVE_HEALTH_FACTOR' ? (
                  <>
                    {formatWad(health.healthFactorWad)}{' '}
                    <span style={{ fontWeight: 400, color: 'var(--ink-muted)' }}>
                      · {band?.label}
                    </span>
                  </>
                ) : (
                  <>
                    {formatBps(health.ltvBps)}{' '}
                    <span style={{ fontWeight: 400, color: 'var(--ink-muted)' }}>
                      · limit {formatBps(health.lltvBps)}
                    </span>
                  </>
                )}
              </dd>
            </div>

            {health.kind === 'AAVE_HEALTH_FACTOR' ? (
              <>
                <div
                  role="img"
                  aria-label={`Health factor ${formatWad(health.healthFactorWad)} on a scale from 0 to 3. Liquidation below 1.00; moderate band from 1.25 to 2.00.`}
                  style={{
                    position: 'relative',
                    height: 8,
                    marginTop: 8,
                    display: 'flex',
                    gap: 2,
                  }}
                >
                  <span
                    style={{ flex: 1, background: 'var(--danger)', borderRadius: '4px 0 0 4px' }}
                  />
                  <span style={{ flex: 1, background: 'var(--warning)' }} />
                  <span style={{ flex: 2, background: 'var(--line-strong)' }} />
                  <span
                    style={{ flex: 2, background: 'var(--success)', borderRadius: '0 4px 4px 0' }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      left: `${healthMarkerPercent(health.healthFactorWad)}%`,
                      top: -8,
                      width: 4,
                      height: 24,
                      marginLeft: -2,
                      background: 'var(--ink)',
                      borderRadius: 2,
                      boxShadow: '0 0 0 2px var(--surface)',
                    }}
                  />
                </div>
                <div
                  className="num"
                  aria-hidden="true"
                  style={{
                    position: 'relative',
                    height: 16,
                    fontSize: 12,
                    lineHeight: '16px',
                    color: 'var(--ink-muted)',
                  }}
                >
                  <span style={{ position: 'absolute', left: 0 }}>0</span>
                  <span
                    style={{ position: 'absolute', left: '16.67%', transform: 'translateX(-50%)' }}
                  >
                    1.00
                  </span>
                  <span
                    style={{ position: 'absolute', left: '33.33%', transform: 'translateX(-50%)' }}
                  >
                    1.25
                  </span>
                  <span
                    style={{ position: 'absolute', left: '66.67%', transform: 'translateX(-50%)' }}
                  >
                    2.00
                  </span>
                  <span style={{ position: 'absolute', right: 0 }}>3.00+</span>
                </div>
                <p
                  style={{ margin: 0, fontSize: 13, lineHeight: '18px', color: 'var(--ink-muted)' }}
                >
                  Liquidation below 1.00. Bands are display labels; the backend&apos;s value is
                  authoritative.
                </p>
                {showRaw ? (
                  <span className="mono facts__raw">
                    AAVE_HEALTH_FACTOR · healthFactorWad {health.healthFactorWad}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </dl>
      </section>

      <SectionRule />

      <section aria-labelledby="provenance" className="sec" style={{ paddingBottom: 96 }}>
        <div className="sec__lede">
          <span className="sec__number num">02</span>
          <h2 id="provenance" className="sec__title">
            Where it comes from
          </h2>
          <p className="sec__note">
            Routes are only compared while this snapshot sits inside the policy&apos;s freshness
            window.
          </p>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {stale ? (
              <Badge tone="warning">
                Stale · past the {DISPLAY_FRESHNESS_WINDOW_SECONDS} s window
              </Badge>
            ) : (
              <Badge tone="success">Fresh · {formatDuration(remaining)} left</Badge>
            )}
            <Button variant="ghost" size="sm" onClick={() => void load(wallet.account)}>
              Refresh data
            </Button>
          </div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: '18px', color: 'var(--ink-muted)' }}>
            The {DISPLAY_FRESHNESS_WINDOW_SECONDS} s window is the simulator policy&apos;s, shown
            here as a courtesy. The backend decides, and it fails closed.
          </p>
        </div>

        <dl className="grid-facts sec__body">
          <dt>Block</dt>
          <dd className="num" style={{ fontWeight: 600 }}>
            {formatInteger(snapshot.block.number)}
          </dd>

          <dt>Block hash</dt>
          <dd className="is-control">
            <HashValue value={snapshot.block.hash} label="block hash" />
          </dd>

          <dt>Observed</dt>
          <dd className="num">
            <strong>{formatRelativeAge(snapshot.block.observedAt)}</strong>{' '}
            <span style={{ color: 'var(--ink-muted)' }}>
              · {formatTimestamp(snapshot.block.observedAt)}
            </span>
          </dd>

          <dt>Snapshot</dt>
          <dd className="is-control">
            <HashValue value={snapshot.snapshotId} label="snapshot ID" />
          </dd>

          <dt>Borrower</dt>
          <dd className="mono" style={{ fontSize: 15, wordBreak: 'break-all' }}>
            {position.borrower}
          </dd>

          <dt>Collateral asset</dt>
          <dd className="mono" style={{ fontSize: 15, wordBreak: 'break-all' }}>
            {collateral.symbol} · {collateral.address}
          </dd>

          <dt>Debt asset</dt>
          <dd className="mono" style={{ fontSize: 15, wordBreak: 'break-all' }}>
            {debt.symbol} · {debt.address}
          </dd>
        </dl>
      </section>
    </>
  );
}

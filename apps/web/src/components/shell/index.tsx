'use client';

/*
 * The application shell: header with the environment badge and wallet control,
 * and a footer carrying the API health dot and the key statement.
 *
 * The environment badge is deliberately part of the shell and not of a page:
 * the contract requires it to stay visible throughout preparation, signing and
 * monitoring, so there is no route that can accidentally drop it.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../../lib/api/client';
import { chainLabel, isConnected, useWallet } from '../../features/wallet/wallet-context';
import { chainName } from '../../lib/chains';
import { truncateHex } from '../../lib/formatting/index';
import { useEnvironment } from '../../features/environment/environment-context';
import { defaultEnvironmentMode } from '../../lib/environment';
import { ThemeToggle } from '../../features/theme/theme-toggle';
import { Badge, Button } from '../ui/index';
import { DemoTour } from './demo-tour';

const NAV = [
  { href: '/position', label: 'Position' },
  { href: '/routes', label: 'Routes' },
  { href: '/authorize', label: 'Authorize' },
  { href: '/history', label: 'History' },
  { href: '/settings', label: 'Settings' },
] as const;

/* ------------------------------------------------------------ copy control */

export function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="copy-btn"
      title={value}
    >
      {copied ? (
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--success)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m5 13 4 4L19 7" />
        </svg>
      ) : (
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
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h8" />
        </svg>
      )}
    </button>
  );
}

/** A hash with a copy control beside it. */
export function HashValue({
  value,
  label,
  full,
}: {
  readonly value: string;
  readonly label: string;
  readonly full?: boolean;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 'var(--space-3)', alignItems: 'center' }}>
      <span className="mono" style={{ fontSize: 15, wordBreak: full ? 'break-all' : undefined }}>
        {full ? value : truncateHex(value)}
      </span>
      <CopyButton value={value} label={label} />
    </span>
  );
}

/* ------------------------------------------------------- environment badge */

/**
 * The environment label.
 *
 * It shows what the backend last reported. Before any report it shows the
 * label configured for this deployment, and says in its tooltip that the
 * backend has not confirmed it yet. It is never a control: nothing here can
 * change what the backend allows.
 */
export function EnvironmentBadge({ quietUntilReported = false }: { quietUntilReported?: boolean }) {
  const { badge, confirmed } = useEnvironment();
  const { isDemo } = useWallet();
  /*
   * On the landing page, before any backend response, there is nothing to
   * report yet — and "not reported yet" reads like a fault to a first-time
   * visitor. The badge stays out of the way there unless the deployment
   * configured a label, and is always shown once the journey starts.
   */
  if (quietUntilReported && !confirmed && !isDemo && defaultEnvironmentMode() === undefined) {
    return null;
  }
  if (isDemo) {
    return (
      <span data-environment-confirmed="demo">
        <Badge
          tone="warning"
          title="Recorded responses from the contract-backed sandbox. No wallet, no backend, nothing executes."
        >
          Recorded sandbox run
        </Badge>
      </span>
    );
  }
  return (
    <span data-environment-confirmed={confirmed ? 'true' : 'false'}>
      <Badge tone={badge.tone} title={badge.title}>
        {badge.label}
      </Badge>
    </span>
  );
}

/* ------------------------------------------------------------------- header */

export function SiteHeader() {
  const pathname = usePathname();
  const wallet = useWallet();
  const connected = isConnected(wallet);

  return (
    <div className="topbar">
      {wallet.isDemo ? <DemoBanner pathname={pathname} onExit={wallet.exitDemo} /> : null}
      <SiteHeaderBar pathname={pathname} wallet={wallet} connected={connected} />
    </div>
  );
}

/**
 * The strip that stays on every screen of the recorded demo.
 *
 * It is what keeps the demo honest: a judge must never be able to mistake a
 * replay for a live session, on any page, at any scroll position.
 */
function DemoBanner({
  pathname,
  onExit,
}: {
  readonly pathname: string;
  readonly onExit: () => void;
}) {
  return (
    <div className="demo-banner">
      <div className="page demo-banner__inner">
        {/*
          The notice is a live region; the tour beside it is navigation and is
          kept outside it so moving between steps is not read out as an alert.
        */}
        <p role="status" className="demo-banner__notice">
          <strong>Recorded demo.</strong>{' '}
          <span className="demo-banner__long">
            Real responses captured on the contract-backed sandbox, replayed. No wallet is connected
            and nothing is signed or executed.
          </span>
          {/* The same promise in the room a phone has. */}
          <span className="demo-banner__short">Nothing is signed or executed.</span>
        </p>
        <Button variant="secondary" size="sm" onClick={onExit}>
          Exit demo
        </Button>
        <DemoTour pathname={pathname} />
      </div>
    </div>
  );
}

function SiteHeaderBar({
  pathname,
  wallet,
  connected,
}: {
  readonly pathname: string;
  readonly wallet: ReturnType<typeof useWallet>;
  readonly connected: boolean;
}) {
  return (
    <header style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}>
      <div
        className="page hdr"
        style={{
          minHeight: 80,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-6)',
        }}
      >
        <Link
          href="/"
          aria-label="DebtShift home"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            color: 'var(--ink)',
            textDecoration: 'none',
            fontWeight: 700,
            fontSize: 19,
            letterSpacing: '-0.01em',
          }}
        >
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M4 18 11 6" stroke="var(--ink)" strokeWidth="3.2" strokeLinecap="round" />
            <path d="M13 18 20 6" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
          </svg>
          DebtShift
        </Link>

        {/*
          The nav only exists once a wallet is connected: every destination
          behind it needs an account, and offering a dead link on the landing
          page would be a worse welcome than offering none.
        */}
        <nav
          aria-label="Primary"
          className="hdr__nav"
          hidden={!connected}
          style={{
            display: connected ? 'flex' : 'none',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          {NAV.map((item) => {
            const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? 'page' : undefined}
                style={{
                  color: current ? 'var(--ink)' : 'var(--ink-muted)',
                  textDecoration: 'none',
                  padding: current ? '29px 8px 27px' : '29px 8px',
                  borderBottom: current ? '2px solid var(--ink)' : undefined,
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <span className="hdr__grow" style={{ flexGrow: 1 }} />

        <div
          className="hdr__env"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
        >
          <EnvironmentBadge quietUntilReported={pathname === '/'} />
          <ThemeToggle />
        </div>

        <div
          className="hdr__wallet"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
        >
          {connected ? (
            <>
              <span style={{ display: 'flex', flexDirection: 'column', textAlign: 'right' }}>
                <span className="mono">{truncateHex(wallet.account ?? '')}</span>
                <span
                  className="hdr__chain"
                  style={{ fontSize: 12, lineHeight: '16px', color: 'var(--ink-muted)' }}
                >
                  {chainLabel(wallet.chainId)}
                </span>
              </span>
              {wallet.isDemo ? null : (
                <Button variant="secondary" size="sm" onClick={wallet.disconnect}>
                  Disconnect
                </Button>
              )}
            </>
          ) : wallet.status === 'unavailable' ? (
            // No wallet in this browser: a disabled "Connect" is a dead end,
            // so the header offers the one thing that works here.
            <Button size="sm" variant="secondary" onClick={wallet.enterDemo}>
              Recorded demo
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void wallet.connect()}
              disabled={wallet.status === 'connecting'}
            >
              {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------- footer */

export function SiteFooter() {
  const wallet = useWallet();
  // `checked` separates "not asked yet" from "asked and down": the footer used
  // to flash "API unreachable" on every page load before the first answer.
  const [health, setHealth] = useState<{ ok: boolean; at?: string; checked: boolean }>({
    ok: false,
    checked: false,
  });
  /*
   * Set after mount, never during render. The API base differs between the
   * server render and a browser tab that is in the recorded demo, and deriving
   * the link while rendering made the two disagree (a hydration mismatch).
   */
  const [docsUrl, setDocsUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    setDocsUrl(wallet.isDemo ? undefined : `${api.baseUrl.replace(/\/v1$/u, '')}/docs`);
  }, [wallet.isDemo]);
  // Which chains this deployment works on comes from the backend's enabled
  // markets, not from a constant: the footer used to say 31337/31338 for
  // everyone, which is only true of the local sandbox.
  const [chainIds, setChainIds] = useState<readonly number[]>([]);
  // Separate from the health check: the two answers arrive at different times.
  const [chainsLoaded, setChainsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.markets().then(
      (markets) => {
        if (cancelled) return;
        const ids = [...new Set(markets.map((market) => market.chainId))].sort((a, b) => a - b);
        setChainIds(ids);
        setChainsLoaded(true);
      },
      () => {
        if (!cancelled) {
          setChainIds([]);
          setChainsLoaded(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const result = await api.health();
        if (!cancelled) {
          setHealth({ ok: result.status === 'ok', at: result.timestamp, checked: true });
        }
      } catch {
        if (!cancelled) setHealth({ ok: false, checked: true });
      }
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const checkedAt = health.at ? new Date(health.at).toISOString().slice(11, 19) : undefined;

  return (
    <footer style={{ background: 'var(--brand-fill)', color: 'var(--on-brand)' }}>
      <div
        className="page foot"
        style={{
          padding: '28px var(--page-gutter)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-5)',
          alignItems: 'center',
          fontSize: 13,
          lineHeight: '20px',
        }}
      >
        <span className="num">
          {chainIds.length === 0
            ? chainsLoaded
              ? 'Chains not reported'
              : ''
            : chainIds.map((id) => chainName(id)).join(' → ')}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: wallet.isDemo
                ? '#F2B45C'
                : !health.checked
                  ? '#9FB1C4'
                  : health.ok
                    ? '#5CC98A'
                    : '#F28B82',
            }}
          />
          {/* In the demo no API is contacted, and the footer must not claim one is healthy. */}
          {wallet.isDemo
            ? 'Recorded data · no API contacted'
            : !health.checked
              ? 'Checking the API…'
              : health.ok
                ? `API healthy${checkedAt ? ` · checked ${checkedAt}` : ''}`
                : 'API unreachable'}
        </span>
        {docsUrl ? (
          <a href={docsUrl} style={{ color: '#6BCAD6' }}>
            API docs
          </a>
        ) : null}
        <span className="hdr__grow" style={{ flexGrow: 1 }} />
        <span style={{ color: '#C7D3DF' }}>
          DebtShift never requests or stores a private key or seed phrase.
        </span>
      </div>
    </footer>
  );
}

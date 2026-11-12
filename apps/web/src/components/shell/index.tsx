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
import { truncateHex } from '../../lib/formatting/index';
import { ThemeToggle } from '../../features/theme/theme-toggle';
import { Badge, Button } from '../ui/index';

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
 * Today the backend only supports the simulator write path, so this reads
 * `Simulator · test funds`. It takes the label from a prop where a page knows
 * better (for example the warning string prepare returned) rather than from a
 * hardcoded constant scattered across pages.
 */
export function EnvironmentBadge({ live }: { readonly live?: boolean }) {
  return live ? (
    <Badge tone="neutral" title="Live market data is read-only. Execution is disabled.">
      Live market data · execution disabled
    </Badge>
  ) : (
    <Badge tone="accent" title="This environment uses test assets only.">
      Simulator · test funds
    </Badge>
  );
}

/* ------------------------------------------------------------------- header */

export function SiteHeader() {
  const pathname = usePathname();
  const wallet = useWallet();
  const connected = isConnected(wallet);

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
          <EnvironmentBadge />
          <ThemeToggle />
        </div>

        <div
          className="hdr__wallet"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
        >
          {connected ? (
            <>
              <span style={{ display: 'flex', flexDirection: 'column', textAlign: 'right' }}>
                <span className="mono">{truncateHex(wallet.account)}</span>
                <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--ink-muted)' }}>
                  {chainLabel(wallet.chainId)}
                </span>
              </span>
              <Button variant="secondary" size="sm" onClick={wallet.disconnect}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => void wallet.connect()}
              disabled={wallet.status === 'connecting' || wallet.status === 'unavailable'}
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
  const [health, setHealth] = useState<{ ok: boolean; at?: string }>({ ok: false });

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const result = await api.health();
        if (!cancelled) setHealth({ ok: result.status === 'ok', at: result.timestamp });
      } catch {
        if (!cancelled) setHealth({ ok: false });
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
        <span className="num">Source chain 31337 · Destination chain 31338</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: health.ok ? '#5CC98A' : '#F28B82',
            }}
          />
          {health.ok
            ? `API healthy${checkedAt ? ` · checked ${checkedAt}` : ''}`
            : 'API unreachable'}
        </span>
        <a href="http://localhost:3001/docs" style={{ color: '#6BCAD6' }}>
          API docs
        </a>
        <span className="hdr__grow" style={{ flexGrow: 1 }} />
        <span style={{ color: '#C7D3DF' }}>
          DebtShift never requests or stores a private key or seed phrase.
        </span>
      </div>
    </footer>
  );
}

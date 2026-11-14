'use client';

/*
 * The gate in front of every screen that reads borrower data.
 *
 * The API answers position, route, preparation and migration requests only to
 * a signed-in owner of the account. Without this gate each of those screens
 * would load, be refused, and show its own error. With it, a connected wallet
 * that has not signed in sees one screen that says exactly what is being asked
 * and what it does not authorize.
 *
 * It asks for nothing on its own: the login message is requested and signed
 * only when the user presses the button.
 */

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { Alert, Button, PageLoading } from '../../components/ui';
import { truncateHex } from '../../lib/formatting';
import { NetworkHelp } from './network-help';
import { isConnected, useWallet } from './wallet-context';

/** Screens whose data the API serves only to a signed-in borrower. */
const PROTECTED_PREFIXES = ['/position', '/routes', '/authorize', '/history', '/migrations'];

export function needsSession(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function SessionGate({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const wallet = useWallet();

  if (!needsSession(pathname)) return <>{children}</>;
  // The recorded demo talks to no backend, so there is nothing to sign in to.
  if (wallet.isDemo) return <>{children}</>;
  if (wallet.status === 'initialising') {
    // The monitor starts reading as soon as it mounts, so it waits here until
    // it is known whether anyone is signed in. Every other screen already
    // says "starting up" in its own words and asks the API for nothing yet.
    if (pathname.startsWith('/migrations')) return <PageLoading label="Migration" />;
    return <>{children}</>;
  }

  if (!isConnected(wallet)) {
    // Every other screen has its own connect prompt. The monitor had none: it
    // used to be readable by anyone holding the link, and no longer is.
    if (pathname.startsWith('/migrations')) return <ConnectForMigration />;
    return <>{children}</>;
  }

  const session = wallet.session;
  if (session.status === 'active') return <>{children}</>;
  if (session.status === 'unknown' || session.status === 'checking') {
    return <PageLoading label="Checking your session" />;
  }

  return <SignInPanel />;
}

function ConnectForMigration() {
  const wallet = useWallet();
  return (
    <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
      <div
        style={{ maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <p className="eyebrow">Migration</p>
        <h1 style={{ margin: 0, fontSize: 40, lineHeight: '48px', letterSpacing: '-0.015em' }}>
          Connect the wallet that started this migration.
        </h1>
        <p style={{ margin: 0, fontSize: 18, lineHeight: '28px', color: 'var(--ink-muted)' }}>
          A migration is shown only to the borrower who signed it. The migration itself continues on
          the backend whether or not this page is open.
        </p>
        <div>
          <Button onClick={() => void wallet.connect()} disabled={wallet.status === 'unavailable'}>
            {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
          </Button>
        </div>
        {wallet.status === 'unavailable' ? (
          <Alert tone="warning" title="No browser wallet detected">
            Install a wallet that supports EIP-1193, then reload.
          </Alert>
        ) : null}
        {wallet.error ? (
          <Alert tone="warning" title="The wallet did not connect">
            {wallet.error}
          </Alert>
        ) : null}
      </div>
    </section>
  );
}

function SignInPanel() {
  const wallet = useWallet();
  const session = wallet.session;
  const signing = session.status === 'signing';
  const unreachable = session.status === 'unreachable';

  return (
    <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
      <div
        style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <p className="eyebrow">Sign in</p>
        <h1 style={{ margin: 0, fontSize: 40, lineHeight: '48px', letterSpacing: '-0.015em' }}>
          Prove this wallet is yours.
        </h1>
        <p style={{ margin: 0, fontSize: 18, lineHeight: '28px', color: 'var(--ink-muted)' }}>
          DebtShift shows a loan only to the owner of its account. Your wallet will ask you to sign
          one login message. It is not a transaction and costs no gas.
        </p>

        <dl
          className="grid-facts"
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: '170px minmax(0, 1fr)',
            gap: '10px 16px',
            fontSize: 15,
            lineHeight: '22px',
          }}
        >
          <dt style={{ color: 'var(--ink-muted)' }}>Account</dt>
          <dd className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>
            {truncateHex(wallet.account ?? '', 10, 8)}
          </dd>
          <dt style={{ color: 'var(--ink-muted)' }}>What it does</dt>
          <dd style={{ margin: 0 }}>
            Opens a session in this browser so the API will answer for this account. It ends on its
            own after a few hours, or when you disconnect.
          </dd>
          <dt style={{ color: 'var(--ink-muted)' }}>What it does not do</dt>
          <dd style={{ margin: 0 }}>
            It does not authorize a refinance, approve a token or move funds. Those are two separate
            signatures you review later, and nothing happens without them.
          </dd>
          <dt style={{ color: 'var(--ink-muted)' }}>Network</dt>
          <dd style={{ margin: 0 }}>
            The message names the source chain. If your wallet is on another network it asks to
            switch first.
          </dd>
        </dl>

        {/* Announced: a refusal or an expiry is the reason this screen is showing. */}
        <div aria-live="polite">
          {session.notice ? (
            <Alert
              tone={unreachable ? 'danger' : 'warning'}
              title={unreachable ? 'The API could not be reached' : 'Not signed in'}
            >
              {session.notice}
            </Alert>
          ) : null}
        </div>

        {/* Shown when signing in stopped because the wallet lacks the network. */}
        {wallet.chainIssue?.kind === 'unknown-addable' ? (
          <NetworkHelp chainId={wallet.chainIssue.chainId} />
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Button onClick={() => void wallet.signIn()} disabled={signing} aria-busy={signing}>
            {signing ? 'Waiting for your wallet…' : 'Sign in with wallet'}
          </Button>
          {unreachable ? (
            <Button variant="secondary" onClick={wallet.recheckSession}>
              Check again
            </Button>
          ) : null}
          <Button variant="ghost" onClick={wallet.disconnect} disabled={signing}>
            Disconnect
          </Button>
        </div>
      </div>
    </section>
  );
}

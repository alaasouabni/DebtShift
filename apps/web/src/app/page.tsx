'use client';

/*
 * `/` — landing and disconnected state.
 *
 * The three claims on this page are the product's claims, and each one is
 * enforced elsewhere in the code rather than merely asserted here: test funds
 * only (the backend fails closed outside the simulator), no keys (the wallet
 * module never touches one), no AI decisions (the explanation is a separate,
 * subordinate panel that cannot change a value).
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Alert, Button, SectionRule } from '../components/ui/index';
import { isConnected, useWallet } from '../features/wallet/wallet-context';

const STEPS = [
  {
    title: 'Read your position',
    body: 'Collateral, debt, rate and health — with the block they were read at.',
  },
  {
    title: 'Compare routes',
    body: 'Every candidate, ranked by the same rules — including the ones rejected, and why.',
  },
  {
    title: 'Sign twice',
    body: 'A policy with limits, then the exact plan. Two separate wallet prompts.',
  },
  {
    title: 'Watch it settle',
    body: 'Each phase, command and piece of evidence, until it is complete.',
  },
] as const;

const POLICY_TERMS = [
  'Which destination markets are allowed',
  'Maximum debt repaid, minimum collateral kept, maximum fee',
  'Maximum slippage and minimum rate saving',
  'Safety limit, normal and stressed',
  'How long it lasts',
] as const;

const PLAN_TERMS = [
  'Source and target market, all four assets',
  'Exact amount caps on both sides',
  'Destination and refund receivers',
  "The transport quote and the solver's fee cap",
  'A hard deadline',
] as const;

const PROMISES = [
  {
    title: 'Test funds only',
    body: 'This environment is a local simulator on two test chains. Real-fund execution is switched off, and nothing on this page can switch it on.',
  },
  {
    title: 'No keys, ever',
    body: 'We never ask for or store a private key or seed phrase. You sign in your own wallet.',
  },
  {
    title: 'No AI decisions',
    body: 'No model chooses, changes, signs or executes a route. Explanations describe the result; they cannot alter it.',
  },
] as const;

export default function LandingPage() {
  const wallet = useWallet();
  const router = useRouter();
  const connected = isConnected(wallet);

  // Once an account is authorized there is nothing left to do here.
  useEffect(() => {
    if (connected) router.replace('/position');
  }, [connected, router]);

  return (
    <>
      <section
        aria-labelledby="hero-title"
        className="page hero"
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: '120px var(--page-gutter) 112px',
        }}
      >
        {/* The monogram's lean, enlarged. Decorative. */}
        <div
          aria-hidden="true"
          className="deco"
          style={{
            position: 'absolute',
            right: 160,
            top: 64,
            width: 150,
            height: 440,
            background: 'var(--ink)',
            transform: 'skewX(var(--shift-angle))',
          }}
        />
        <div
          aria-hidden="true"
          className="deco"
          style={{
            position: 'absolute',
            right: 56,
            top: 168,
            width: 64,
            height: 336,
            background: 'var(--accent)',
            transform: 'skewX(var(--shift-angle))',
          }}
        />

        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-6)',
            maxWidth: 860,
          }}
        >
          <p className="eyebrow">Cross-chain debt refinancing</p>
          <h1
            id="hero-title"
            className="hero__title"
            style={{
              margin: 0,
              fontSize: 88,
              lineHeight: '88px',
              fontWeight: 700,
              letterSpacing: '-0.035em',
            }}
          >
            Move your loan to a cheaper market.{' '}
            <span style={{ color: 'var(--ink-muted)' }}>Keep everything else.</span>
          </h1>
          <p
            className="hero__lede"
            style={{
              margin: 0,
              fontSize: 22,
              lineHeight: '32px',
              color: 'var(--ink-muted)',
              maxWidth: 640,
            }}
          >
            DebtShift reads your loan, compares every route against a fixed policy, and asks for two
            bounded signatures before anything moves between chains.
          </p>

          <div
            className="actions"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 20,
              alignItems: 'center',
            }}
          >
            <Button
              onClick={() => void wallet.connect()}
              disabled={wallet.status === 'connecting' || wallet.status === 'unavailable'}
            >
              {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
            </Button>
            <Link href="#how" style={{ fontSize: 15, fontWeight: 600 }}>
              How it works
            </Link>
          </div>

          {wallet.status === 'unavailable' ? (
            <Alert tone="warning" title="No browser wallet detected">
              DebtShift needs a wallet that supports EIP-1193 — MetaMask or Rabby, for example.
              Install one and reload this page. Nothing here can connect without it, and nothing
              here will ask you for a key.
            </Alert>
          ) : null}

          {wallet.status === 'rejected' ? (
            <Alert
              tone="warning"
              title="You declined the connection request"
              action={
                <Button size="sm" variant="secondary" onClick={() => void wallet.connect()}>
                  Try again
                </Button>
              }
            >
              Nothing was shared and nothing happened. DebtShift only reads your position once you
              authorize an account.
            </Alert>
          ) : null}

          {wallet.status === 'disconnected' && wallet.error ? (
            <Alert tone="danger" title="The wallet could not be connected">
              {wallet.error}
            </Alert>
          ) : null}

          <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--ink-muted)' }}>
            Needs a browser wallet that supports EIP-1193. Test funds only in this environment.
          </p>
        </div>
      </section>

      <SectionRule />

      <section
        id="how"
        aria-labelledby="how-title"
        className="page"
        style={{
          padding: '80px var(--page-gutter)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-7)',
        }}
      >
        <div className="sec" style={{ padding: 0 }}>
          <div className="sec__lede">
            <span className="sec__number num">01</span>
          </div>
          <h2
            id="how-title"
            className="sec__body sec__title"
            style={{ fontSize: 44, lineHeight: '50px', letterSpacing: '-0.025em' }}
          >
            Four steps, and you can see every one of them.
          </h2>
        </div>

        <ol
          className="steps"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: '0 var(--space-6)',
          }}
        >
          {STEPS.map((step, index) => {
            const last = index === STEPS.length - 1;
            return (
              <li
                key={step.title}
                style={{
                  borderTop: `2px solid ${last ? 'var(--accent)' : 'var(--ink)'}`,
                  paddingTop: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                <span
                  className="num step__big"
                  aria-hidden="true"
                  style={{
                    fontSize: 96,
                    lineHeight: '88px',
                    fontWeight: 300,
                    letterSpacing: '-0.04em',
                    color: last ? 'var(--accent-strong)' : 'var(--line-strong)',
                  }}
                >
                  {index + 1}
                </span>
                <h3 style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 700 }}>
                  {step.title}
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: 15,
                    lineHeight: '22px',
                    color: 'var(--ink-muted)',
                  }}
                >
                  {step.body}
                </p>
              </li>
            );
          })}
        </ol>
      </section>

      <section
        aria-labelledby="sig-title"
        style={{ background: 'var(--brand-fill)', color: 'var(--on-brand)' }}
      >
        <div
          className="page"
          style={{
            padding: '96px var(--page-gutter)',
            display: 'flex',
            flexDirection: 'column',
            gap: 56,
          }}
        >
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec__lede">
              <span className="num" style={{ fontSize: 14, fontWeight: 700, color: '#6BCAD6' }}>
                02
              </span>
            </div>
            <div
              className="sec__body"
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
            >
              <h2
                id="sig-title"
                style={{
                  margin: 0,
                  fontSize: 44,
                  lineHeight: '50px',
                  fontWeight: 700,
                  letterSpacing: '-0.025em',
                }}
              >
                Two signatures. Two different promises.
              </h2>
              <p style={{ margin: 0, fontSize: 20, lineHeight: '30px', color: '#C7D3DF' }}>
                Nothing executes on one signature. If any term changes after you sign, the
                authorization is thrown away and you review again.
              </p>
            </div>
          </div>

          <div
            className="sig-split"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 'var(--space-6)',
            }}
          >
            {(
              [
                {
                  eyebrow: 'Signature 1 of 2',
                  title: 'Authorize the policy',
                  lede: 'Sets the bounds any route must stay within. It does not pick a route.',
                  terms: POLICY_TERMS,
                  rule: '#E8EEF4',
                  eyebrowColor: '#C7D3DF',
                },
                {
                  eyebrow: 'Signature 2 of 2',
                  title: 'Authorize this exact execution',
                  lede: 'Fixes one route and everything about it.',
                  terms: PLAN_TERMS,
                  rule: '#3FB6C5',
                  eyebrowColor: '#6BCAD6',
                },
              ] as const
            ).map((card) => (
              <div
                key={card.title}
                style={{
                  borderTop: `2px solid ${card.rule}`,
                  paddingTop: 'var(--space-5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-4)',
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    lineHeight: '16px',
                    fontWeight: 600,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: card.eyebrowColor,
                  }}
                >
                  {card.eyebrow}
                </p>
                <h3 style={{ margin: 0, fontSize: 30, lineHeight: '38px', fontWeight: 700 }}>
                  {card.title}
                </h3>
                <p style={{ margin: 0, fontSize: 17, lineHeight: '26px', color: '#C7D3DF' }}>
                  {card.lede}
                </p>
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                    fontSize: 16,
                    lineHeight: '24px',
                  }}
                >
                  {card.terms.map((term, index) => (
                    <li
                      key={term}
                      style={{
                        padding: '10px 0',
                        borderBottom:
                          index === card.terms.length - 1 ? undefined : '1px solid #1C3A5E',
                      }}
                    >
                      {term}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="safety-title"
        className="sec"
        style={{ padding: '96px var(--page-gutter)' }}
      >
        <div className="sec__lede">
          <span className="sec__number num">03</span>
          <h2
            id="safety-title"
            className="sec__title"
            style={{ fontSize: 44, lineHeight: '50px', letterSpacing: '-0.025em' }}
          >
            What we promise
          </h2>
        </div>
        <div
          className="sec__body"
          style={{ display: 'flex', flexDirection: 'column', borderTop: '2px solid var(--ink)' }}
        >
          {PROMISES.map((promise, index) => (
            <div
              key={promise.title}
              className="grid-facts"
              style={{
                display: 'grid',
                gridTemplateColumns: '200px minmax(0, 1fr)',
                gap: 'var(--space-2) var(--space-5)',
                padding: 'var(--space-5) 0',
                borderTop: 0,
                borderBottom: index === PROMISES.length - 1 ? undefined : '1px solid var(--line)',
              }}
            >
              <h3 style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 700 }}>
                {promise.title}
              </h3>
              <p style={{ margin: 0, fontSize: 16, lineHeight: '24px', color: 'var(--ink-muted)' }}>
                {promise.body}
              </p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

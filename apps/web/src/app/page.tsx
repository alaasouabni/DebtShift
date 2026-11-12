'use client';

/*
 * `/` — landing.
 *
 * The page leads with a picture of the product working — a loan leaving one
 * market, crossing chains and reopening at a lower rate — instead of a
 * paragraph describing it. The figures in that picture are not marketing
 * numbers: they are read from a recorded run on the contract-backed sandbox,
 * and the card says so.
 *
 * The three claims lower down are enforced in the code, not just stated: test
 * funds only (the backend fails closed outside the sandbox), no keys (the
 * wallet module never touches one), no AI decisions (the explanation is a
 * separate panel that cannot change a value).
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { ILLUSTRATION_STAGES } from '../components/flow/flow-stage';
import { MigrationFlow } from '../components/flow/migration-flow';
import { Alert, Button } from '../components/ui/index';
import { isConnected, useWallet } from '../features/wallet/wallet-context';
import type { RouteAnalysisResponse } from '../lib/api/types';
import { chainName } from '../lib/chains';
import routesRecording from '../lib/demo/recordings/route-analysis.json' with { type: 'json' };
import {
  bpsToPoints,
  formatAmount,
  formatBps,
  formatUsdMicro,
  humanizeIdentifier,
} from '../lib/formatting';

/* The recorded sandbox run the hero illustrates. */
const recorded = (routesRecording as unknown as RouteAnalysisResponse).analysis.analyses[0]!;
const recordedPosition = recorded.sourcePosition;
const recordedRoute =
  recorded.comparison.evaluations.find((route) => route.eligible) ??
  recorded.comparison.evaluations[0]!;

interface IconTile {
  readonly title: string;
  readonly body: string;
  readonly icon: ReactNode;
}

const STEPS: readonly IconTile[] = [
  {
    title: 'Read your position',
    body: 'Collateral, debt, rate and health, with the block they were read at.',
    icon: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </>
    ),
  },
  {
    title: 'Compare routes',
    body: 'Every candidate ranked by the same rules, including the rejected ones and why.',
    icon: <path d="M4 19V9m6 10V5m6 14v-7m4 7H2" />,
  },
  {
    title: 'Sign twice',
    body: 'A policy with limits, then the exact plan. Two separate wallet prompts.',
    icon: (
      <>
        <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
        <path d="m13.5 6.5 4 4" />
      </>
    ),
  },
  {
    title: 'Watch it settle',
    body: 'Each phase, command and piece of evidence, live, until it is done.',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
  },
];

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

const PROMISES: readonly IconTile[] = [
  {
    title: 'Test funds only',
    body: 'This environment runs on test assets. Real-fund execution is switched off on the server, and nothing in this page can switch it on.',
    icon: (
      <>
        <path d="M12 3 4 6v6c0 4.5 3.2 7.6 8 9 4.8-1.4 8-4.5 8-9V6l-8-3Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
  {
    title: 'No keys, ever',
    body: 'We never ask for or store a private key or seed phrase. You sign in your own wallet.',
    icon: (
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="m11 12 9-9m-3 3 3 3m-6 0 2 2" />
      </>
    ),
  },
  {
    title: 'No AI decisions',
    body: 'No model chooses, changes, signs or executes a route. Explanations describe the result; they cannot alter it.',
    icon: (
      <>
        <rect x="4" y="7" width="16" height="12" rx="3" />
        <path d="M12 7V4m-4 9h.01M16 13h.01M9 16h6" />
      </>
    ),
  },
];

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="tile__icon" aria-hidden="true">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );
}

export default function LandingPage() {
  const wallet = useWallet();
  const router = useRouter();
  const connected = isConnected(wallet);
  const [stageIndex, setStageIndex] = useState(0);

  // Once an account is authorized (or the demo starts) there is nothing left to do here.
  useEffect(() => {
    if (connected) router.replace('/position');
  }, [connected, router]);

  // The hero illustration walks through a normal run, one stage at a time.
  useEffect(() => {
    const timer = setInterval(
      () => setStageIndex((index) => (index + 1) % ILLUSTRATION_STAGES.length),
      2600,
    );
    return () => clearInterval(timer);
  }, []);

  const economics = recordedRoute.economics;
  const debtAsset = recordedPosition.position.debtAsset;
  const destinationChain = recordedRoute.financing.settlementAsset.chainId;

  return (
    <>
      <section
        aria-labelledby="hero-title"
        className="page"
        style={{ padding: '72px var(--page-gutter) 64px' }}
      >
        <div className="hero-grid">
          <div
            className="reveal"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <span className="chip" style={{ alignSelf: 'flex-start' }}>
              <span className="chip__dot" aria-hidden="true" />
              Cross-chain debt refinancing
            </span>

            <h1 id="hero-title" className="hero-title">
              Move your loan to a <span className="accent-text">cheaper market</span>. Keep
              everything else.
            </h1>

            <p className="section-lede">
              DebtShift reads your loan, compares every route against a fixed policy, and asks for
              two bounded signatures before anything moves between chains.
            </p>

            <div
              className="actions"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-3)',
                alignItems: 'center',
              }}
            >
              {/*
                The recorded run needs no wallet and no local chains, so it is
                the first thing offered: anyone can see the whole product.
              */}
              <Button className="dsh-btn--lg" onClick={wallet.enterDemo}>
                Watch the recorded demo
              </Button>
              <Button
                variant="secondary"
                className="dsh-btn--lg"
                onClick={() => void wallet.connect()}
                disabled={wallet.status === 'connecting' || wallet.status === 'unavailable'}
              >
                {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
              </Button>
            </div>

            {wallet.status === 'unavailable' ? (
              <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--ink-muted)' }}>
                No browser wallet detected. The recorded demo works without one; to use your own
                position, install a wallet that supports EIP-1193 and reload.
              </p>
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
          </div>

          <div
            className="glass reveal reveal--2"
            style={{
              padding: 'var(--space-5)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-5)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 'var(--space-3)',
                flexWrap: 'wrap',
              }}
            >
              <span className="eyebrow">How a migration runs</span>
              <span className="chip">Recorded sandbox run</span>
            </div>

            <MigrationFlow
              stage={ILLUSTRATION_STAGES[stageIndex]!}
              transportLabel="Transport"
              source={{
                protocol: humanizeIdentifier(recordedPosition.position.market.protocol),
                chain: chainName(recordedPosition.position.market.chainId),
                figure: formatBps(economics.sourceAprBps),
                figureLabel: 'borrow rate',
              }}
              destination={{
                protocol: humanizeIdentifier(recordedRoute.candidateId),
                chain: chainName(destinationChain),
                figure: formatBps(economics.targetAprAfterBps),
                figureLabel: 'borrow rate',
              }}
            />

            <div className="kpi-row">
              <div className="kpi">
                <span className="kpi__value accent-text">
                  −{bpsToPoints(economics.aprReductionBps)} pts
                </span>
                <span className="kpi__label">rate, after your own borrow is priced in</span>
              </div>
              <div className="kpi">
                <span className="kpi__value">
                  {formatAmount(recordedPosition.debtUnits, debtAsset.decimals, debtAsset.symbol)}
                </span>
                <span className="kpi__label">debt refinanced</span>
              </div>
              <div className="kpi">
                <span className="kpi__value">{formatUsdMicro(economics.netBenefitUsdMicro)}</span>
                <span className="kpi__label">net benefit after all costs</span>
              </div>
            </div>

            <p style={{ margin: 0, fontSize: 12, lineHeight: '16px', color: 'var(--ink-muted)' }}>
              Figures from a recorded run on the contract-backed sandbox, with test assets. Not a
              quote for your position.
            </p>
          </div>
        </div>
      </section>

      <section
        id="how"
        aria-labelledby="how-title"
        className="page"
        style={{
          padding: '64px var(--page-gutter)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p className="eyebrow">How it works</p>
          <h2 id="how-title" className="section-title">
            Four steps, and you can see every one of them.
          </h2>
        </div>

        <ol className="feature-grid" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {STEPS.map((step, index) => (
            <li key={step.title} className="tile">
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <Icon>{step.icon}</Icon>
                <span className="tile__step">{String(index + 1).padStart(2, '0')}</span>
              </div>
              <h3 className="tile__title">{step.title}</h3>
              <p className="tile__body">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="sig-title"
        className="page"
        style={{
          padding: '64px var(--page-gutter)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p className="eyebrow">Authorization</p>
          <h2 id="sig-title" className="section-title">
            Two signatures. Two different promises.
          </h2>
          <p className="section-lede">
            Nothing executes on one signature. If any term changes after you sign, the authorization
            is thrown away and you review again.
          </p>
        </div>

        <div className="duo-grid">
          {(
            [
              {
                eyebrow: 'SIGNATURE 1 OF 2',
                title: 'Authorize the policy',
                lede: 'Sets the bounds any route must stay within. It does not pick a route.',
                terms: POLICY_TERMS,
              },
              {
                eyebrow: 'SIGNATURE 2 OF 2',
                title: 'Authorize this exact execution',
                lede: 'Fixes one route and everything about it.',
                terms: PLAN_TERMS,
              },
            ] as const
          ).map((card) => (
            <div key={card.title} className="tile" style={{ gap: 'var(--space-4)' }}>
              <span className="tile__step">{card.eyebrow}</span>
              <h3 className="tile__title" style={{ fontSize: 24, lineHeight: '32px' }}>
                {card.title}
              </h3>
              <p className="tile__body">{card.lede}</p>
              <ul className="tile__list">
                {card.terms.map((term) => (
                  <li key={term}>{term}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="safety-title"
        className="page"
        style={{
          padding: '64px var(--page-gutter) 96px',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p className="eyebrow">Safety</p>
          <h2 id="safety-title" className="section-title">
            What we promise
          </h2>
        </div>

        <div className="trio-grid">
          {PROMISES.map((promise) => (
            <div key={promise.title} className="tile">
              <Icon>{promise.icon}</Icon>
              <h3 className="tile__title">{promise.title}</h3>
              <p className="tile__body">{promise.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

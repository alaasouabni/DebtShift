'use client';

/*
 * `/routes` — deterministic route comparison.
 *
 * Every candidate is shown, not only the winner. Explaining why a route was
 * rejected is a feature of this product, not an error screen, so the rejected
 * section is never collapsed by default and always carries the backend's own
 * message beside the human sentence.
 *
 * This page renders the backend's verdict. It does not rank, re-score, or
 * recompute eligibility. Where it groups eligible routes ahead of rejected ones
 * that is a grouping by a backend boolean, not a ranking.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  PageLoading,
  Section,
  SectionRule,
} from '../../components/ui';
import { HashValue } from '../../components/shell';
import { ApiError, api } from '../../lib/api/client';
import type {
  ExplainedRoute,
  RouteAnalysisResponse,
  RouteEvaluation,
  SourcePositionAnalysis,
} from '../../lib/api/types';
import {
  bpsToPoints,
  formatBaseUnits,
  formatBps,
  formatDuration,
  formatInteger,
  formatTimestamp,
  formatUsdMicro,
  isZeroAmount,
} from '../../lib/formatting';
import { isPrivateSandboxChain } from '../../lib/chains';
import { allStale, rejectionCopy } from '../../lib/labels';
import { readExplanationSettings } from '../settings/explanation-settings';
import { isConnected, useWallet } from '../wallet/wallet-context';
import { CandidateBoard } from './candidate-board';
import {
  BreakEvenChart,
  CapacityBars,
  CostComposition,
  FigureStrip,
  RateBars,
  SafetyBars,
} from './charts';

interface LoadState {
  readonly kind: 'idle' | 'loading' | 'ready' | 'error';
  readonly data?: RouteAnalysisResponse | undefined;
  readonly error?: ApiError | undefined;
}

function uniqueCodes(evaluations: readonly RouteEvaluation[]): string[] {
  return [...new Set(evaluations.flatMap((route) => route.rejections.map((r) => r.code)))];
}

export function RoutesView() {
  const wallet = useWallet();
  const connected = isConnected(wallet);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });

  const load = useCallback(async (account: string) => {
    setState({ kind: 'loading' });
    try {
      // The explanation configuration is the user's, read fresh on each
      // request. A user API key lives in memory for that request only.
      const data = await api.analyzeRoutes(account, readExplanationSettings());
      setState({ kind: 'ready', data });
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

  // Not known yet whether a wallet or the demo is present: say so, rather
  // than flashing the connect prompt at someone who is already connected.
  if (wallet.status === 'initialising') {
    return <PageLoading label="Route comparison" />;
  }

  if (!connected) {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <p className="eyebrow">Route comparison</p>
        <h1 style={{ margin: '24px 0 0', fontSize: 40, lineHeight: '48px' }}>
          Connect a wallet to compare routes.
        </h1>
        <p style={{ marginTop: 16, fontSize: 18, color: 'var(--ink-muted)' }}>
          Routes are evaluated against the position of the account you authorize.
        </p>
        <div style={{ marginTop: 24 }}>
          <Button onClick={() => void wallet.connect()} disabled={wallet.status === 'unavailable'}>
            Connect wallet
          </Button>
        </div>
      </section>
    );
  }

  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <p className="eyebrow">Route comparison</p>
        <h1
          aria-busy="true"
          style={{
            margin: '24px 0 0',
            fontSize: 40,
            lineHeight: '48px',
            color: 'var(--ink-muted)',
          }}
        >
          Evaluating every candidate against the policy…
        </h1>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <div
          style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <p className="eyebrow">Route comparison</p>
          <Alert
            tone="danger"
            title="Routes could not be compared"
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

  const data = state.data!;
  const analysis: SourcePositionAnalysis | undefined = data.analysis.analyses[0];

  if (analysis === undefined) {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <p className="eyebrow">Route comparison</p>
        <h1 style={{ margin: '24px 0 0', fontSize: 40, lineHeight: '48px' }}>
          No supported source position to compare routes for.
        </h1>
        <div style={{ marginTop: 24 }}>
          <ButtonLink href="/position" variant="secondary">
            Back to the position
          </ButtonLink>
        </div>
      </section>
    );
  }

  const evaluations = analysis.comparison.evaluations;
  const eligible = evaluations.filter((route) => route.eligible);
  const rejected = evaluations.filter((route) => !route.eligible);
  const winner = eligible[0];
  const explanation = data.explanations.find(
    (entry) => entry.sourceSnapshotId === analysis.sourcePosition.snapshotId,
  )?.result;

  return (
    <>
      <RoutesHero
        evaluations={evaluations}
        winner={winner}
        evaluatedAt={evaluations[0]?.provenance.evaluatedAt}
        privateSandbox={isPrivateSandboxChain(analysis.sourcePosition.position.market.chainId)}
        onRefresh={() => void load(wallet.account)}
      />

      {winner ? <WinnerSections route={winner} /> : null}

      {rejected.length > 0 ? (
        <>
          <SectionRule />
          <RejectedRoutes routes={rejected} settlementDecimals={6} />
        </>
      ) : null}

      {explanation ? (
        <>
          <SectionRule />
          <ExplanationSection explanation={explanation} hasWinner={winner !== undefined} />
        </>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------------- hero */

function RoutesHero({
  evaluations,
  winner,
  evaluatedAt,
  privateSandbox,
  onRefresh,
}: {
  readonly evaluations: readonly RouteEvaluation[];
  readonly winner: RouteEvaluation | undefined;
  readonly evaluatedAt: string | undefined;
  readonly privateSandbox: boolean;
  readonly onRefresh: () => void;
}) {
  const codes = uniqueCodes(evaluations);
  const everythingStale = winner === undefined && allStale(codes);

  return (
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
        Route comparison · deterministic
        {evaluatedAt ? ` · evaluated ${formatTimestamp(evaluatedAt)}` : ''}
      </p>

      {winner ? (
        <>
          <h1
            className="hero__title num"
            style={{
              margin: 0,
              fontSize: 80,
              lineHeight: '84px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              maxWidth: 1100,
            }}
          >
            Moving saves {bpsToPoints(winner.economics.aprReductionBps)} points.{' '}
            <span style={{ color: 'var(--ink-muted)' }}>
              From {formatBps(winner.economics.sourceAprBps)} to{' '}
              {formatBps(winner.economics.targetAprAfterBps)}.
            </span>
          </h1>
          <p
            className="hero__lede"
            style={{
              margin: 0,
              fontSize: 22,
              lineHeight: '32px',
              color: 'var(--ink-muted)',
              maxWidth: 780,
            }}
          >
            {evaluations.length} candidate market{evaluations.length === 1 ? ' was' : 's were'}{' '}
            checked against your policy.{' '}
            {evaluations.length - 1 > 0
              ? `${evaluations.filter((r) => r.eligible).length} passes, and the reasons for the rest are below.`
              : 'It passes.'}
          </p>

          <CandidateBoard evaluations={evaluations} />

          <FigureStrip
            figures={[
              {
                label: 'Net benefit',
                value: formatUsdMicro(winner.economics.netBenefitUsdMicro),
                note: `after ${formatUsdMicro(winner.economics.allInCostUsdMicro)} of costs`,
              },
              {
                label: 'Breaks even after',
                value: winner.economics.breakEvenSeconds
                  ? formatDuration(Number(BigInt(winner.economics.breakEvenSeconds)))
                  : '—',
                note: "the backend's own figure",
              },
              {
                label: 'Net benefit, stressed',
                value: formatUsdMicro(winner.economics.stressNetBenefitUsdMicro),
                note: 'collateral and rate stressed by policy',
              },
              {
                label: 'Funding shortfall',
                value: formatBaseUnits(winner.financing.fundingShortfallUnits, 6),
                note: isZeroAmount(winner.financing.fundingShortfallUnits)
                  ? 'None — required to execute'
                  : 'Non-zero — this route cannot execute',
                tone: isZeroAmount(winner.financing.fundingShortfallUnits) ? 'success' : 'danger',
              },
            ]}
          />

          <div
            className="actions"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}
          >
            <ButtonLink href="/authorize">Prepare authorization</ButtonLink>
            <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--ink-muted)' }}>
              USD figures are for comparison only and never authorize anything.
            </span>
          </div>
        </>
      ) : (
        <>
          <h1
            className="hero__title"
            style={{
              margin: 0,
              fontSize: 64,
              lineHeight: '68px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              maxWidth: 1000,
            }}
          >
            No route currently satisfies the policy.
          </h1>
          <p
            className="hero__lede"
            style={{
              margin: 0,
              fontSize: 22,
              lineHeight: '32px',
              color: 'var(--ink-muted)',
              maxWidth: 780,
            }}
          >
            {evaluations.length} candidate{evaluations.length === 1 ? ' was' : 's were'} checked and
            every one was rejected. Nothing is hidden — each reason is below.
          </p>

          <CandidateBoard evaluations={evaluations} />

          {everythingStale ? (
            <Alert
              tone="warning"
              title="Every rejection is a freshness problem"
              action={
                <Button size="sm" variant="secondary" onClick={onRefresh}>
                  Refresh data
                </Button>
              }
            >
              The data aged out of the policy window; refinancing is not impossible.
              {privateSandbox ? (
                <>
                  {' '}
                  On a private sandbox chain this is usually no block being mined while idle, which
                  freezes <span className="mono">block.timestamp</span> while the clock moves on.
                  Mine a block and compare again.
                </>
              ) : (
                ' Refresh the data and compare again.'
              )}
            </Alert>
          ) : (
            <Alert tone="warning" title="These rejections are not about stale data">
              At least one reason below is structural — capacity, liquidity or economics. Refreshing
              will not change it.
            </Alert>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {codes.map((code) => (
              <span key={code} className="mono" style={{ color: 'var(--ink-muted)' }}>
                {code}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------- winner sections */

function WinnerSections({ route }: { readonly route: RouteEvaluation }) {
  const asset = route.financing.settlementAsset;

  return (
    <>
      <SectionRule />

      <Section
        id="rate"
        number="01"
        title="The rate"
        note={
          <>
            Your own borrow pushes the destination rate up by{' '}
            {bpsToPoints(route.economics.targetRateImpactBps)} points. That cost is already priced
            in — the saving you see is after it.
          </>
        }
        aside={
          <p
            className="mono"
            style={{ margin: 0, color: 'var(--ink-muted)', wordBreak: 'break-all' }}
          >
            {route.candidateId}
            {route.rank === undefined ? '' : ` · rank ${route.rank}`}
          </p>
        }
      >
        <RateBars economics={route.economics} />
      </Section>

      <SectionRule />

      <Section
        id="payoff"
        number="02"
        title="When it pays off"
        note={
          <>
            You start {formatUsdMicro(route.economics.allInCostUsdMicro)} down — the all-in and
            carrying costs. The saving recovers that over time.
          </>
        }
      >
        <BreakEvenChart economics={route.economics} />
      </Section>

      <SectionRule />

      <Section
        id="safety"
        number="03"
        title="How safe it stays"
        note="The new loan is measured against the limits you will sign. Margin matters more than pass or fail."
      >
        <div
          style={{ display: 'flex', flexDirection: 'column', borderTop: '2px solid var(--ink)' }}
        >
          <SafetyBars safety={route.safety} />
        </div>
      </Section>

      <SectionRule />

      <Section
        id="financing"
        number="04"
        title="How it is financed"
        note="The new loan must cover the old debt plus every financed cost, and stay under the smallest of four capacity limits."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 48 }}>
          <CapacityBars financing={route.financing} asset={asset} />

          <CostComposition
            components={route.financing.components}
            asset={asset}
            totals={route.financing}
          />

          <details
            style={{
              borderTop: '1px solid var(--line)',
              borderBottom: '1px solid var(--line)',
              padding: '16px 0',
            }}
          >
            <summary style={{ fontSize: 15, lineHeight: '22px', fontWeight: 600 }}>
              Cost components, sources and uses, provenance
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 16 }}>
              <div style={{ overflowX: 'auto' }}>
                <table
                  className="num"
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 14,
                    lineHeight: '20px',
                    minWidth: 520,
                  }}
                >
                  <thead>
                    <tr style={{ color: 'var(--ink-muted)', textAlign: 'left' }}>
                      {['Component', 'Kind', 'Class', asset.symbol, 'Counted'].map(
                        (heading, index) => (
                          <th
                            key={heading}
                            scope="col"
                            style={{
                              padding: index === 4 ? '8px 0 8px 16px' : '8px 0',
                              fontWeight: 600,
                              textAlign: index === 3 ? 'right' : 'left',
                              borderBottom: '1px solid var(--line)',
                            }}
                          >
                            {heading}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {route.financing.components.map((component) => (
                      <tr key={component.componentId}>
                        <td
                          className="mono"
                          style={{
                            padding: '8px 0',
                            borderBottom: '1px solid var(--line)',
                            wordBreak: 'break-all',
                          }}
                        >
                          {component.componentId}
                        </td>
                        <td style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                          {component.kind}
                        </td>
                        <td style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                          {component.financingClass}
                        </td>
                        <td
                          style={{
                            padding: '8px 0',
                            textAlign: 'right',
                            borderBottom: '1px solid var(--line)',
                          }}
                        >
                          {formatBaseUnits(component.settlementAmountUnits, asset.decimals)}
                        </td>
                        <td
                          style={{
                            padding: '8px 0 8px 16px',
                            borderBottom: '1px solid var(--line)',
                          }}
                        >
                          {component.counted === false ? 'No' : 'Yes'}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700 }}>
                      <td colSpan={3} style={{ padding: '8px 0' }}>
                        Required destination borrow
                      </td>
                      <td style={{ padding: '8px 0', textAlign: 'right' }}>
                        {formatBaseUnits(
                          route.financing.requiredDestinationBorrowUnits,
                          asset.decimals,
                        )}
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>

              <dl
                className="mono grid-facts"
                style={{
                  margin: 0,
                  display: 'grid',
                  gridTemplateColumns: '200px minmax(0, 1fr)',
                  gap: '4px 16px',
                  borderTop: 0,
                }}
              >
                <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>
                  marketSnapshotId
                </dt>
                <dd style={{ margin: 0, padding: 0, borderBottom: 0 }}>
                  <HashValue value={route.provenance.marketSnapshotId} label="market snapshot ID" />
                </dd>
                <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>
                  marketBlock
                </dt>
                <dd style={{ margin: 0, padding: 0, borderBottom: 0, wordBreak: 'break-all' }}>
                  {formatInteger(route.provenance.marketBlockNumber)} ·{' '}
                  {route.provenance.marketBlockHash}
                </dd>
                <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>
                  oracleUpdatedAt
                </dt>
                <dd style={{ margin: 0, padding: 0, borderBottom: 0 }}>
                  {formatTimestamp(route.provenance.oracleUpdatedAt)}
                </dd>
                <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>
                  rateProjection
                </dt>
                <dd style={{ margin: 0, padding: 0, borderBottom: 0, wordBreak: 'break-all' }}>
                  {route.provenance.rateProjection}
                </dd>
              </dl>
            </div>
          </details>
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------ rejected list */

function RejectedRoutes({
  routes,
  settlementDecimals,
}: {
  readonly routes: readonly RouteEvaluation[];
  readonly settlementDecimals: number;
}) {
  return (
    <>
      {routes.map((route, index) => {
        const asset = route.financing.settlementAsset;
        const decimals = asset.decimals || settlementDecimals;
        const shortfall = route.financing.fundingShortfallUnits;

        return (
          <section
            key={route.candidateId}
            aria-labelledby={`rejected-${route.candidateId}`}
            className="sec"
          >
            <div className="sec__lede">
              <span className="sec__number num" style={{ color: 'var(--danger)' }}>
                {String(index + 5).padStart(2, '0')} · Rejected
              </span>
              <h2 id={`rejected-${route.candidateId}`} className="sec__title">
                {routes.length === 1 ? "Why the other route can't run" : 'A rejected route'}
              </h2>
              <p className="sec__note">
                Its rate is {formatBps(route.economics.targetAprAfterBps)} after impact, but the
                policy rejected it. A rejected route cannot be prepared.
              </p>
              <p
                className="mono"
                style={{ margin: 0, color: 'var(--ink-muted)', wordBreak: 'break-all' }}
              >
                {route.candidateId}
              </p>
            </div>

            <div className="sec__body" style={{ display: 'flex', flexDirection: 'column' }}>
              <FigureStrip
                figures={[
                  {
                    label: 'Required borrow',
                    value: formatBaseUnits(
                      route.financing.requiredDestinationBorrowUnits,
                      decimals,
                    ),
                    note: asset.symbol,
                  },
                  {
                    label: 'Safe capacity',
                    value: formatBaseUnits(
                      route.financing.maximumSafeBorrowingCapacityUnits,
                      decimals,
                    ),
                    note: 'smallest of the four bounds',
                  },
                  {
                    label: 'Shortfall',
                    value: formatBaseUnits(shortfall, decimals),
                    note: isZeroAmount(shortfall) ? 'none' : 'must be zero to execute',
                    ...(isZeroAmount(shortfall) ? {} : { tone: 'danger' as const }),
                  },
                ]}
              />

              <ol
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  borderTop: '1px solid var(--line)',
                }}
              >
                {route.rejections.map((rejection, position) => {
                  const copy = rejectionCopy(rejection.code, rejection.message);
                  return (
                    <li
                      key={rejection.code}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '32px minmax(0, 1fr)',
                        gap: 12,
                        padding: '20px 0',
                        borderBottom: '1px solid var(--line)',
                      }}
                    >
                      <span
                        className="num"
                        style={{ fontSize: 15, fontWeight: 700, color: 'var(--danger)' }}
                      >
                        {position + 1}
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: 17, lineHeight: '24px', fontWeight: 600 }}>
                          {copy.text}
                        </span>
                        <span
                          className="mono"
                          style={{ color: 'var(--ink-muted)', wordBreak: 'break-all' }}
                        >
                          {rejection.code}
                        </span>
                        {copy.remedy ? (
                          <span style={{ fontSize: 14, color: 'var(--ink-muted)' }}>
                            {copy.remedy}
                          </span>
                        ) : null}
                        {/*
                          The backend's own words stay reachable. Replacing them
                          with our copy and nothing else would hide information
                          the user may need to report a problem.
                        */}
                        <details>
                          <summary
                            style={{
                              fontSize: 13,
                              lineHeight: '18px',
                              color: 'var(--accent-strong)',
                              fontWeight: 600,
                            }}
                          >
                            Backend message
                          </summary>
                          <p
                            className="mono"
                            style={{
                              margin: '4px 0 0',
                              color: 'var(--ink-muted)',
                              wordBreak: 'break-all',
                            }}
                          >
                            {rejection.message}
                          </p>
                        </details>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>
        );
      })}
    </>
  );
}

/* -------------------------------------------------------- explanation panel */

function ExplanationSection({
  explanation,
  hasWinner,
}: {
  readonly explanation: ExplainedRoute;
  readonly hasWinner: boolean;
}) {
  const parts = [
    { title: 'Main benefit', body: explanation.explanation.mainEconomicBenefit },
    { title: 'Break-even', body: explanation.explanation.breakEvenExplanation },
    { title: 'Safety', body: explanation.explanation.safetyExplanation },
    { title: 'Data freshness', body: explanation.explanation.dataFreshnessWarning },
    { title: 'Before you sign', body: explanation.explanation.reviewAndSignStatement },
  ];

  return (
    <section aria-labelledby="plain" className="sec" style={{ paddingBottom: 96 }}>
      <div className="sec__lede">
        <span className="sec__number num">{hasWinner ? '06' : '—'}</span>
        <h2 id="plain" className="sec__title">
          In plain words
        </h2>
        <p className="sec__note">A description of the result above. It cannot change it.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge tone={explanation.provider === 'DETERMINISTIC' ? 'neutral' : 'accent'}>
            {explanation.provider === 'DETERMINISTIC'
              ? 'Deterministic'
              : explanation.provider === 'LOCAL_AI'
                ? 'Local model'
                : 'Your API key'}
          </Badge>
          <span className="mono" style={{ color: 'var(--ink-muted)' }}>
            decision {explanation.decisionHash.slice(0, 10)}…
          </span>
        </div>
      </div>

      <div className="sec__body" style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {explanation.fallbackUsed ? (
          <Alert tone="warning" title="The model request failed">
            This is the deterministic explanation instead. No financial value changed — the
            explanation is the only thing a model ever touches.
          </Alert>
        ) : null}

        <blockquote
          className="quote"
          style={{
            margin: 0,
            padding: '0 0 0 28px',
            borderLeft: '4px solid var(--accent)',
            fontSize: 28,
            lineHeight: '38px',
            fontWeight: 500,
            letterSpacing: '-0.01em',
          }}
        >
          {explanation.explanation.summary}
        </blockquote>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
            gap: '28px 32px',
          }}
        >
          {parts.map((part) => (
            <div key={part.title}>
              <h3 style={{ margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 700 }}>
                {part.title}
              </h3>
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: 15,
                  lineHeight: '22px',
                  color: 'var(--ink-muted)',
                }}
              >
                {part.body}
              </p>
            </div>
          ))}
          <div>
            <h3 style={{ margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 700 }}>
              Main risks
            </h3>
            <ul
              style={{
                margin: '4px 0 0',
                paddingLeft: 18,
                fontSize: 15,
                lineHeight: '22px',
                color: 'var(--ink-muted)',
              }}
            >
              {explanation.explanation.mainRisks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '16px 32px',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 24,
            borderTop: '1px solid var(--line)',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: '18px',
              color: 'var(--ink-muted)',
              maxWidth: 520,
            }}
          >
            Changing the provider, model, endpoint or key cannot change the decision hash,
            eligibility, ranking or any amount. <a href="/settings">Explanation settings</a>
          </p>
          {hasWinner ? (
            <ButtonLink href="/authorize" variant="secondary">
              Prepare authorization
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </section>
  );
}

'use client';

/*
 * `/authorize` — prepare, review the policy, review the execution, submit.
 *
 * The invariants this component exists to hold:
 *
 *   - the prepared objects are passed to `execute` BY REFERENCE, exactly as the
 *     backend sent them. Nothing here rebuilds, rounds, reorders or
 *     re-serializes a financial object;
 *   - two signatures, two separate screens, two separate wallet prompts. They
 *     are never merged into one consent;
 *   - any expiry, account change or chain change throws away both signatures
 *     and the preparation. A signature is never submitted against state the
 *     user has moved away from;
 *   - the connected account must equal `intent.borrower` and `plan.borrower`.
 */

import { getExecutionPlanTypedData, getRefinanceIntentTypedData } from '@debtshift/domain';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { HashValue } from '../../components/shell';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  PageLoading,
  Section,
  SectionRule,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api/client';
import type { PreparedMigration } from '../../lib/api/types';
import {
  formatDuration,
  formatTimestamp,
  formatUnixTimestamp,
  secondsUntilIso,
  secondsUntilUnix,
  truncateHex,
} from '../../lib/formatting';
import {
  canSubmit,
  environmentBadge,
  readEnvironment,
  submitBlockedReason,
  type BackendEnvironment,
} from '../../lib/environment';
import { MIGRATION_STORAGE_KEY } from '../../lib/storage-keys';
import { useEnvironment } from '../environment/environment-context';
import { isConnected, useWallet } from '../wallet/wallet-context';
import { glanceRows, groupReviewRows, type ReviewKind } from './review-groups';
import { intentRows, planRows, type ReviewRow } from './review-rows';
import { stepNote, stepStatus } from './step-notes';

type Step = 'prepare' | 'policy' | 'execution' | 'submit';

const STEP_LABELS: { readonly id: Step; readonly label: string }[] = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'policy', label: 'The policy' },
  { id: 'execution', label: 'The execution' },
  { id: 'submit', label: 'Submit' },
];

interface FlowState {
  readonly step: Step;
  readonly prepared?: PreparedMigration | undefined;
  readonly intentSignature?: string | undefined;
  readonly planSignature?: string | undefined;
  readonly busy?: boolean;
  readonly error?: string | undefined;
  readonly errorStatus?: number | undefined;
  /** Set when a window closed: both signatures are gone and must be redone. */
  readonly expired?: boolean;
}

const INITIAL: FlowState = { step: 'prepare' };

export function AuthorizeView() {
  const wallet = useWallet();
  const router = useRouter();
  const connected = isConnected(wallet);
  const [state, setState] = useState<FlowState>(INITIAL);
  const [, setTick] = useState(0);
  const epochRef = useRef(wallet.accountEpoch);

  // One second tick so the countdowns move without refetching anything.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  /*
   * Account or chain changed. Everything prepared or signed under the previous
   * account is now meaningless, so it is discarded rather than reused.
   */
  useEffect(() => {
    if (epochRef.current === wallet.accountEpoch) return;
    epochRef.current = wallet.accountEpoch;
    setState(INITIAL);
  }, [wallet.accountEpoch]);

  /*
   * Signing swaps the whole review for the next one. Without this the
   * reader is left where the old sign button was, half way down a different
   * list, and a screen reader is told nothing. Focus moves to the new
   * heading, which also brings it into view.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(state.step);
  useEffect(() => {
    if (previousStep.current === state.step) return;
    previousStep.current = state.step;
    if (state.step !== 'prepare') headingRef.current?.focus();
  }, [state.step]);

  const prepared = state.prepared;
  const { report: reportEnvironment } = useEnvironment();

  /*
   * The environment is whatever the backend said in this preparation — read
   * through the one function that understands both response shapes. It is
   * `undefined` when the backend said nothing usable, and the flow then fails
   * closed rather than assuming a sandbox.
   */
  const environment = useMemo(() => readEnvironment(prepared), [prepared]);
  const submitAllowed = canSubmit(environment);
  const blockedReason = submitBlockedReason(environment);

  /* ----------------------------------------------------------- the windows */

  const windows = useMemo(() => {
    if (prepared === undefined) return undefined;
    return {
      quote: secondsUntilIso(prepared.quote.expiresAt),
      deadline: secondsUntilUnix(prepared.plan.deadline),
      expiration: secondsUntilUnix(prepared.intent.expiration),
      financing: secondsUntilUnix(prepared.plan.financing.validUntil),
    };
    // Recomputed every tick: `setTick` above drives the re-render.
  }, [prepared, state.step, wallet.accountEpoch]);

  const remaining =
    windows === undefined
      ? undefined
      : Math.min(windows.quote, windows.deadline, windows.expiration, windows.financing);

  /*
   * A window closed. Both signatures are dropped: the contract is explicit that
   * an expired authorization must be prepared again, not submitted late.
   */
  useEffect(() => {
    if (prepared === undefined || remaining === undefined) return;
    if (remaining > 0) return;
    setState({ step: 'prepare', expired: true });
  }, [prepared, remaining]);

  /* ------------------------------------------------------------- the steps */

  const prepare = useCallback(async () => {
    if (!connected) return;
    setState({ step: 'prepare', busy: true });
    try {
      const result = await api.prepare(wallet.account);
      // Share it with the shell so the header badge shows what the backend
      // reported from here on, through signing and monitoring.
      reportEnvironment(readEnvironment(result));
      setState({ step: 'policy', prepared: result });
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : undefined;
      setState({
        step: 'prepare',
        // The backend fails closed outside the simulator workflow. Its words
        // are shown as they are: rewriting this as "wallet error" would hide
        // the real reason a refinance cannot be prepared.
        error: error?.message ?? 'The authorization could not be prepared.',
        errorStatus: error?.status,
      });
    }
  }, [connected, wallet.account, reportEnvironment]);

  const signIntent = useCallback(async () => {
    if (prepared === undefined) return;
    setState((current) => ({ ...current, busy: true, error: undefined }));
    try {
      const signature = await wallet.signTypedData(
        getRefinanceIntentTypedData(prepared.intent as never, prepared.verifyingContract as never),
      );
      setState((current) => ({
        ...current,
        busy: false,
        step: 'execution',
        intentSignature: signature,
      }));
    } catch (caught) {
      setState((current) => ({
        ...current,
        busy: false,
        error:
          caught instanceof Error
            ? `The policy signature was not completed. ${caught.message}`
            : 'The policy signature was not completed.',
      }));
    }
  }, [prepared, wallet]);

  const signPlan = useCallback(async () => {
    if (prepared === undefined) return;
    setState((current) => ({ ...current, busy: true, error: undefined }));
    try {
      const signature = await wallet.signTypedData(
        getExecutionPlanTypedData(prepared.plan as never, prepared.verifyingContract as never),
      );
      setState((current) => ({
        ...current,
        busy: false,
        step: 'submit',
        planSignature: signature,
      }));
    } catch (caught) {
      setState((current) => ({
        ...current,
        busy: false,
        error:
          caught instanceof Error
            ? `The execution signature was not completed. ${caught.message}`
            : 'The execution signature was not completed.',
      }));
    }
  }, [prepared, wallet]);

  const submit = useCallback(async () => {
    if (
      prepared === undefined ||
      state.intentSignature === undefined ||
      state.planSignature === undefined
    ) {
      return;
    }
    // The button is disabled in this case; this is the same rule applied where
    // it cannot be bypassed by re-enabling a control in devtools. The backend
    // enforces it again on its side.
    if (!canSubmit(readEnvironment(prepared))) return;
    setState((current) => ({ ...current, busy: true, error: undefined }));
    try {
      /*
       * The prepared objects go back BY REFERENCE. `prepared.intent` is the
       * same object the backend sent and this app parsed; it was never copied,
       * normalized or re-keyed on the way here.
       */
      const result = await api.execute({
        signedIntent: {
          intent: prepared.intent,
          intentHash: prepared.intentHash,
          signature: state.intentSignature,
        },
        signedPlan: {
          plan: prepared.plan,
          planHash: prepared.planHash,
          signature: state.planSignature,
        },
        quote: prepared.quote,
        sourceSnapshot: prepared.sourceSnapshot,
      });

      // Only the id is persisted — never a signature or a prepared payload.
      try {
        window.localStorage.setItem(MIGRATION_STORAGE_KEY, result.migrationId);
      } catch {
        // Storage being unavailable must not lose the migration: the router
        // push below still carries the id.
      }
      router.push(`/migrations/${result.migrationId}`);
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : undefined;
      setState((current) => ({
        ...current,
        busy: false,
        error: error?.message ?? 'The migration could not be started.',
        errorStatus: error?.status,
      }));
    }
  }, [prepared, state.intentSignature, state.planSignature, router]);

  /* ------------------------------------------------------------- the gates */

  // Not known yet whether a wallet or the demo is present: say so, rather
  // than flashing the connect prompt at someone who is already connected.
  if (wallet.status === 'initialising') {
    return <PageLoading label="Authorization" />;
  }

  if (!connected) {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <p className="eyebrow">Authorization</p>
        <h1 style={{ margin: '24px 0 0', fontSize: 40, lineHeight: '48px' }}>
          Connect a wallet to authorize a migration.
        </h1>
        <p style={{ marginTop: 16, fontSize: 18, color: 'var(--ink-muted)' }}>
          You will be asked for two separate signatures, and you can stop after either one.
        </p>
        <div style={{ marginTop: 24 }}>
          <Button onClick={() => void wallet.connect()} disabled={wallet.status === 'unavailable'}>
            Connect wallet
          </Button>
        </div>
      </section>
    );
  }

  const borrowerMatches =
    prepared === undefined ||
    (wallet.account.toLowerCase() === prepared.intent.borrower.toLowerCase() &&
      wallet.account.toLowerCase() === prepared.plan.borrower.toLowerCase());

  const requiredChain = prepared?.intent.sourcePosition.market.chainId;
  const chainMatches = requiredChain === undefined || wallet.chainId === requiredChain;
  const canSign = borrowerMatches && chainMatches && !state.busy;

  return (
    <>
      {prepared ? <EnvironmentBanner environment={environment} /> : null}

      <section
        className="page hero"
        style={{
          padding: '80px var(--page-gutter) 56px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <StepIndicator current={state.step} isDemo={wallet.isDemo} />

        {state.step === 'prepare' ? (
          <PrepareStep
            busy={state.busy === true}
            error={state.error}
            errorStatus={state.errorStatus}
            expired={state.expired === true}
            onPrepare={() => void prepare()}
          />
        ) : null}

        {prepared && state.step !== 'prepare' ? (
          <>
            <p className="eyebrow" style={{ marginTop: 32 }}>
              Signature {state.step === 'policy' ? '1' : '2'} of 2
            </p>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="hero__title"
              style={{
                margin: 0,
                fontSize: 80,
                lineHeight: '84px',
                fontWeight: 700,
                letterSpacing: '-0.03em',
                maxWidth: 1080,
              }}
            >
              {state.step === 'policy' ? (
                <>
                  Authorize the policy.{' '}
                  <span style={{ color: 'var(--ink-muted)' }}>The limits, not the route.</span>
                </>
              ) : state.step === 'execution' ? (
                <>
                  Authorize this exact execution.{' '}
                  <span style={{ color: 'var(--ink-muted)' }}>One route, fixed.</span>
                </>
              ) : (
                <>
                  Both signatures collected.{' '}
                  <span style={{ color: 'var(--ink-muted)' }}>Nothing has moved yet.</span>
                </>
              )}
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
              {state.step === 'policy'
                ? 'This signature sets the bounds any route must stay within. The exact route comes next, as a second, separate signature.'
                : state.step === 'execution'
                  ? 'This signature fixes the route, the amounts, the receivers, the quote and the deadline. Nothing outside it can execute.'
                  : 'Submitting hands both signatures to the backend, which verifies them before anything starts.'}
            </p>

            {windows ? <WindowStrip prepared={prepared} windows={windows} /> : null}

            {borrowerMatches ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  lineHeight: '20px',
                  color: 'var(--success)',
                  fontWeight: 600,
                }}
              >
                Connected wallet {truncateHex(wallet.account)} is intent.borrower — signing is
                allowed.
              </p>
            ) : (
              <Alert tone="danger" title="This account cannot sign this authorization">
                The prepared migration is for{' '}
                <span className="mono">{prepared.intent.borrower}</span>, but{' '}
                <span className="mono">{wallet.account}</span> is connected. Switch account, or
                prepare again for this one.
              </Alert>
            )}

            {!chainMatches ? (
              <Alert
                tone="warning"
                title={`Your wallet is not on chain ${String(requiredChain)}`}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void wallet.requestChain(requiredChain!)}
                  >
                    Switch network
                  </Button>
                }
              >
                The signature is bound to the source chain. Your wallet reports chain{' '}
                {wallet.chainId ?? 'unknown'}. DebtShift will ask — it never switches by itself.
              </Alert>
            ) : null}

            {state.error ? (
              <Alert tone="danger" title="That did not complete">
                {state.error}
                {state.errorStatus ? (
                  <>
                    {' '}
                    <span className="mono">HTTP {state.errorStatus}</span>
                  </>
                ) : null}
              </Alert>
            ) : null}
          </>
        ) : null}
      </section>

      {prepared && state.step === 'policy' ? (
        <>
          <SectionRule />
          <ReviewSection
            id="policy-review"
            kind="policy"
            number="01"
            title="The limits"
            note="Any route outside these numbers is refused, whatever its rate."
            rows={intentRows(prepared.intent, prepared.verifyingContract, prepared.intentHash)}
          />
          <SignBar
            eyebrow="Signature 1 of 2"
            label="Sign the policy"
            caption="Your wallet will show the EIP-712 payload. Signing here authorizes bounds only — no route, no amount is committed yet."
            disabled={!canSign}
            busy={state.busy === true}
            onSign={() => void signIntent()}
          />
        </>
      ) : null}

      {prepared && state.step === 'execution' ? (
        <>
          <SectionRule />
          <ReviewSection
            id="plan-review"
            kind="plan"
            number="02"
            title="The exact execution"
            note="Every value here is fixed by your signature. If any of it changes, the authorization is discarded and you review again."
            rows={planRows(prepared.plan, prepared.quote, prepared.planHash)}
          />
          <SignBar
            eyebrow="Signature 2 of 2"
            label="Sign the execution plan"
            caption="The second and last signature. After this nothing new is signed — the next step only submits what you already approved."
            disabled={!canSign}
            busy={state.busy === true}
            onSign={() => void signPlan()}
          />
        </>
      ) : null}

      {prepared && state.step === 'submit' ? (
        <>
          <SectionRule />
          <Section
            id="submit"
            number="03"
            title="Start the migration"
            note="The backend verifies both signatures and the financing again before it reserves anything."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <dl className="grid-facts" style={{ margin: 0 }}>
                <dt>Policy signature</dt>
                <dd className="is-control">
                  {wallet.isDemo ? (
                    <Badge
                      tone="warning"
                      title="The recorded demo signs nothing. This is a placeholder, not a signature."
                    >
                      Demo placeholder
                    </Badge>
                  ) : (
                    <Badge tone="success">Collected</Badge>
                  )}
                  <span className="mono">{truncateHex(state.intentSignature ?? '', 10, 8)}</span>
                </dd>
                <dt>Execution signature</dt>
                <dd className="is-control">
                  {wallet.isDemo ? (
                    <Badge
                      tone="warning"
                      title="The recorded demo signs nothing. This is a placeholder, not a signature."
                    >
                      Demo placeholder
                    </Badge>
                  ) : (
                    <Badge tone="success">Collected</Badge>
                  )}
                  <span className="mono">{truncateHex(state.planSignature ?? '', 10, 8)}</span>
                </dd>
                <dt>Migration</dt>
                <dd className="is-control">
                  <HashValue value={prepared.plan.migrationId} label="migration ID" />
                </dd>
              </dl>

              {wallet.isDemo ? (
                <Alert tone="warning" title="Nothing is submitted in the demo">
                  No wallet signed anything and no backend is contacted. The next screen replays a
                  migration that was recorded on the contract-backed sandbox.
                </Alert>
              ) : null}

              <Alert tone="info" title="Submitting is not completion">
                Starting a migration begins a workflow with phases. Only the phase{' '}
                <span className="mono">COMPLETED</span> means the refinance is finished and
                reconciled.
              </Alert>

              {blockedReason ? (
                <Alert tone="warning" title="Submission is not available here">
                  {blockedReason}
                </Alert>
              ) : null}

              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <Button
                  onClick={() => void submit()}
                  disabled={state.busy === true || !submitAllowed}
                >
                  {state.busy === true
                    ? wallet.isDemo
                      ? 'Opening the recording…'
                      : 'Submitting…'
                    : wallet.isDemo
                      ? 'Replay the recorded migration'
                      : 'Submit both signatures'}
                </Button>
                <Button variant="secondary" onClick={() => setState(INITIAL)}>
                  Discard and start over
                </Button>
              </div>
            </div>
          </Section>
        </>
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------- banner */

function EnvironmentBanner({
  environment,
}: {
  readonly environment: BackendEnvironment | undefined;
}) {
  const badge = environmentBadge(environment);
  const unknown = environment === undefined;
  return (
    <div
      role="note"
      style={{
        background: unknown ? 'var(--warning-soft)' : 'var(--accent-soft)',
        color: 'var(--ink)',
      }}
    >
      <div
        className="page"
        style={{
          padding: '12px var(--page-gutter)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 16px',
          alignItems: 'center',
          fontSize: 14,
          lineHeight: '20px',
        }}
      >
        <strong>{badge.label}</strong>
        {/* The backend's own warning string, verbatim, when it sends one. */}
        {environment?.warning ? <span>{environment.warning}</span> : null}
        <span style={{ color: 'var(--ink-muted)' }}>
          {unknown
            ? 'The backend did not report an environment this app can read. Nothing can be submitted.'
            : `Mode ${environment.mode} · transport ${environment.transportProvider}${
                environment.transportProvider === 'DEBTSHIFT_SIMULATOR'
                  ? ' (simulated — not a 1Click transaction)'
                  : ''
              }`}
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- indicator */

function StepIndicator({ current, isDemo }: { readonly current: Step; readonly isDemo: boolean }) {
  const currentIndex = STEP_LABELS.findIndex((step) => step.id === current);
  return (
    <ol className="stepper" aria-label="Authorization steps">
      {STEP_LABELS.map((step, index) => {
        const status = stepStatus(index, currentIndex);
        return (
          <li
            key={step.id}
            className="stepper__step"
            data-status={status}
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <span className="stepper__dot num" aria-hidden="true">
              {status === 'done' ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              ) : (
                index + 1
              )}
            </span>
            <span className="stepper__text">
              <span className="stepper__label">{step.label}</span>
              <span className="stepper__note">{stepNote(step.id, status, isDemo)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------ prepare step */

function PrepareStep({
  busy,
  error,
  errorStatus,
  expired,
  onPrepare,
}: {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly errorStatus: number | undefined;
  readonly expired: boolean;
  readonly onPrepare: () => void;
}) {
  return (
    <>
      <p className="eyebrow" style={{ marginTop: 32 }}>
        Step 1 of 4
      </p>
      <h1
        className="hero__title"
        style={{
          margin: 0,
          fontSize: 72,
          lineHeight: '76px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          maxWidth: 1040,
        }}
      >
        Get the exact terms.{' '}
        <span style={{ color: 'var(--ink-muted)' }}>Then read them before you sign.</span>
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
        Preparing binds a transport quote and fixes every amount. The terms are short-lived on
        purpose — if a window closes before you submit, you prepare again.
      </p>

      {expired ? (
        <Alert tone="warning" title="The authorization window closed">
          Both signatures were discarded. Nothing was submitted and nothing moved. Prepare again to
          get fresh terms.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="danger" title="The authorization could not be prepared">
          {error}
          {errorStatus ? (
            <>
              {' '}
              <span className="mono">HTTP {errorStatus}</span>
            </>
          ) : null}
        </Alert>
      ) : null}

      <div className="actions" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Button onClick={onPrepare} disabled={busy}>
          {busy ? 'Preparing…' : expired || error ? 'Prepare again' : 'Prepare authorization'}
        </Button>
        <ButtonLink href="/routes" variant="secondary">
          Back to routes
        </ButtonLink>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ window strip */

function WindowStrip({
  prepared,
  windows,
}: {
  readonly prepared: PreparedMigration;
  readonly windows: {
    readonly quote: number;
    readonly deadline: number;
    readonly expiration: number;
    readonly financing: number;
  };
}) {
  const entries = [
    {
      key: 'quote',
      label: 'Transport quote',
      seconds: windows.quote,
      detail: formatTimestamp(prepared.quote.expiresAt),
    },
    {
      key: 'deadline',
      label: 'Plan deadline',
      seconds: windows.deadline,
      detail: `${formatUnixTimestamp(prepared.plan.deadline)} · ${prepared.plan.deadline}`,
    },
    {
      key: 'expiration',
      label: 'Policy expiration',
      seconds: windows.expiration,
      detail: `${formatUnixTimestamp(prepared.intent.expiration)} · ${prepared.intent.expiration}`,
    },
  ];
  const governing = entries.reduce((min, entry) => (entry.seconds < min.seconds ? entry : min));

  return (
    <div
      className="figs num"
      role="group"
      aria-label="Authorization windows"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: '0 var(--space-6)',
        marginTop: 16,
        borderTop: '2px solid var(--ink)',
      }}
    >
      {entries.map((entry) => {
        const governs = entry.key === governing.key;
        const urgent = entry.seconds <= 60;
        return (
          <div
            key={entry.key}
            role="timer"
            style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <span
              style={{
                fontSize: 14,
                lineHeight: '20px',
                fontWeight: governs ? 700 : 400,
                color: governs ? 'var(--accent-strong)' : 'var(--ink-muted)',
              }}
            >
              {entry.label}
              {governs ? ' · governs' : ''}
            </span>
            <span
              className="figs__amount"
              style={{
                fontSize: 56,
                lineHeight: '60px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: urgent ? 'var(--danger)' : governs ? undefined : 'var(--ink-muted)',
              }}
            >
              {formatDuration(entry.seconds)}
            </span>
            <span style={{ fontSize: 13, lineHeight: '18px', color: 'var(--ink-muted)' }}>
              {entry.detail}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- review section */

function ReviewSection({
  id,
  kind,
  number,
  title,
  note,
  rows,
}: {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly number: string;
  readonly title: string;
  readonly note: string;
  readonly rows: readonly ReviewRow[];
}) {
  const groups = groupReviewRows(kind, rows);
  const glance = glanceRows(kind, rows);

  return (
    <Section id={id} number={number} title={title} note={note}>
      <div className="review">
        {glance.length > 0 ? (
          <div className="review__glance" role="group" aria-label="At a glance">
            <p className="review__glance-title">
              At a glance
              <span>
                {' '}
                · all {rows.length} signed fields are below, and every one of them counts
              </span>
            </p>
            <div className="review__glance-grid">
              {glance.map((row) => (
                <div key={row.key} className="review__glance-item">
                  <span className="review__glance-label">{row.label}</span>
                  <span
                    className="review__glance-value num"
                    style={row.tone ? { color: `var(--${row.tone})` } : undefined}
                  >
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {groups.map((group) => (
          <div key={group.title} className="review__group">
            <h3 className="review__group-title">
              {group.title}
              <span className="review__group-count num" aria-hidden="true">
                {group.rows.length}
              </span>
            </h3>
            <dl className="facts review__rows">
              {group.rows.map((row) => (
                <div key={row.key} className="review__row">
                  <dt>{row.label}</dt>
                  <dd className="num">
                    <span
                      className="review__value"
                      style={row.tone ? { color: `var(--${row.tone})` } : undefined}
                    >
                      {row.value}
                    </span>
                    {row.raw ? <span className="mono review__raw">{row.raw}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ sign bar */

/*
 * The sign bar follows the reader down the review, so the action is always in
 * reach — but it stays after the terms in the document, which is the order a
 * keyboard or a screen reader meets them in.
 */
function SignBar({
  eyebrow,
  label,
  caption,
  disabled,
  busy,
  onSign,
}: {
  readonly eyebrow: string;
  readonly label: string;
  readonly caption: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onSign: () => void;
}) {
  return (
    <section className="page signbar" aria-label={eyebrow}>
      <div className="signbar__inner">
        <div className="signbar__text">
          <span className="signbar__eyebrow">{eyebrow}</span>
          <p className="signbar__caption">{caption}</p>
        </div>
        <Button className="dsh-btn--lg" onClick={onSign} disabled={disabled || busy}>
          {busy ? 'Waiting for your wallet…' : label}
        </Button>
      </div>
    </section>
  );
}

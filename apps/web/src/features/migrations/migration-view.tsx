'use client';

/*
 * `/migrations/[id]` — the authoritative monitoring view.
 *
 * The one thing this page must never do is imply completion. A provider
 * success, a broadcast transaction, a queue acknowledgement or a SETTLED phase
 * are all shown as what they are. `COMPLETED` is the only state that reads as
 * finished, and `FAILED_SAFE` says in words that it does not mean the solver
 * was repaid.
 */

import { useEffect, useMemo, useState } from 'react';

import { HashValue } from '../../components/shell';
import { Alert, Badge, ButtonLink, SectionRule, Section, Button } from '../../components/ui';
import type {
  Command,
  Evidence,
  LedgerEntry,
  MigrationDetails,
  MigrationPhase,
} from '../../lib/api/types';
import { formatRelativeAge, formatTimestamp, truncateHex } from '../../lib/formatting';
import {
  COMMAND_STATUS_LABELS,
  COMMAND_TYPE_LABELS,
  EVIDENCE_TYPE_LABELS,
  LEDGER_CATEGORY_LABELS,
  ledgerComponentLabel,
  PHASE_LABELS,
  VERIFICATION_STATE_LABELS,
} from '../../lib/labels';
import { flowStageForPhase } from '../../components/flow/flow-stage';
import { MigrationFlow } from '../../components/flow/migration-flow';
import { explorerTransactionUrl } from '../../lib/chains';
import { isDemoActive } from '../../lib/demo';
import { MIGRATION_STORAGE_KEY } from '../../lib/storage-keys';
import { useEnvironment } from '../environment/environment-context';
import {
  evidenceProvenanceLine,
  isSimulatedTransport,
  readFlowLabels,
  readRecoveryReason,
} from './evidence-line';
import { buildTimeline, isOffTrack, phasePosition } from './phase-timeline';
import { useMigrationPolling } from './use-migration';

export function MigrationView({ migrationId }: { readonly migrationId: string }) {
  const poll = useMigrationPolling(migrationId);
  const details = poll.details;

  // Remember the id so a refresh can come straight back here.
  useEffect(() => {
    try {
      window.localStorage.setItem(MIGRATION_STORAGE_KEY, migrationId);
    } catch {
      // Storage refusal is not a reason to fail the page.
    }
  }, [migrationId]);

  if (poll.status === 'missing') {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <div
          style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <p className="eyebrow">Migration</p>
          <h1 style={{ margin: 0, fontSize: 40, lineHeight: '48px' }}>No such migration.</h1>
          <p style={{ margin: 0, fontSize: 18, color: 'var(--ink-muted)' }}>
            The backend has no record of{' '}
            <span className="mono">{truncateHex(migrationId, 10, 8)}</span>.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <ButtonLink href="/position">Back to the position</ButtonLink>
            <ButtonLink href="/history" variant="secondary">
              See past migrations
            </ButtonLink>
          </div>
        </div>
      </section>
    );
  }

  if (details === undefined) {
    return (
      <section className="page" style={{ padding: '96px var(--page-gutter)' }}>
        <p className="eyebrow">Migration {truncateHex(migrationId, 10, 6)}</p>
        <h1
          aria-busy="true"
          style={{
            margin: '24px 0 0',
            fontSize: 40,
            lineHeight: '48px',
            color: 'var(--ink-muted)',
          }}
        >
          {poll.status === 'retrying' ? 'Reconnecting to the API…' : 'Reading the migration…'}
        </h1>
        {poll.error ? (
          <div style={{ marginTop: 24, maxWidth: 680 }}>
            <Alert tone="warning" title="The API is not answering">
              {poll.error} Retrying every {Math.round(poll.nextAttemptMs / 1000)} s. The migration
              id is kept: <span className="mono">{migrationId}</span>
            </Alert>
          </div>
        ) : null}
      </section>
    );
  }

  const phase = details.migration.phase;
  const label = PHASE_LABELS[phase];

  return (
    <>
      <EnvironmentNote />

      <MigrationHero details={details} poll={poll} />

      {isOffTrack(phase) ? <OffTrackPanel details={details} /> : null}
      {phase === 'COMPLETED' ? <CompletedPanel details={details} /> : null}
      {phase === 'SETTLED' ? <SettledNote /> : null}

      <SectionRule />
      <CommandsSection commands={details.commands} />

      <SectionRule />
      <EvidenceSection evidence={details.evidence} />

      <SectionRule />
      <LedgerSection ledger={details.ledger} phase={phase} />

      <SectionRule />
      <EventsSection details={details} label={label.label} />
    </>
  );
}

/* ------------------------------------------------------------------- notes */

function EnvironmentNote() {
  const { badge } = useEnvironment();
  // Read from the demo flag, not the wallet context: the monitor has to work
  // with no wallet at all, for instance from a shared link.
  const label = isDemoActive() ? 'Recorded sandbox run' : badge.label;
  return (
    <div role="note" style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
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
        <strong>{label}</strong>
        {/*
          The sandbox is contract-backed: the chain transactions below are
          real ones on their chains. Only the transport provider can be a
          simulation, and each such observation is marked on its own row.
        */}
        <span style={{ color: 'var(--ink-muted)' }}>
          Chain transactions listed here are real on their chains. A transport observation marked
          simulated is not a 1Click transaction.
        </span>
      </div>
    </div>
  );
}

function SettledNote() {
  return (
    <section className="page" style={{ padding: '0 var(--page-gutter) 24px' }}>
      <Alert tone="warning" title="The solver is repaid. This is not the end.">
        Your new loan is open and the money side is final. The migration is complete only once its
        receipt is recorded on NEAR. Where no registry is configured, as in the sandbox, it stays at
        this phase.
      </Alert>
    </section>
  );
}

/* -------------------------------------------------------------------- hero */

function MigrationHero({
  details,
  poll,
}: {
  readonly details: MigrationDetails;
  readonly poll: ReturnType<typeof useMigrationPolling>;
}) {
  const phase = details.migration.phase;
  const label = PHASE_LABELS[phase];
  const timeline = useMemo(() => buildTimeline(phase, details.events), [phase, details.events]);
  const position = phasePosition(phase);
  const flowLabels = useMemo(() => readFlowLabels(details.evidence), [details.evidence]);

  return (
    <section
      className="page hero"
      style={{
        padding: '80px var(--page-gutter) 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 24px', alignItems: 'center' }}>
        <p className="eyebrow">
          Migration {truncateHex(details.migration.migrationId, 6, 4)}
          {position ? ` · ${position}` : ''}
        </p>
        <PollIndicator poll={poll} />
      </div>

      <h1 className="hero-title">{label.label}.</h1>

      {/*
        The phase caption is announced: a borrower watching this page should
        hear the change without having to re-read the whole screen.
      */}
      <p
        aria-live="polite"
        className="hero__lede"
        style={{
          margin: 0,
          fontSize: 20,
          lineHeight: '30px',
          color: 'var(--ink-muted)',
          maxWidth: 820,
        }}
      >
        {label.caption}
      </p>

      {/*
        The same cross-chain picture as the landing page, but here it is not
        an illustration: its stage is derived from the phase the API reported
        and nothing else, so it can never run ahead of the backend.
      */}
      <div className="glass" style={{ padding: 'var(--space-5)', maxWidth: 860 }}>
        <MigrationFlow
          stage={flowStageForPhase(phase)}
          transportLabel={flowLabels.transport}
          source={{ protocol: 'Source market', chain: flowLabels.sourceChain }}
          destination={{ protocol: 'Destination market', chain: flowLabels.destinationChain }}
          compact
        />
      </div>

      {poll.status === 'retrying' ? (
        <Alert
          tone="warning"
          title="The API is not answering"
          action={
            <Button size="sm" variant="secondary" onClick={poll.refresh}>
              Retry now
            </Button>
          }
        >
          Showing the last state read{' '}
          {poll.updatedAt ? formatRelativeAge(poll.updatedAt.toISOString()) : 'earlier'}. Retrying
          every {Math.round(poll.nextAttemptMs / 1000)} s. Nothing has been lost — the migration
          continues on the backend whether this page can see it or not.
        </Alert>
      ) : null}

      {!isOffTrack(phase) ? (
        <ol
          className="phases"
          aria-label="Migration phases"
          style={{
            listStyle: 'none',
            margin: '24px 0 0',
            padding: 0,
            display: 'grid',
            gridTemplateColumns: `repeat(${timeline.length}, minmax(0, 1fr))`,
            gap: '0 8px',
          }}
        >
          {timeline.map((step, index) => (
            <li
              key={step.phase}
              aria-current={step.state === 'current' ? 'step' : undefined}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <span
                style={{
                  height: 4,
                  background:
                    step.state === 'done'
                      ? 'var(--ink)'
                      : step.state === 'current'
                        ? 'var(--accent)'
                        : 'var(--line)',
                }}
              />
              <span
                className="num"
                style={{
                  fontSize: 12,
                  color: step.state === 'current' ? 'var(--accent-strong)' : 'var(--ink-muted)',
                  fontWeight: step.state === 'current' ? 700 : 400,
                }}
              >
                {String(index + 1).padStart(2, '0')}
                {step.at
                  ? `${step.state === 'current' ? ' · since ' : ' · '}${new Date(step.at).toISOString().slice(11, 19)}`
                  : ''}
              </span>
              <span
                style={{
                  fontSize: 14,
                  lineHeight: '18px',
                  fontWeight: step.state === 'pending' ? 400 : step.state === 'current' ? 700 : 600,
                  color:
                    step.state === 'pending'
                      ? 'var(--ink-muted)'
                      : step.state === 'current'
                        ? 'var(--accent-strong)'
                        : undefined,
                }}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function PollIndicator({ poll }: { readonly poll: ReturnType<typeof useMigrationPolling> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const colour =
    poll.status === 'live'
      ? 'var(--success)'
      : poll.status === 'retrying'
        ? 'var(--danger)'
        : poll.status === 'paused'
          ? 'var(--warning)'
          : 'var(--line-strong)';

  const text =
    poll.status === 'live'
      ? `Live · polling every ${Math.round(1800 / 1000)} s`
      : poll.status === 'paused'
        ? 'Paused · this tab is in the background'
        : poll.status === 'retrying'
          ? `Retrying in ${Math.round(poll.nextAttemptMs / 1000)} s`
          : poll.status === 'stopped'
            ? 'Stopped · this migration reached a final phase'
            : 'Connecting';

  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 8,
        alignItems: 'center',
        fontSize: 13,
        lineHeight: '18px',
        fontWeight: 600,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: 4, background: colour }}
      />
      {text}
      {poll.updatedAt ? ` · updated ${formatRelativeAge(poll.updatedAt.toISOString())}` : ''}
    </span>
  );
}

/* --------------------------------------------------------- terminal panels */

function CompletedPanel({ details }: { readonly details: MigrationDetails }) {
  const finalized = details.evidence.filter((item) => item.verificationState === 'FINALIZED');
  return (
    <section className="page" style={{ padding: '0 var(--page-gutter) 24px' }}>
      <div
        style={{
          background: 'var(--surface-raised)',
          border: '2px solid var(--success)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-sm)',
          padding: 32,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span className="mono" style={{ color: 'var(--ink-muted)' }}>
            COMPLETED
          </span>
          <Badge tone="success">Finished and reconciled</Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 30, lineHeight: '38px', fontWeight: 600 }}>
          The refinance is complete.
        </h2>
        <p style={{ margin: 0, fontSize: 16, lineHeight: '24px', color: 'var(--ink-muted)' }}>
          Your old loan is closed, the new one is open, the solver is repaid and the ledger is
          reconciled. {finalized.length} piece{finalized.length === 1 ? '' : 's'} of evidence
          {finalized.length === 1 ? ' is' : ' are'} finalized.
        </p>
      </div>
    </section>
  );
}

function OffTrackPanel({ details }: { readonly details: MigrationDetails }) {
  const phase = details.migration.phase;
  const label = PHASE_LABELS[phase];
  const running = details.commands.find(
    (command) => command.status === 'RUNNING' || command.status === 'DISPATCHED',
  );
  const refundEntries = details.ledger.filter(
    (entry) => entry.category === 'REFUND' || entry.category === 'RESIDUAL',
  );
  const recoveryEvidence = details.evidence.filter((item) => item.type.startsWith('RECOVERY_'));
  const recoveryReason = readRecoveryReason(details.evidence);

  const tone = phase === 'EXPIRED' ? 'var(--line-strong)' : 'var(--warning)';

  return (
    <section className="page" style={{ padding: '0 var(--page-gutter) 24px' }}>
      <div
        style={{
          background: 'var(--surface-raised)',
          border: `2px solid ${tone}`,
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-sm)',
          padding: 32,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span className="mono" style={{ color: 'var(--ink-muted)' }}>
            {phase}
          </span>
          <Badge tone={phase === 'EXPIRED' ? 'neutral' : 'warning'}>{label.label}</Badge>
        </div>

        <h2 style={{ margin: 0, fontSize: 30, lineHeight: '38px', fontWeight: 600 }}>
          {phase === 'RECOVERY'
            ? 'Something went wrong. Funds are being returned along the signed refund path.'
            : phase === 'FAILED_SAFE'
              ? 'The migration did not complete. Custody and residual claims are known.'
              : phase === 'REQUOTE_REQUIRED'
                ? 'Market capacity changed. A new plan is required.'
                : 'The authorized window closed before completion.'}
        </h2>

        <p style={{ margin: 0, fontSize: 16, lineHeight: '24px', color: 'var(--ink-muted)' }}>
          {label.caption}
        </p>

        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: '170px minmax(0, 1fr)',
            gap: '10px 16px',
            fontSize: 14,
            lineHeight: '20px',
          }}
          className="grid-facts"
        >
          {running ? (
            <>
              <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>
                Running now
              </dt>
              <dd
                style={{
                  margin: 0,
                  padding: 0,
                  borderBottom: 0,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <strong>{COMMAND_TYPE_LABELS[running.type]}</strong>
                <span className="mono" style={{ color: 'var(--ink-muted)' }}>
                  {running.type} · attempt {running.logicalAttempt}
                </span>
              </dd>
            </>
          ) : null}

          {recoveryReason ? (
            <>
              {/*
                The backend records why recovery opened in the RECOVERY_OPENED
                evidence. It is shown as the backend wrote it — a code, not a
                paraphrase — because this is exactly what an operator will ask
                the borrower to read back.
              */}
              <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>Why</dt>
              <dd
                className="mono"
                style={{ margin: 0, padding: 0, borderBottom: 0, wordBreak: 'break-all' }}
              >
                {recoveryReason.reason}
                {recoveryReason.policy ? ` · ${recoveryReason.policy}` : ''}
              </dd>
            </>
          ) : null}

          {recoveryEvidence.length > 0 ? (
            <>
              <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>Evidence</dt>
              <dd
                style={{
                  margin: 0,
                  padding: 0,
                  borderBottom: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {recoveryEvidence.map((item) => (
                  <span
                    key={item.evidenceId}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    {EVIDENCE_TYPE_LABELS[item.type]}
                    <Badge tone={VERIFICATION_STATE_LABELS[item.verificationState].tone}>
                      {VERIFICATION_STATE_LABELS[item.verificationState].label}
                    </Badge>
                  </span>
                ))}
              </dd>
            </>
          ) : null}

          {refundEntries.length > 0 ? (
            <>
              <dt style={{ color: 'var(--ink-muted)', padding: 0, borderBottom: 0 }}>
                Refunds and residuals
              </dt>
              <dd
                style={{
                  margin: 0,
                  padding: 0,
                  borderBottom: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {refundEntries.map((entry) => (
                  <span key={entry.entryId} className="num">
                    {LEDGER_CATEGORY_LABELS[entry.category]} · {entry.amountUnits}{' '}
                    <span className="mono" style={{ color: 'var(--ink-muted)' }}>
                      base units · {entry.debitParty} → {entry.creditParty}
                    </span>
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>

        {phase === 'FAILED_SAFE' ? (
          <p
            style={{
              margin: 0,
              padding: 'var(--space-4)',
              background: 'var(--warning-soft)',
              borderRadius: 'var(--radius-md)',
              fontSize: 14,
              lineHeight: '20px',
            }}
          >
            <strong>Stopped safely does not mean the solver was repaid.</strong> It means the
            migration stopped in a state where custody and every residual claim are recorded, so
            what is owed to whom is known.
          </p>
        ) : null}

        {phase === 'REQUOTE_REQUIRED' ? (
          <>
            {/*
              The contract for this phase: say that capacity changed and a new
              plan is needed; never retry silently, never reuse a signature,
              never imply that funds entered recovery. Nothing moved, so this
              is styled as a notice and offers exactly one way forward.
            */}
            <p
              style={{
                margin: 0,
                padding: 'var(--space-4)',
                background: 'var(--warning-soft)',
                borderRadius: 'var(--radius-md)',
                fontSize: 14,
                lineHeight: '20px',
              }}
            >
              <strong>Nothing moved and nothing is in recovery.</strong> The check ran before your
              source loan was touched, and the liquidity reservation was released. Your two
              signatures cannot be reused: a fresh plan means reviewing and signing again.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <ButtonLink href="/routes">Compare routes again</ButtonLink>
            </div>
          </>
        ) : null}

        {phase === 'EXPIRED' ? (
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <ButtonLink href="/authorize">Prepare a new migration</ButtonLink>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- commands */

function CommandsSection({ commands }: { readonly commands: readonly Command[] }) {
  return (
    <Section
      id="commands"
      number="01"
      title="What is running"
      note="Commands the workflow owns. A retry is routine — you don't need to act."
    >
      {commands.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>No commands have been issued yet.</p>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '2px solid var(--ink)' }}>
          {commands.map((command) => {
            const status = COMMAND_STATUS_LABELS[command.status];
            return (
              <li
                key={command.commandId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: '4px 24px',
                  padding: '18px 0',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <span style={{ fontSize: 17, lineHeight: '24px', fontWeight: 600 }}>
                  {COMMAND_TYPE_LABELS[command.type]}
                  {status.caption ? (
                    <span style={{ fontWeight: 400, color: 'var(--ink-muted)' }}>
                      {' '}
                      — {status.caption}
                    </span>
                  ) : null}
                </span>
                <Badge tone={status.tone}>
                  {status.label}
                  {command.logicalAttempt > 1 ? ` · attempt ${command.logicalAttempt}` : ''}
                </Badge>
                <span
                  className="mono"
                  style={{ color: 'var(--ink-muted)', wordBreak: 'break-all' }}
                >
                  {command.type} · {command.idempotencyKey}
                </span>
                <span
                  className="num"
                  style={{ fontSize: 13, color: 'var(--ink-muted)', textAlign: 'right' }}
                >
                  {new Date(command.createdAt).toISOString().slice(11, 19)} →{' '}
                  {new Date(command.updatedAt).toISOString().slice(11, 19)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------- evidence */

function EvidenceSection({ evidence }: { readonly evidence: readonly Evidence[] }) {
  return (
    <Section
      id="evidence"
      number="02"
      title="What has been proven"
      note="Every claim comes with evidence and a verification state. The local chains have no explorer, so hashes are copyable text."
    >
      {evidence.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>No evidence has been recorded yet.</p>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '2px solid var(--ink)' }}>
          {evidence.map((item) => {
            const verification = VERIFICATION_STATE_LABELS[item.verificationState];
            const retracted = item.verificationState === 'RETRACTED';
            return (
              <li
                key={item.evidenceId}
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
                  <span
                    style={{
                      fontSize: 17,
                      lineHeight: '24px',
                      fontWeight: 600,
                      textDecoration: retracted ? 'line-through' : undefined,
                      color: retracted ? 'var(--ink-muted)' : undefined,
                    }}
                  >
                    {EVIDENCE_TYPE_LABELS[item.type]}
                  </span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    {isSimulatedTransport(item) ? (
                      <Badge
                        tone="neutral"
                        title="Produced by the DebtShift transport simulator, not by 1Click."
                      >
                        Simulated transport
                      </Badge>
                    ) : null}
                    <Badge tone={verification.tone} title={verification.caption}>
                      {verification.label}
                    </Badge>
                    <span className="num" style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                      {new Date(item.observedAt).toISOString().slice(11, 19)}
                    </span>
                  </span>
                </div>

                <p
                  className="mono"
                  style={{ margin: '4px 0 0', color: 'var(--ink-muted)', wordBreak: 'break-all' }}
                >
                  {evidenceProvenanceLine(item)}
                </p>
                {/*
                  A link only for a chain this app knows has a public explorer.
                  The sandbox chains have none, so their hashes stay as text.
                */}
                {explorerTransactionUrl(item.chainId, item.transactionHash) ? (
                  <p style={{ margin: 0, fontSize: 13 }}>
                    <a
                      href={explorerTransactionUrl(item.chainId, item.transactionHash)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      View transaction on the block explorer
                    </a>
                  </p>
                ) : null}
                <p className="mono" style={{ margin: 0, color: 'var(--ink-muted)' }}>
                  {item.verificationMethod} · {item.verifierVersion}
                </p>

                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 13, color: 'var(--accent-strong)', fontWeight: 600 }}>
                    Normalized payload
                  </summary>
                  <pre
                    className="mono"
                    style={{
                      margin: '6px 0 0',
                      padding: 'var(--space-3)',
                      background: 'var(--surface)',
                      borderRadius: 'var(--radius-md)',
                      overflowX: 'auto',
                      fontSize: 12,
                    }}
                  >
                    {JSON.stringify(item.normalizedPayload, null, 2)}
                  </pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ ledger */

function LedgerSection({
  ledger,
  phase,
}: {
  readonly ledger: readonly LedgerEntry[];
  readonly phase: MigrationPhase;
}) {
  const settledOrLater = ['SETTLED', 'COMPLETED'].includes(phase);

  return (
    <Section
      id="ledger"
      number="03"
      title="Where the value went"
      note="Double-entry: every row moves value between two distinct parties."
    >
      {ledger.length === 0 ? (
        <Alert tone={settledOrLater ? 'warning' : 'info'} title="No ledger entries recorded">
          {settledOrLater
            ? `The phase is ${phase}, which the specification treats as a point where a balanced ledger should exist. The backend has recorded none — worth raising rather than assuming it balanced.`
            : 'Entries appear as the migration settles.'}
        </Alert>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            className="num"
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 560 }}
          >
            <thead>
              <tr style={{ color: 'var(--ink-muted)', textAlign: 'left' }}>
                {['#', 'What', 'Amount', 'From', 'To', 'Chain'].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    style={{
                      padding: '8px 0',
                      fontWeight: 600,
                      borderBottom: '1px solid var(--line)',
                    }}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...ledger]
                .sort((left, right) => left.sequence - right.sequence)
                .map((entry) => (
                  <tr key={entry.entryId}>
                    <td style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                      {entry.sequence}
                    </td>
                    <td style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                      {ledgerComponentLabel(entry.componentCode) ??
                        LEDGER_CATEGORY_LABELS[entry.category] ??
                        entry.category}
                      {entry.componentCode ? (
                        <>
                          <br />
                          <span className="mono" style={{ color: 'var(--ink-muted)' }}>
                            {LEDGER_CATEGORY_LABELS[entry.category] ?? entry.category}
                            {entry.basis === 'SIGNED_COST_CLASSIFICATION'
                              ? ' · signed classification, not a movement'
                              : ''}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td
                      className="mono"
                      style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}
                    >
                      {entry.amountUnits}
                    </td>
                    <td
                      className="mono"
                      style={{
                        padding: '8px 0',
                        borderBottom: '1px solid var(--line)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {entry.debitParty}
                    </td>
                    <td
                      className="mono"
                      style={{
                        padding: '8px 0',
                        borderBottom: '1px solid var(--line)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {entry.creditParty}
                    </td>
                    <td style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                      {entry.chainId}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--ink-muted)' }}>
            Amounts are exact base units. {ledger.length} entr{ledger.length === 1 ? 'y' : 'ies'}.
          </p>
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ events */

function EventsSection({
  details,
  label,
}: {
  readonly details: MigrationDetails;
  readonly label: string;
}) {
  return (
    <Section
      id="events"
      number="04"
      title="The record"
      note="The authoritative event history, and the hashes that tie this migration to what you signed."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        <dl className="grid-facts" style={{ margin: 0 }}>
          <dt>Migration</dt>
          <dd className="is-control">
            <HashValue value={details.migration.migrationId} label="migration ID" full />
          </dd>
          <dt>Intent hash</dt>
          <dd className="is-control">
            <HashValue value={details.migration.intentHash} label="intent hash" />
          </dd>
          <dt>Plan hash</dt>
          <dd className="is-control">
            <HashValue value={details.migration.executionPlanHash} label="plan hash" />
          </dd>
          <dt>Quote hash</dt>
          <dd className="is-control">
            <HashValue value={details.migration.quoteHash} label="quote hash" />
          </dd>
          <dt>Borrower</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {details.migration.borrower}
          </dd>
          <dt>Phase</dt>
          <dd>
            {label} <span className="mono">({details.migration.phase})</span> · version{' '}
            <span className="num">{details.migration.version}</span>
          </dd>
          <dt>Started</dt>
          <dd className="num">{formatTimestamp(details.migration.createdAt)}</dd>
          <dt>Last change</dt>
          <dd className="num">{formatTimestamp(details.migration.updatedAt)}</dd>
          <dt>Reservations</dt>
          <dd className="num">{details.reservations.length}</dd>
        </dl>

        <details>
          <summary style={{ fontSize: 15, fontWeight: 600 }}>
            Event history · {details.events.length} entr
            {details.events.length === 1 ? 'y' : 'ies'}
          </summary>
          <ol style={{ listStyle: 'none', margin: '16px 0 0', padding: 0 }}>
            {[...details.events]
              .sort((left, right) => left.sequence - right.sequence)
              .map((event) => (
                <li
                  key={event.eventId}
                  style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span className="mono" style={{ fontWeight: 600 }}>
                      {event.sequence}. {event.type}
                    </span>
                    <span className="num" style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                      {PHASE_LABELS[event.phase].label} ·{' '}
                      {new Date(event.observedAt).toISOString().slice(11, 19)}
                    </span>
                  </div>
                </li>
              ))}
          </ol>
        </details>
      </div>
    </Section>
  );
}

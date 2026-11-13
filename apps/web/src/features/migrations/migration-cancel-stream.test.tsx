// @vitest-environment jsdom

/*
 * Cancellation, recovery responsibility and the live event stream on the
 * monitoring view.
 *
 * The fixtures are the real recorded migrations with the phase changed, as in
 * `migration-view.test.tsx`. What is checked here is the contract added with
 * the cancellation and recovery lifecycle: a request is shown as a request,
 * only the API's phase says "cancelled", no recovery step is offered to the
 * borrower, and a stream event is a prompt to re-read, never the state.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';
import type { MigrationDetails, MigrationPhase, RecoveryCase } from '../../lib/api/types';
import cancelledFixture from '../../lib/demo/recordings/migration-cancelled.json' with { type: 'json' };
import recoveryFixture from '../../lib/demo/recordings/migration-recovery.json' with { type: 'json' };
import fixture from '../../lib/demo/recordings/migration-settled.json' with { type: 'json' };

const settled = fixture as unknown as MigrationDetails;
const recovery = recoveryFixture as unknown as MigrationDetails;
/*
 * A REAL cancelled migration: executed on the local sandbox and cancelled by
 * its borrower before the reservation, as `GET /v1/migrations/:id` then
 * returned it.
 */
const cancelled = cancelledFixture as unknown as MigrationDetails;
const MIGRATION_ID = settled.migration.migrationId;

const migrationMock = vi.fn();
const cancelMock = vi.fn();
const streamUrlMock = vi.fn();

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return {
    ...actual,
    api: {
      migration: (...args: unknown[]) => migrationMock(...args) as unknown,
      cancelMigration: (...args: unknown[]) => cancelMock(...args) as unknown,
      migrationStreamUrl: (...args: unknown[]) => streamUrlMock(...args) as unknown,
    },
  };
});

function withPhase(phase: MigrationPhase, base: MigrationDetails = settled): MigrationDetails {
  return { ...base, migration: { ...base.migration, phase } };
}

async function renderMigration(details: MigrationDetails) {
  migrationMock.mockResolvedValue(details);
  const { MigrationView } = await import('./migration-view');
  const result = render(<MigrationView migrationId={details.migration.migrationId} />);
  await screen.findByRole('heading', { level: 1 });
  return result;
}

/** A stand-in for the browser's EventSource that a test can drive. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly #listeners = new Map<string, (() => void)[]>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(type: string) {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }

  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  streamUrlMock.mockReturnValue(undefined);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

/* ------------------------------------------------------------ cancellation */

describe('a migration that can still be cancelled', () => {
  it('offers cancellation only before the source loan is touched', async () => {
    await renderMigration(withPhase('RESERVED'));
    expect(screen.getByRole('button', { name: /cancel this migration/i })).toBeDefined();
    cleanup();

    for (const phase of ['SOURCE_CLOSED', 'ROUTING', 'SETTLED', 'RECOVERY'] as const) {
      await renderMigration(withPhase(phase));
      expect(screen.queryByRole('button', { name: /cancel this migration/i })).toBeNull();
      cleanup();
    }
  });

  it('asks twice: the first press sends nothing', async () => {
    await renderMigration(withPhase('RESERVED'));
    fireEvent.click(screen.getByRole('button', { name: /cancel this migration/i }));

    expect(cancelMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group', { name: /confirm cancellation/i });
    expect(within(confirm).getByText(/This cannot be undone/i)).toBeDefined();
    // Focus moves to the confirmation so a keyboard user lands on the question.
    expect(document.activeElement).toBe(confirm);
  });

  it('can be backed out of without sending anything', async () => {
    await renderMigration(withPhase('AUTHORIZED'));
    fireEvent.click(screen.getByRole('button', { name: /cancel this migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep it running/i }));

    expect(cancelMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /cancel this migration/i })).toBeDefined();
  });

  it('shows an accepted request as a request, not as a cancelled migration', async () => {
    cancelMock.mockResolvedValue({
      migrationId: MIGRATION_ID,
      phase: 'RESERVED',
      cancellationRequested: true,
    });
    await renderMigration(withPhase('RESERVED'));
    fireEvent.click(screen.getByRole('button', { name: /cancel this migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, cancel it/i }));

    expect(await screen.findByRole('heading', { name: /cancellation requested/i })).toBeDefined();
    expect(cancelMock).toHaveBeenCalledWith(MIGRATION_ID);
    expect(screen.getByText(/Until then the migration is not cancelled/i)).toBeDefined();
    // The phase on screen is still the one the API reported.
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toMatch(/cancelled/i);
    // And there is nothing left to press twice.
    expect(screen.queryByRole('button', { name: /cancel this migration/i })).toBeNull();
  });

  it('reads the migration again after asking', async () => {
    cancelMock.mockResolvedValue({
      migrationId: MIGRATION_ID,
      phase: 'RESERVED',
      cancellationRequested: true,
    });
    await renderMigration(withPhase('RESERVED'));
    const before = migrationMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /cancel this migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, cancel it/i }));
    await waitFor(() => expect(migrationMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('gives the backend reason when it is too late', async () => {
    const { ApiError } = await import('../../lib/api/client');
    cancelMock.mockRejectedValue(
      new ApiError({
        code: 'CONFLICT',
        status: 409,
        messages: ['Migration cancellation is not permitted from phase SOURCE_CLOSED.'],
        path: `/migrations/${MIGRATION_ID}/cancel`,
      }),
    );
    await renderMigration(withPhase('RESERVED'));
    fireEvent.click(screen.getByRole('button', { name: /cancel this migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, cancel it/i }));

    expect(
      await screen.findByText('Migration cancellation is not permitted from phase SOURCE_CLOSED.'),
    ).toBeDefined();
    expect(screen.getByText('The migration was not cancelled')).toBeDefined();
    expect(screen.queryByRole('heading', { name: /cancellation requested/i })).toBeNull();
  });

  it('recognises a request the backend already recorded', async () => {
    const reserved = withPhase('RESERVED');
    const recorded: MigrationDetails = {
      ...reserved,
      evidence: [
        ...reserved.evidence,
        {
          ...reserved.evidence[0]!,
          evidenceId: `0x${'cc'.repeat(32)}`,
          type: 'MIGRATION_CANCELLATION_REQUESTED',
        },
      ],
    };
    await renderMigration(recorded);
    expect(screen.getByRole('heading', { name: /cancellation requested/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /cancel this migration/i })).toBeNull();
  });

  it('is not offered in the recorded demo, where nothing can be cancelled', async () => {
    window.sessionStorage.setItem('debtshift:demo', '1');
    await renderMigration(withPhase('RESERVED'));
    expect(screen.queryByRole('button', { name: /cancel this migration/i })).toBeNull();
  });
});

describe('a cancelled migration', () => {
  it('says the source loan was not touched and that nothing is in recovery', async () => {
    const { container } = await renderMigration(withPhase('CANCELLED'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cancelled.');
    expect(
      screen.getByRole('heading', { name: /Your source loan was not touched/i }),
    ).toBeDefined();
    expect(screen.getByText(/Nothing moved and nothing is in recovery/i)).toBeDefined();
    // Off the forward track: no stepper, and nothing that reads as finished.
    expect(container.querySelector('[aria-label="Migration phases"]')).toBeNull();
    expect(screen.queryByText(/The refinance is complete/i)).toBeNull();
  });

  it('offers a fresh comparison, and no way to cancel again', async () => {
    await renderMigration(withPhase('CANCELLED'));
    expect(screen.getByRole('link', { name: /compare routes again/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /cancel this migration/i })).toBeNull();
  });

  it('stops reading: cancelled is final', async () => {
    await renderMigration(withPhase('CANCELLED'));
    expect(screen.getByText(/Stopped · this migration reached a final phase/)).toBeDefined();
  });
});

describe('a real cancelled migration, as the backend returned it', () => {
  it('is in the phase the test above assumes', () => {
    expect(cancelled.migration.phase).toBe('CANCELLED');
    expect(cancelled.ledger).toHaveLength(0);
    expect(cancelled.recoveryCases).toHaveLength(0);
  });

  it('renders as cancelled, with the borrower request among the evidence', async () => {
    await renderMigration(cancelled);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cancelled.');
    expect(screen.getByText('Cancellation requested by the borrower')).toBeDefined();
    // The reservation command was cancelled with it, and is listed as such.
    expect(screen.getByText('Reserve destination liquidity')).toBeDefined();
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  });

  it('shows nothing that reads as money having moved', async () => {
    await renderMigration(cancelled);
    expect(screen.getByText('No ledger entries recorded')).toBeDefined();
    expect(screen.queryByRole('heading', { name: /recovery responsibility/i })).toBeNull();
    expect(screen.queryByText(/The refinance is complete/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel this migration/i })).toBeNull();
  });
});

/* ----------------------------------------------------------- recovery cases */

describe('recovery responsibility', () => {
  const base = recovery.recoveryCases![0]!;
  const manual: RecoveryCase = {
    ...base,
    nextPermittedAction: 'RECONCILE_CANONICAL_STATE',
    actionDeadline: '2026-11-12T01:17:32.826Z',
    escalationOwner: 'DEBTSHIFT_OPERATIONS',
    escalationState: 'MANUAL_REVIEW_REQUIRED',
  };

  it('says who owns the next step, what it is and by when', async () => {
    await renderMigration({ ...recovery, recoveryCases: [manual] });
    const panel = screen.getByRole('article', { name: /recovery case/i });

    expect(within(panel).getByText('Manual review required')).toBeDefined();
    expect(within(panel).getByText(/Stopped for an operator/i)).toBeDefined();
    expect(within(panel).getByText('DEBTSHIFT_OPERATIONS')).toBeDefined();
    expect(within(panel).getByText('RECONCILE_CANONICAL_STATE')).toBeDefined();
    expect(within(panel).getByText(/Reconcile the on-chain state/)).toBeDefined();
    expect(within(panel).getByText('Deadline for that step')).toBeDefined();
  });

  it('lists what is outstanding as the backend recorded it', async () => {
    await renderMigration({ ...recovery, recoveryCases: [manual] });
    const panel = screen.getByRole('article', { name: /recovery case/i });
    expect(within(panel).getByText('CANONICALITY_INCIDENT')).toBeDefined();
    expect(
      within(panel).getByText('disposition REQUIRES_DIRECT_CHAIN_RECONCILIATION'),
    ).toBeDefined();
    expect(within(panel).getByText('affectedEvidenceIds 2 entries')).toBeDefined();
  });

  it('never hands the borrower a recovery action', async () => {
    await renderMigration({ ...recovery, recoveryCases: [manual] });
    const panel = screen.getByRole('article', { name: /recovery case/i });
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(within(panel).queryAllByRole('link')).toHaveLength(0);
  });

  it('keeps an automated recovery apart from one waiting for a person', async () => {
    await renderMigration({
      ...recovery,
      recoveryCases: [
        {
          ...manual,
          policy: 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
          nextPermittedAction: 'EXECUTE_SIGNED_RECOVERY',
          escalationState: 'AUTOMATED_RECOVERY_PENDING',
        },
      ],
    });
    const panel = screen.getByRole('article', { name: /recovery case/i });
    expect(within(panel).getByText('Automated recovery pending')).toBeDefined();
    expect(within(panel).getByText(/The workflow runs this itself/i)).toBeDefined();
    expect(within(panel).queryByText('Manual review required')).toBeNull();
  });

  it('renders a case recorded before the lifecycle fields existed', async () => {
    await renderMigration(recovery);
    const panel = screen.getByRole('article', { name: /recovery case/i });
    expect(within(panel).getByText('FINALIZED_CHAIN_EVIDENCE_REORGED')).toBeDefined();
    expect(within(panel).queryByText('Owner')).toBeNull();
    expect(within(panel).queryByText('Deadline for that step')).toBeNull();
  });

  it('shows no recovery panel when no case was opened', async () => {
    await renderMigration(settled);
    expect(screen.queryByRole('heading', { name: /recovery responsibility/i })).toBeNull();
  });
});

/* ---------------------------------------------------------- the live stream */

describe('the audit-event stream', () => {
  const STREAM_URL = `http://localhost:3001/v1/migrations/${MIGRATION_ID}/stream?after=7`;

  function installStream() {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    streamUrlMock.mockReturnValue(STREAM_URL);
  }

  it('opens after the last event already read, with the session cookie', async () => {
    installStream();
    const reserved = withPhase('RESERVED');
    await renderMigration(reserved);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const latest = Math.max(...reserved.events.map((event) => event.sequence));
    expect(streamUrlMock).toHaveBeenCalledWith(MIGRATION_ID, latest);
    expect(FakeEventSource.instances[0]!.url).toBe(STREAM_URL);
    expect(FakeEventSource.instances[0]!.withCredentials).toBe(true);
  });

  it('says it is polling until the stream is actually open', async () => {
    installStream();
    await renderMigration(withPhase('RESERVED'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(screen.getByText(/Live · polling/)).toBeDefined();

    act(() => FakeEventSource.instances[0]!.open());
    expect(await screen.findByText(/Live · event stream/)).toBeDefined();
  });

  it('answers an event by reading the migration, and shows what the read says', async () => {
    installStream();
    await renderMigration(withPhase('RESERVED'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    act(() => source.open());

    const before = migrationMock.mock.calls.length;
    migrationMock.mockResolvedValue(withPhase('SOURCE_CLOSED'));
    act(() => source.emit('migration'));

    await waitFor(() => expect(migrationMock.mock.calls.length).toBe(before + 1));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Old loan closed.');
  });

  it('closes the stream once the migration reaches a final phase', async () => {
    installStream();
    await renderMigration(withPhase('RESERVED'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    act(() => source.open());

    migrationMock.mockResolvedValue(withPhase('CANCELLED'));
    act(() => source.emit('migration'));

    await screen.findByText(/Stopped · this migration reached a final phase/);
    expect(source.closed).toBe(true);
  });

  it('falls back to polling when the stream drops, and reads at once', async () => {
    installStream();
    await renderMigration(withPhase('RESERVED'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    act(() => source.open());
    await screen.findByText(/Live · event stream/);

    const before = migrationMock.mock.calls.length;
    act(() => source.fail(0));
    expect(await screen.findByText(/Live · polling/)).toBeDefined();
    await waitFor(() => expect(migrationMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('opens no stream for a migration that is already final', async () => {
    installStream();
    await renderMigration(withPhase('COMPLETED'));
    await screen.findByText(/Stopped · this migration reached a final phase/);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('polls where there is no stream to open, as in the recorded demo', async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    streamUrlMock.mockReturnValue(undefined);
    await renderMigration(withPhase('RESERVED'));
    expect(screen.getByText(/Live · polling/)).toBeDefined();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

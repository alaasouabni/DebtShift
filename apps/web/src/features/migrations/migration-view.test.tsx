// @vitest-environment jsdom

/*
 * Rendering tests for the monitoring view.
 *
 * The acceptance criterion: "Phase timeline, recovery, and terminal-state
 * rendering", plus the rule that nothing may read as finished except
 * COMPLETED.
 *
 * The fixture is a REAL `GET /v1/migrations/:id` captured from the local
 * stack — 16 pieces of evidence, 7 commands, 7 events, and the four evidence
 * rows whose database columns come back null, which is what crashed this view
 * the first time it met live data.
 *
 * Terminal phases other than SETTLED are produced by changing the phase on
 * that real payload, because the local stack cannot currently reach them.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';

import type { MigrationDetails, MigrationPhase } from '../../lib/api/types';
import recoveryFixture from '../../lib/demo/recordings/migration-recovery.json' with { type: 'json' };
import fixture from '../../lib/demo/recordings/migration-settled.json' with { type: 'json' };

const settled = fixture as unknown as MigrationDetails;

const migrationMock = vi.fn();

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return {
    ...actual,
    api: { migration: (...args: unknown[]) => migrationMock(...args) as unknown },
  };
});

/** The same real payload, re-labelled with another phase. */
function withPhase(phase: MigrationPhase): MigrationDetails {
  return { ...settled, migration: { ...settled.migration, phase } };
}

async function renderMigration(details: MigrationDetails = settled) {
  migrationMock.mockResolvedValue(details);
  const { MigrationView } = await import('./migration-view');
  const result = render(<MigrationView migrationId={details.migration.migrationId} />);
  await screen.findByRole('heading', { level: 1 });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/* ------------------------------------------------------------ the timeline */

describe('the phase timeline', () => {
  it('renders all ten forward phases with the current one marked', async () => {
    await renderMigration();
    const list = screen.getByRole('list', { name: /migration phases/i });
    expect(list.querySelectorAll('li')).toHaveLength(10);

    const current = list.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Solver repaid');
  });

  it('counts the position against the ten', async () => {
    await renderMigration();
    expect(screen.getByText(/phase 9 of 10/i)).toBeDefined();
  });

  it('announces the phase caption politely', async () => {
    const { container } = await renderMigration();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('not the end');
  });
});

/* --------------------------------------------------------- what is running */

describe('commands', () => {
  it('lists every command with its type and status', async () => {
    await renderMigration();
    expect(screen.getByText('Reserve destination liquidity')).toBeDefined();
    expect(screen.getByText('Settle with the solver')).toBeDefined();
  });

  it('presents a retry as routine rather than as a failure the user must fix', async () => {
    await renderMigration();
    // The real fixture has FINALIZE_NEAR_RECEIPT retrying. Waited for rather
    // than read at once: under a loaded run the commands can render a tick
    // after the heading this helper waits on.
    expect(
      await screen.findByText(
        /This attempt failed and the workflow owns the retry\. No action from you\./,
      ),
    ).toBeDefined();
  });
});

/* -------------------------------------------------------------- evidence */

describe('evidence', () => {
  it('renders every piece with its verification state', async () => {
    await renderMigration();
    expect(screen.getByText('Policy signature verified')).toBeDefined();
    expect(screen.getAllByText('Finalized').length).toBeGreaterThan(0);
  });

  it('survives the rows whose database columns are null', async () => {
    // Four rows in the fixture have blockNumber, blockHash, chainId and
    // transactionHash all null. This is the exact payload that crashed the
    // view before `evidenceProvenanceLine` existed.
    const nullRows = settled.evidence.filter((item) => item.blockNumber === null);
    expect(nullRows.length).toBeGreaterThan(0);

    await renderMigration();
    expect(screen.getAllByText(/EIP712 · eip155:31337/).length).toBeGreaterThan(0);
  });

  it('shows a full chain reference when the backend recorded one', async () => {
    await renderMigration();
    expect(screen.getAllByText(/chain 31337 · block [\d,]+/).length).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------------- ledger */

describe('the ledger', () => {
  it('does not imply a balanced ledger when the backend recorded none', async () => {
    // A settled migration with no ledger is something the specification does
    // not expect. The page says so rather than rendering an empty table that
    // reads as "nothing owed".
    await renderMigration({ ...settled, ledger: [] });
    expect(screen.getByText(/No ledger entries recorded/i)).toBeDefined();
    expect(screen.getByText(/worth raising rather than assuming it balanced/i)).toBeDefined();
  });
});

describe('the recorded ledger', () => {
  it('lists every entry the backend recorded', async () => {
    expect(settled.ledger.length).toBeGreaterThan(0);
    await renderMigration();
    const table = [...document.querySelectorAll('table')].find((candidate) =>
      [...candidate.querySelectorAll('th')].some((heading) => heading.textContent === 'What'),
    );
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(settled.ledger.length);
    expect(screen.queryByText(/No ledger entries recorded/i)).toBeNull();
  });

  it('says in words what each entry is', async () => {
    await renderMigration();
    expect(screen.getAllByText('Old debt paid off').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Solver principal repaid').length).toBeGreaterThan(0);
  });

  it('marks a signed classification as not being a movement of funds', async () => {
    const classified = settled.ledger.filter(
      (entry) => entry.basis === 'SIGNED_COST_CLASSIFICATION',
    );
    expect(classified.length).toBeGreaterThan(0);
    await renderMigration();
    expect(screen.getAllByText(/signed classification, not a movement/i)).toHaveLength(
      classified.length,
    );
  });
});

/* -------------------------------------------------------- terminal states */

describe('what reads as finished', () => {
  it('does not present SETTLED as the end', async () => {
    await renderMigration();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Solver repaid.');
    expect(screen.getAllByText(/This is not the end/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/The refinance is complete/i)).toBeNull();
  });

  it('presents COMPLETED, and only COMPLETED, as finished', async () => {
    await renderMigration(withPhase('COMPLETED'));
    expect(screen.getByText(/The refinance is complete\./i)).toBeDefined();
    // The phrase appears in both the badge and the caption; one is enough.
    expect(screen.getAllByText(/Finished and reconciled/i).length).toBeGreaterThan(0);
  });

  it('presents RECOVERY as working, never as success or as a crash', async () => {
    await renderMigration(withPhase('RECOVERY'));
    expect(
      screen.getAllByText(/Funds are being returned along the signed refund path/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Not finished/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/The refinance is complete/i)).toBeNull();
  });

  it('states that FAILED_SAFE does not mean the solver was repaid', async () => {
    await renderMigration(withPhase('FAILED_SAFE'));
    expect(screen.getAllByText(/Custody and residual claims are known/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/does not mean the solver was repaid/i).length).toBeGreaterThan(0);
  });

  it('offers a fresh start on EXPIRED', async () => {
    await renderMigration(withPhase('EXPIRED'));
    expect(
      screen.getAllByText(/The authorized window closed before completion/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /prepare a new migration/i })).toBeDefined();
  });

  it('replaces the forward track rather than drawing a current step on it', async () => {
    const { container } = await renderMigration(withPhase('FAILED_SAFE'));
    // No pulsing "in progress" step under a failed-safe banner.
    expect(container.querySelector('[aria-label="Migration phases"]')).toBeNull();
  });
});

/* ------------------------------------------------------- failure handling */

describe('when the API stops answering', () => {
  it('reports a missing migration instead of retrying forever', async () => {
    const { ApiError } = await import('../../lib/api/client');
    migrationMock.mockRejectedValue(
      new ApiError({
        code: 'NOT_FOUND',
        status: 404,
        messages: ['Migration not found.'],
        path: '/x',
      }),
    );
    const { MigrationView } = await import('./migration-view');
    render(<MigrationView migrationId="0xabc" />);

    expect(await screen.findByText(/No such migration/i)).toBeDefined();
  });

  it('keeps the migration id on screen through a transient failure', async () => {
    const { ApiError } = await import('../../lib/api/client');
    migrationMock.mockRejectedValue(
      new ApiError({ code: 'NETWORK', status: 0, messages: ['unreachable'], path: '/x' }),
    );
    const { MigrationView } = await import('./migration-view');
    const id = settled.migration.migrationId;
    render(<MigrationView migrationId={id} />);

    expect(await screen.findByText(/The API is not answering/i)).toBeDefined();
    expect(screen.getByText(id)).toBeDefined();
  });
});

/* ------------------------------------------------------------ persistence */

describe('persistence', () => {
  it('remembers the id so a refresh resumes, and nothing else', async () => {
    await renderMigration();
    const stored = JSON.stringify(Object.fromEntries(Object.entries(window.localStorage)));
    expect(stored).toContain(settled.migration.migrationId);
    expect(stored).not.toContain(settled.migration.intentHash);
  });
});

/* ----------------------------------------------------- strategy 2026-11-12 */

describe('REQUOTE_REQUIRED', () => {
  it('says capacity changed and a new plan is needed', async () => {
    await renderMigration(withPhase('REQUOTE_REQUIRED'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New plan required.');
    expect(screen.getByText(/Market capacity changed\. A new plan is required\./)).toBeDefined();
  });

  it('states that nothing moved and nothing is in recovery', async () => {
    await renderMigration(withPhase('REQUOTE_REQUIRED'));
    expect(screen.getByText(/Nothing moved and nothing is in recovery\./)).toBeDefined();
    expect(screen.queryByText(/Funds are being returned/i)).toBeNull();
  });

  it('says the signatures cannot be reused and offers no retry', async () => {
    await renderMigration(withPhase('REQUOTE_REQUIRED'));
    expect(screen.getByText(/Your two\s+signatures cannot be reused/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByRole('link', { name: /compare routes again/i }).getAttribute('href')).toBe(
      '/routes',
    );
  });
});

describe('real receipts and simulated transport', () => {
  it('marks only the transport simulator observations as simulated', async () => {
    await renderMigration();
    const simulated = settled.evidence.filter((item) => item.provider === 'DEBTSHIFT_SIMULATOR');
    expect(simulated.length).toBeGreaterThan(0);
    expect(simulated.length).toBeLessThan(settled.evidence.length);
    // The phrase also labels the lane of the flow picture, so count the
    // per-row badges specifically.
    const badges = screen
      .getAllByText('Simulated transport')
      .filter((element) => element.classList.contains('dsh-badge'));
    expect(badges).toHaveLength(simulated.length);
  });

  it('says chain transactions are real and a simulated observation is not 1Click', async () => {
    await renderMigration();
    expect(
      screen.getByText(/Chain transactions listed here are real on their chains\./),
    ).toBeDefined();
  });

  it('builds no explorer link for the sandbox chains', async () => {
    await renderMigration();
    expect(screen.queryByRole('link', { name: /block explorer/i })).toBeNull();
  });

  it('links to the explorer once the evidence is on a known public chain', async () => {
    const hash = `0x${'cd'.repeat(32)}`;
    await renderMigration({
      ...settled,
      evidence: [
        { ...settled.evidence[0]!, chainId: 11155111, blockNumber: '5', transactionHash: hash },
      ],
    });
    expect(screen.getByRole('link', { name: /block explorer/i }).getAttribute('href')).toBe(
      `https://sepolia.etherscan.io/tx/${hash}`,
    );
  });
});

/* ------------------------------------------------ a REAL recovery migration */

describe('a real migration in recovery', () => {
  /*
   * Captured from the local stack on 2026-11-12: the worker opened recovery
   * with FINALIZED_CHAIN_EVIDENCE_REORGED and retracted two pieces of
   * evidence. Until then the recovery screen had only ever been rendered from
   * a relabelled SETTLED payload.
   */
  const recovery = recoveryFixture as unknown as MigrationDetails;

  it('is the real thing', () => {
    expect(recovery.migration.phase).toBe('RECOVERY');
    expect(recovery.evidence.some((item) => item.type === 'RECOVERY_OPENED')).toBe(true);
  });

  it('renders as working, with no forward track and no claim of completion', async () => {
    const { container } = await renderMigration(recovery);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Recovery in progress.');
    expect(container.querySelector('[aria-label="Migration phases"]')).toBeNull();
    expect(screen.queryByText(/The refinance is complete/i)).toBeNull();
  });

  it('shows why recovery opened, in the backend own words', async () => {
    await renderMigration(recovery);
    // The code also appears inside the expandable evidence payloads, so the
    // claim checked is the dedicated rows of the recovery case.
    const why = screen.getByText('Why').nextElementSibling;
    expect(why?.textContent).toContain('FINALIZED_CHAIN_EVIDENCE_REORGED');
    const policy = screen.getByText('Policy').nextElementSibling;
    expect(policy?.textContent).toContain('HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION');
    // The reason is stated once, not in two panels that could drift apart.
    expect(screen.getAllByText('Why')).toHaveLength(1);
  });

  it('strikes through the retracted evidence instead of hiding it', async () => {
    await renderMigration(recovery);
    const retracted = recovery.evidence.filter((item) => item.verificationState === 'RETRACTED');
    expect(retracted.length).toBeGreaterThan(0);
    expect(screen.getAllByText('Retracted')).toHaveLength(retracted.length);
  });

  it('keeps polling, because recovery is not a final phase', async () => {
    await renderMigration(recovery);
    expect(screen.getByText(/Live · polling/)).toBeDefined();
  });
});

/* ------------------------------------------------- the cross-chain picture */

describe('the flow picture on the monitor', () => {
  it('shows the stage that matches the authoritative phase', async () => {
    const { container } = await renderMigration();
    // SETTLED: the destination holds the loan.
    expect(container.querySelector('.flow')?.getAttribute('data-stage')).toBe('settled');
    expect(container.querySelector('.flow__node[data-role="to"]')?.className).toContain(
      'is-active',
    );
  });

  it('names the two chains from the evidence, not from a constant', async () => {
    const { container } = await renderMigration();
    const chains = [...container.querySelectorAll('.flow__chain')].map((node) => node.textContent);
    expect(chains).toEqual(['Sandbox source chain · 31337', 'Sandbox destination chain · 31338']);
  });

  it('labels the lane as simulated when the transport evidence is simulated', async () => {
    const { container } = await renderMigration();
    expect(container.querySelector('.flow__lane-label')?.textContent).toBe('Simulated transport');
  });

  it('runs the lane backwards during recovery', async () => {
    const { container } = await renderMigration(withPhase('RECOVERY'));
    expect(container.querySelector('.flow')?.getAttribute('data-stage')).toBe('returning');
    expect(container.querySelector('.flow__lane')?.getAttribute('data-direction')).toBe('backward');
  });

  it('shows nothing moving when a new plan is required', async () => {
    const { container } = await renderMigration(withPhase('REQUOTE_REQUIRED'));
    expect(container.querySelector('.flow')?.getAttribute('data-stage')).toBe('stopped');
    expect(container.querySelector('.flow__lane')?.getAttribute('data-direction')).toBe('none');
    // The source still holds the loan.
    expect(container.querySelector('.flow__node[data-role="from"]')?.className).toContain(
      'is-active',
    );
  });

  it('always states the stage in words, not only by animation', async () => {
    const { container } = await renderMigration();
    const caption = container.querySelector('.flow__caption');
    expect(caption?.textContent).toContain('Solver repaid');
    expect(caption?.getAttribute('aria-live')).toBe('polite');
  });
});

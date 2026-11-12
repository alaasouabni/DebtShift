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
import fixture from './__fixtures__/migration-settled.json' with { type: 'json' };

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
    // The real fixture has FINALIZE_NEAR_RECEIPT retrying.
    expect(
      screen.getByText(
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
    // The real SETTLED migration has zero ledger entries, which the
    // specification does not expect. The page says so rather than rendering an
    // empty table that reads as "nothing owed".
    expect(settled.ledger).toHaveLength(0);
    await renderMigration();
    expect(screen.getByText(/No ledger entries recorded/i)).toBeDefined();
    expect(screen.getByText(/worth raising rather than assuming it balanced/i)).toBeDefined();
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

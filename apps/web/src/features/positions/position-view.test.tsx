// @vitest-environment jsdom

/*
 * Rendering tests for the connected position page.
 *
 * Until these existed this screen had never been rendered connected by
 * anything: the in-app browser has no wallet extension, and no test mounted
 * it. It is the first page a borrower sees after connecting.
 *
 * The snapshot is the REAL `sourceSnapshot` from a captured
 * `POST /v1/migrations/prepare` — the seeded local position, 10 sWETH against
 * 10 000 sUSDC at 700 bps with a 1.5 health factor.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';
import type { PreparedMigration } from '../../lib/api/types';
import prepared from '../authorization/__fixtures__/prepared-migration.json' with { type: 'json' };

const snapshot = (prepared as unknown as PreparedMigration).sourceSnapshot;
const BORROWER = snapshot.position.borrower;
const OBSERVED_AT = Date.parse(snapshot.block.observedAt);

const positionMock = vi.fn();

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return {
    ...actual,
    api: { position: (...args: unknown[]) => positionMock(...args) as unknown },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/position',
}));

function installWallet() {
  (window as unknown as { ethereum: unknown }).ethereum = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [BORROWER];
      if (method === 'eth_chainId') return '0x7a69';
      throw new Error(`unexpected ${method}`);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

async function renderPosition() {
  const { PositionView } = await import('./position-view');
  const { WalletProvider } = await import('../wallet/wallet-context');
  const result = render(
    <WalletProvider>
      <PositionView />
    </WalletProvider>,
  );
  // Disconnected and loading both render an h1, so wait for the request and
  // then for the loading copy to go — not for a heading.
  await waitFor(() => expect(positionMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Reading your position/i)).toBeNull());
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  positionMock.mockResolvedValue(snapshot);
  // Five seconds after the block was observed: inside the freshness window.
  vi.setSystemTime(new Date(OBSERVED_AT + 5_000));
  installWallet();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

/* ----------------------------------------------------------------- amounts */

describe('the loan', () => {
  it('asks the backend for the connected account', async () => {
    await renderPosition();
    expect(String(positionMock.mock.calls[0]?.[0]).toLowerCase()).toBe(BORROWER.toLowerCase());
  });

  it('leads with the debt and the rate, formatted from base units', async () => {
    await renderPosition();
    const headline = screen.getByRole('heading', { level: 1 }).textContent ?? '';
    expect(headline).toContain('You owe 10,000.00 sUSDC');
    expect(headline).toContain('at 7.00% a year');
  });

  it('shows collateral, debt, rate and health', async () => {
    await renderPosition();
    const text = document.body.textContent ?? '';
    expect(text).toContain('10.0000');
    expect(text).toContain('sWETH');
    expect(text).toContain('7.00% APR');
    expect(text).toMatch(/1\.50\s*·\s*moderate/);
  });

  it('labels the health bands as display labels, with the backend authoritative', async () => {
    await renderPosition();
    expect(
      screen.getByText(/Bands are display labels; the backend.s value is authoritative\./),
    ).toBeDefined();
  });

  it('gives the health bar a text alternative', async () => {
    await renderPosition();
    const bar = screen.getByRole('img');
    expect(bar.getAttribute('aria-label')).toMatch(/Health factor 1\.50/);
    expect(bar.getAttribute('aria-label')).toMatch(/Liquidation below 1\.00/);
  });
});

/* -------------------------------------------------------------- raw values */

describe('raw values', () => {
  it('hides the exact base units until asked', async () => {
    await renderPosition();
    expect(document.body.textContent).not.toContain(snapshot.collateralUnits);
  });

  it('shows the exact strings the backend sent when toggled on', async () => {
    await renderPosition();
    fireEvent.click(screen.getByRole('button', { name: /show raw values/i }));

    const text = document.body.textContent ?? '';
    expect(text).toContain(`${snapshot.collateralUnits} · 18 decimals`);
    expect(text).toContain(`${snapshot.debtUnits} · 6 decimals`);
    expect(text).toContain(`borrowAprBps ${String(snapshot.borrowAprBps)}`);
    expect(text).toContain('healthFactorWad 1500000000000000000');
  });

  it('reports its state to assistive technology', async () => {
    await renderPosition();
    const toggle = screen.getByRole('button', { name: /show raw values/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: /hide raw values/i }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

/* -------------------------------------------------------------- provenance */

describe('provenance', () => {
  it('shows the block, the full borrower and both asset addresses', async () => {
    await renderPosition();
    const text = document.body.textContent ?? '';
    expect(text).toContain(snapshot.position.borrower);
    expect(text).toContain(snapshot.position.collateralAsset.address);
    expect(text).toContain(snapshot.position.debtAsset.address);
  });

  it('offers the block hash and the snapshot id to copy, in full', async () => {
    await renderPosition();
    expect(screen.getByRole('button', { name: /copy block hash/i }).getAttribute('title')).toBe(
      snapshot.block.hash,
    );
    expect(screen.getByRole('button', { name: /copy snapshot id/i }).getAttribute('title')).toBe(
      snapshot.snapshotId,
    );
  });

  it('shows how old the observation is', async () => {
    await renderPosition();
    expect(screen.getAllByText(/5 s ago/).length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- freshness */

describe('freshness', () => {
  it('reports a fresh snapshot with the time left in the window', async () => {
    await renderPosition();
    expect(screen.getByText(/Fresh · 25 s left/)).toBeDefined();
    expect(screen.queryByText(/aged past the policy window/i)).toBeNull();
  });

  it('says the window is the backend policy and that the backend decides', async () => {
    await renderPosition();
    expect(screen.getByText(/The backend decides, and it fails closed\./)).toBeDefined();
  });

  it('warns once the snapshot has aged out, and names the rejection to expect', async () => {
    vi.setSystemTime(new Date(OBSERVED_AT + 120_000));
    await renderPosition();

    expect(screen.getByText(/This snapshot has aged past the policy window/i)).toBeDefined();
    expect(screen.getByText('SOURCE_POSITION_STALE')).toBeDefined();
    expect(screen.getByText(/Stale · past the 30 s window/)).toBeDefined();
  });

  it('refetches when asked to refresh', async () => {
    vi.setSystemTime(new Date(OBSERVED_AT + 120_000));
    await renderPosition();
    const before = positionMock.mock.calls.length;

    fireEvent.click(screen.getAllByRole('button', { name: /refresh data/i })[0]!);
    await waitFor(() => expect(positionMock.mock.calls.length).toBeGreaterThan(before));
  });
});

/* ------------------------------------------------------------ other states */

describe('when there is no position', () => {
  it('treats the backend 400 as the empty state, not as a failure', async () => {
    // What the live API returns once a migration has consumed the position:
    // HTTP 400, not an empty list. This used to render a red error.
    const { ApiError } = await import('../../lib/api/client');
    positionMock.mockRejectedValue(
      new ApiError({
        code: 'VALIDATION',
        status: 400,
        messages: ['No supported local source position was found for this wallet.'],
        path: '/positions/x',
      }),
    );
    await renderPosition();

    expect(screen.getByText(/No refinanceable position for this account\./)).toBeDefined();
    expect(screen.queryByText(/The position could not be read/i)).toBeNull();
    // The backend's own sentence stays on screen.
    expect(
      screen.getByText(/No supported local source position was found for this wallet\./),
    ).toBeDefined();
  });

  it('also handles an empty list', async () => {
    positionMock.mockResolvedValue(undefined);
    await renderPosition();
    expect(screen.getByText(/No refinanceable position for this account\./)).toBeDefined();
  });
});

describe('when the API fails', () => {
  it('says the API is unreachable and offers a retry', async () => {
    const { ApiError } = await import('../../lib/api/client');
    positionMock.mockRejectedValue(
      new ApiError({ code: 'NETWORK', status: 0, messages: ['unreachable'], path: '/x' }),
    );
    await renderPosition();

    expect(screen.getByText(/The API could not be reached/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('shows a server error as an error, with its status', async () => {
    const { ApiError } = await import('../../lib/api/client');
    positionMock.mockRejectedValue(
      new ApiError({ code: 'SERVER', status: 500, messages: ['boom'], path: '/x' }),
    );
    await renderPosition();

    expect(screen.getByText(/The position could not be read/i)).toBeDefined();
    expect(screen.getByText(/HTTP 500/)).toBeDefined();
  });
});

describe('the next step', () => {
  it('links to the route comparison', async () => {
    await renderPosition();
    expect(screen.getByRole('link', { name: /compare routes/i }).getAttribute('href')).toBe(
      '/routes',
    );
  });
});

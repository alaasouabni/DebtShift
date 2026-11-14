// @vitest-environment jsdom

/*
 * Rendering tests for the connected diagnostics page.
 *
 * Like the position page, this screen had never been rendered connected before
 * these tests. The fixtures are REAL `GET /v1/positions/:wallet/history` and
 * `GET /v1/markets` responses from the local stack — persisted database rows,
 * whose shape is not the live snapshot's.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';
import type { MarketRow, PersistedPositionRow } from '../../lib/api/types';
import marketsFixture from '../../lib/demo/recordings/markets.json' with { type: 'json' };
import historyFixture from '../../lib/demo/recordings/position-history.json' with { type: 'json' };

const history = historyFixture as unknown as PersistedPositionRow[];
const markets = marketsFixture as unknown as MarketRow[];
const BORROWER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const MIGRATION_ID = '0x417411f1ce68a25a3c53a16336dcb00fd17c5b36ce05dceb083f6914a1132673';

const historyMock = vi.fn();
const marketsMock = vi.fn();

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return {
    ...actual,
    api: {
      positionHistory: (...args: unknown[]) => historyMock(...args) as unknown,
      markets: (...args: unknown[]) => marketsMock(...args) as unknown,
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/history',
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

async function renderHistory() {
  const { HistoryView } = await import('./history-view');
  const { WalletProvider } = await import('../wallet/wallet-context');
  const result = render(
    <WalletProvider>
      <HistoryView />
    </WalletProvider>,
  );
  await waitFor(() => expect(historyMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Reading the history/i)).toBeNull());
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  historyMock.mockResolvedValue(history);
  marketsMock.mockResolvedValue(markets);
  installWallet();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe('what the page claims to be', () => {
  it('says it is persisted data, not a live reading', async () => {
    await renderHistory();
    expect(screen.getByText(/Persisted rows, not a live reading\./)).toBeDefined();
    expect(screen.getByRole('link', { name: /the live position/i }).getAttribute('href')).toBe(
      '/position',
    );
  });
});

describe('persisted positions', () => {
  it('asks for the connected account', async () => {
    await renderHistory();
    expect(String(historyMock.mock.calls[0]?.[0]).toLowerCase()).toBe(BORROWER.toLowerCase());
  });

  it('renders the real database row with its market', async () => {
    await renderHistory();
    const market = history[0]!.market as { protocol: string; chainId: number; marketId: string };
    const text = document.body.textContent ?? '';
    expect(text).toContain(market.protocol.replace(/_/gu, ' '));
    expect(text).toContain(`chain ${String(market.chainId)}`);
    expect(text).toContain(market.marketId);
  });

  it('marks a row that has a snapshot', async () => {
    await renderHistory();
    expect(screen.getByText('Snapshot stored')).toBeDefined();
  });

  it('survives a row whose snapshot is null, which the left join allows', async () => {
    historyMock.mockResolvedValue([{ ...history[0]!, snapshot: null }]);
    await renderHistory();
    expect(screen.getByText('No snapshot')).toBeDefined();
  });

  it('says so when the wallet has no persisted position', async () => {
    historyMock.mockResolvedValue([]);
    await renderHistory();
    expect(screen.getByText(/No persisted position for/)).toBeDefined();
  });
});

describe('enabled markets', () => {
  it('lists every market the backend returned', async () => {
    await renderHistory();
    const text = document.body.textContent ?? '';
    for (const market of markets) {
      expect(text).toContain(String(market.marketId));
    }
  });

  it('still renders positions when the markets call fails', async () => {
    marketsMock.mockRejectedValue(new Error('markets down'));
    await renderHistory();
    expect(screen.getByText('Snapshot stored')).toBeDefined();
    expect(screen.getByText(/No enabled market was returned\./)).toBeDefined();
  });
});

describe('migrations from this browser', () => {
  it('says so when none was started here', async () => {
    await renderHistory();
    expect(screen.getByText(/No migration has been started from this browser yet\./)).toBeDefined();
  });

  it('links to the monitor for the retained migration id', async () => {
    window.localStorage.setItem('debtshift:last-migration-id', MIGRATION_ID);
    await renderHistory();
    expect(screen.getByRole('link', { name: /open the monitor/i }).getAttribute('href')).toBe(
      `/migrations/${MIGRATION_ID}`,
    );
  });
});

describe('when the history cannot be read', () => {
  it('shows the error with a retry that refetches', async () => {
    const { ApiError } = await import('../../lib/api/client');
    historyMock.mockRejectedValueOnce(
      new ApiError({ code: 'SERVER', status: 500, messages: ['database unavailable'], path: '/x' }),
    );
    await renderHistory();

    expect(screen.getByText(/The history could not be read/i)).toBeDefined();
    expect(screen.getByText(/database unavailable/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Snapshot stored');
  });
});

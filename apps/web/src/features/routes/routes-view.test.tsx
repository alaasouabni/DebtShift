// @vitest-environment jsdom

/*
 * Rendering tests for the route comparison.
 *
 * The acceptance criterion: "Eligible and rejected route rendering". The rule
 * underneath it is stronger — route rejection, stale data and shortfall may
 * never be hidden — so most of these assert that something the product would
 * rather not say is on screen anyway.
 *
 * The fixture is a REAL `POST /v1/analysis/routes` from the local stack, with
 * one eligible route and one rejected for capacity.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';

import type { RouteAnalysisResponse } from '../../lib/api/types';
import fixture from '../../lib/demo/recordings/route-analysis.json' with { type: 'json' };

const analysis = fixture as unknown as RouteAnalysisResponse;
const BORROWER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const analyzeMock = vi.fn();

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return {
    ...actual,
    api: { analyzeRoutes: (...args: unknown[]) => analyzeMock(...args) as unknown },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/routes',
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

async function renderRoutes(data: RouteAnalysisResponse = analysis) {
  analyzeMock.mockResolvedValue(data);
  const { RoutesView } = await import('./routes-view');
  const { WalletProvider } = await import('../wallet/wallet-context');
  const result = render(
    <WalletProvider>
      <RoutesView />
    </WalletProvider>,
  );
  /*
   * Three states render an h1 here — disconnected, loading and ready — so
   * waiting for a heading, or for the loading copy to vanish, both resolve too
   * early: the first poll catches the disconnected screen before the wallet
   * has connected. Wait for the request itself, then for the result.
   */
  await waitFor(() => expect(analyzeMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Evaluating every candidate/i)).toBeNull());
  return result;
}

/** The same real payload with every route rejected for staleness. */
function allStaleAnalysis(): RouteAnalysisResponse {
  const source = analysis.analysis.analyses[0]!;
  const stale = source.comparison.evaluations.map((route) => ({
    ...route,
    eligible: false,
    rejections: [
      { code: 'SOURCE_POSITION_STALE', message: 'The source position snapshot is stale.' },
      { code: 'MARKET_SNAPSHOT_STALE', message: 'The target market snapshot is stale.' },
      { code: 'ORACLE_STALE', message: 'The target oracle snapshot is stale.' },
    ],
  }));
  return {
    ...analysis,
    analysis: {
      ...analysis.analysis,
      analyses: [{ ...source, comparison: { ...source.comparison, evaluations: stale } }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installWallet();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

/* ------------------------------------------------------- the winning route */

describe('the eligible route', () => {
  it('leads with the saving and the rates behind it', async () => {
    await renderRoutes();
    const headline = screen.getByRole('heading', { level: 1 }).textContent ?? '';
    expect(headline).toMatch(/Moving saves [\d.]+ points/);
    expect(headline).toMatch(/From [\d.]+% to [\d.]+%/);
  });

  it('shows the funding shortfall as a headline figure, not a footnote', async () => {
    await renderRoutes();
    // The label appears in the winner's figure strip and again in the plan
    // financing rows; the claim is that the figure strip carries it.
    expect(screen.getAllByText(/Funding shortfall/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/None — required to execute/i)).toBeDefined();
  });

  it('prices in the rate impact of the borrower own borrow', async () => {
    await renderRoutes();
    expect(screen.getByText(/Your own borrow moves the destination rate by/i)).toBeDefined();
  });

  it('names which capacity bound is binding', async () => {
    await renderRoutes();
    expect(screen.getAllByText(/Binding/).length).toBe(1);
    expect(screen.getByText(/Safe capacity is the smallest of the four\./i)).toBeDefined();
  });

  it('marks the break-even projection as a projection and names the real source', async () => {
    await renderRoutes();
    expect(screen.getByText(/Straight-line projection/i)).toBeDefined();
    expect(screen.getByText(/breakEvenSeconds/)).toBeDefined();
  });

  it('says USD figures authorize nothing', async () => {
    await renderRoutes();
    expect(
      screen.getByText(/USD figures are for comparison only and never authorize anything/i),
    ).toBeDefined();
  });

  it('offers the next step', async () => {
    await renderRoutes();
    expect(screen.getAllByRole('link', { name: /prepare authorization/i }).length).toBeGreaterThan(
      0,
    );
  });
});

/* ------------------------------------------------------ the rejected route */

describe('the rejected route', () => {
  it('is shown, not hidden', async () => {
    await renderRoutes();
    expect(screen.getByText(/local-morpho-low-liquidity/)).toBeDefined();
  });

  it('lists every rejection reason in plain words', async () => {
    await renderRoutes();
    expect(
      screen.getByText(/The borrow needed exceeds the safe capacity of the destination market\./),
    ).toBeDefined();
    expect(
      screen.getByText(/Available funding does not cover the full amount required\./),
    ).toBeDefined();
    expect(
      screen.getByText(/The destination market does not have enough borrowable liquidity\./),
    ).toBeDefined();
  });

  it('shows the raw backend code beside each reason', async () => {
    await renderRoutes();
    expect(screen.getByText('REQUIRED_BORROW_EXCEEDS_SAFE_CAPACITY')).toBeDefined();
    expect(screen.getByText('FUNDING_SHORTFALL')).toBeDefined();
    expect(screen.getByText('INSUFFICIENT_BORROW_LIQUIDITY')).toBeDefined();
  });

  it('keeps the backend own message reachable rather than replacing it', async () => {
    await renderRoutes();
    const summaries = screen.getAllByText(/Backend message/i);
    expect(summaries.length).toBe(3);
  });

  it('shows its non-zero shortfall', async () => {
    await renderRoutes();
    expect(screen.getByText(/must be zero to execute/i)).toBeDefined();
  });

  it('states that a rejected route cannot be prepared', async () => {
    await renderRoutes();
    expect(screen.getByText(/A rejected route cannot be prepared\./i)).toBeDefined();
  });
});

/* ---------------------------------------------------------- no route at all */

describe('when nothing is eligible', () => {
  it('says so without pretending refinancing is impossible', async () => {
    await renderRoutes(allStaleAnalysis());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /No route currently satisfies the policy/i,
    );
    expect(screen.getByText(/Every rejection is a freshness problem/i)).toBeDefined();
    expect(screen.getByText(/refinancing is not impossible/i)).toBeDefined();
  });

  it('offers the action that actually helps', async () => {
    await renderRoutes(allStaleAnalysis());
    expect(screen.getByRole('button', { name: /refresh data/i })).toBeDefined();
  });

  it('does not offer to prepare an authorization there is no route for', async () => {
    await renderRoutes(allStaleAnalysis());
    expect(screen.queryByRole('link', { name: /prepare authorization/i })).toBeNull();
  });

  it('warns differently when the rejections are structural', async () => {
    // The real capacity rejections: a refresh changes nothing.
    await renderRoutes({
      ...analysis,
      analysis: {
        ...analysis.analysis,
        analyses: [
          {
            ...analysis.analysis.analyses[0]!,
            comparison: {
              ...analysis.analysis.analyses[0]!.comparison,
              evaluations: analysis.analysis.analyses[0]!.comparison.evaluations.map((route) => ({
                ...route,
                eligible: false,
              })),
            },
          },
        ],
      },
    });
    expect(screen.getByText(/These rejections are not about stale data/i)).toBeDefined();
  });
});

/* --------------------------------------------------------- the explanation */

describe('the explanation panel', () => {
  it('is marked as descriptive and carries the decision hash', async () => {
    await renderRoutes();
    expect(
      screen.getByText(/A description of the result above\. It cannot change it\./i),
    ).toBeDefined();
    expect(screen.getByText(/^decision 0x/)).toBeDefined();
  });

  it('states that changing provider cannot change a value', async () => {
    await renderRoutes();
    expect(
      screen.getByText(
        /Changing the provider, model, endpoint or key cannot change the decision hash/i,
      ),
    ).toBeDefined();
  });

  it('shows the deterministic badge for the deterministic provider', async () => {
    await renderRoutes();
    expect(screen.getByText('Deterministic')).toBeDefined();
  });

  it('announces a fallback when the model request failed', async () => {
    const entry = analysis.explanations[0]!;
    await renderRoutes({
      ...analysis,
      explanations: [
        { ...entry, result: { ...entry.result, provider: 'USER_API', fallbackUsed: true } },
      ],
    });
    expect(screen.getByText(/The model request failed/i)).toBeDefined();
    expect(screen.getByText(/No financial value changed/i)).toBeDefined();
  });
});

// @vitest-environment jsdom

/*
 * Rendering tests for the two signature screens.
 *
 * The acceptance criterion these exist for: "Intent/plan review coverage for
 * every material signed field". `review-rows.test.ts` proves the ROWS are
 * produced; this proves they reach the DOM, that the button is gated, and that
 * a wrong account or an expired window stops the flow.
 *
 * jsdom is opted into per file rather than configured globally, so the 215
 * pure-logic tests keep running in the fast node environment.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';

import type { PreparedMigration } from '../../lib/api/types';
import fixture from './__fixtures__/prepared-migration.json' with { type: 'json' };

const prepared = fixture as unknown as PreparedMigration;
const BORROWER = prepared.intent.borrower;
const SOURCE_CHAIN = prepared.intent.sourcePosition.market.chainId;

/* ------------------------------------------------------------- the doubles */

const prepareMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return {
    ...actual,
    api: {
      prepare: (...args: unknown[]) => prepareMock(...args) as unknown,
      execute: (...args: unknown[]) => executeMock(...args) as unknown,
      health: () => Promise.resolve({ service: 'debtshift-api', status: 'ok', timestamp: '' }),
    },
  };
});

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => '/authorize',
}));

/**
 * A minimal EIP-1193 provider.
 *
 * The real `WalletProvider` runs against it — the wallet module is not mocked,
 * so the account/chain gating under test is the production code path.
 */
function installWallet({
  account = BORROWER,
  chainId = SOURCE_CHAIN,
  signs = true,
}: { account?: string; chainId?: number; signs?: boolean } = {}) {
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (method === 'eth_signTypedData_v4') {
        if (!signs) {
          const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
          throw rejection;
        }
        return `0x${'ab'.repeat(32)}1b`;
      }
      throw new Error(`unexpected ${method}`);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  (window as unknown as { ethereum: unknown }).ethereum = provider;
  return provider;
}

async function renderAuthorize() {
  const { AuthorizeView } = await import('./authorize-view');
  const { WalletProvider } = await import('../wallet/wallet-context');
  return render(
    <WalletProvider>
      <AuthorizeView />
    </WalletProvider>,
  );
}

/** Walks through prepare so the policy review is on screen. */
async function reachPolicyStep() {
  await renderAuthorize();
  const prepareButton = await screen.findByRole('button', { name: /prepare authorization/i });
  fireEvent.click(prepareButton);
  await screen.findByText(/authorize the policy/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareMock.mockResolvedValue(prepared);
  executeMock.mockResolvedValue({ migrationId: prepared.plan.migrationId });
  // Freeze time inside every window the fixture carries, so the countdowns do
  // not expire mid-test and discard the signatures.
  vi.setSystemTime(new Date((Number(prepared.plan.deadline) - 120) * 1000));
  installWallet();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

/* ------------------------------------------------------------------- tests */

describe('the prepare step', () => {
  it('does not call the backend until the user asks', async () => {
    await renderAuthorize();
    await screen.findByRole('button', { name: /prepare authorization/i });
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('shows the backend message verbatim when preparation fails closed', async () => {
    const { ApiError } = await import('../../lib/api/client');
    prepareMock.mockRejectedValue(
      new ApiError({
        code: 'VALIDATION',
        status: 400,
        messages: ['No approved executable route satisfies the deterministic policy.'],
        path: '/migrations/prepare',
      }),
    );

    await renderAuthorize();
    fireEvent.click(await screen.findByRole('button', { name: /prepare authorization/i }));

    // Not rewritten as a generic wallet failure.
    await screen.findByText(/No approved executable route satisfies the deterministic policy\./);
    expect(screen.getByText(/HTTP 400/)).toBeDefined();
  });
});

describe('signature 1 — the policy review', () => {
  it('shows the simulator warning verbatim', async () => {
    await reachPolicyStep();
    expect(
      screen.getByText('This route uses test assets and is not a 1Click testnet transaction.'),
    ).toBeDefined();
  });

  it('puts every material intent field on screen before the button', async () => {
    await reachPolicyStep();
    const list = document.querySelector('dl.facts');
    expect(list).not.toBeNull();
    const text = (list as HTMLElement).textContent ?? '';

    // Each raw line carries the signed field name, so the DOM can be checked
    // against the contract's list rather than against a screenshot.
    for (const field of [
      'maxSourceDebtUnits',
      'minSourceCollateralUnits',
      'maxTotalFeeUnits',
      'maxSlippageBps',
      'minAprReductionBps',
      'maxDurationSeconds',
      'expiration',
      'nonce',
    ]) {
      expect(text, field).toContain(field);
    }
  });

  it('shows the exact signed amounts, not only the formatted ones', async () => {
    await reachPolicyStep();
    const text = document.body.textContent ?? '';
    expect(text).toContain(prepared.intent.maxSourceDebtUnits);
    expect(text).toContain(prepared.intent.minSourceCollateralUnits);
  });

  it('lists every allowed target rather than truncating', async () => {
    await reachPolicyStep();
    const text = document.body.textContent ?? '';
    for (const target of prepared.intent.allowedTargets) {
      expect(text).toContain(target.marketId);
    }
  });

  it('shows the hash the wallet will sign and the verifying contract', async () => {
    await reachPolicyStep();
    const text = document.body.textContent ?? '';
    expect(text).toContain(prepared.intentHash);
    expect(text).toContain(prepared.verifyingContract);
  });

  it('confirms the connected account may sign', async () => {
    await reachPolicyStep();
    expect(screen.getByText(/is intent\.borrower — signing is allowed/i)).toBeDefined();
  });

  it('offers exactly one signing action, labelled as the policy', async () => {
    await reachPolicyStep();
    expect(screen.getByRole('button', { name: /^sign the policy$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /sign the execution plan/i })).toBeNull();
  });
});

describe('the account and chain gates', () => {
  it('blocks signing when another account is connected', async () => {
    installWallet({ account: '0x0000000000000000000000000000000000000001' });
    await reachPolicyStep();

    expect(screen.getByText(/This account cannot sign this authorization/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /^sign the policy$/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('blocks signing and offers a switch when the wallet is on another chain', async () => {
    installWallet({ chainId: 1 });
    await reachPolicyStep();

    expect(screen.getByText(new RegExp(`not on chain ${String(SOURCE_CHAIN)}`, 'i'))).toBeDefined();
    expect(screen.getByRole('button', { name: /switch network/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^sign the policy$/i })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('signature 2 — the execution review', () => {
  async function reachPlanStep() {
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    await screen.findByText(/authorize this exact execution/i);
  }

  it('is a separate screen reached only after the first signature', async () => {
    await reachPlanStep();
    expect(screen.getByRole('button', { name: /sign the execution plan/i })).toBeDefined();
    // The two consents are never merged.
    expect(screen.queryByRole('button', { name: /^sign the policy$/i })).toBeNull();
  });

  it('puts every material plan and financing field on screen', async () => {
    await reachPlanStep();
    const text = document.querySelector('dl.facts')?.textContent ?? '';

    for (const field of [
      'sourceRepaymentMaxUnits',
      'sourceCollateralMinUnits',
      'targetDebtMaxUnits',
      'minDestinationCollateralUnits',
      'principalMaxUnits',
      'feeMaxUnits',
      'solverPrincipalUnits',
      'solverFeeUnits',
      'capitalizedCostUnits',
      'separatelyPaidCostUnits',
      'requiredDestinationBorrowUnits',
      'maximumSafeBorrowingCapacityUnits',
      'fundingShortfallUnits',
      'transportQuoteHash',
      'destinationReceiver',
      'refundReceiver',
      'reservationHash',
      'deadline',
      'validUntil',
    ]) {
      expect(text, field).toContain(field);
    }
  });

  it('names the refund path in words a borrower can act on', async () => {
    await reachPlanStep();
    expect(screen.getByText(/Refund receiver, if transport fails/i)).toBeDefined();
  });

  it('never presents the simulator as a 1Click transaction', async () => {
    await reachPlanStep();
    const text = document.body.textContent ?? '';
    expect(text).toContain('DebtShift simulator (test assets)');
    expect(text).not.toMatch(/1Click (testnet|transaction)(?! transaction\.)/);
  });

  it('shows three countdowns and marks exactly one as governing', async () => {
    await reachPlanStep();
    const timers = screen.getAllByRole('timer');
    expect(timers.length).toBe(3);

    // Exactly one, and it is whichever window is nearest — not a fixed slot.
    // With the fixture's values the plan deadline closes before the quote.
    const governing = timers.filter((timer) => /governs/i.test(timer.textContent ?? ''));
    expect(governing).toHaveLength(1);
    expect(within(governing[0]!).getByText(/plan deadline/i)).toBeDefined();
  });

  it('counts the quote expiry down independently of the governing window', async () => {
    await reachPlanStep();
    const timers = screen.getAllByRole('timer');
    const quote = timers.find((timer) => /transport quote/i.test(timer.textContent ?? ''));
    expect(quote).toBeDefined();
    // 180 s remain on the quote at the frozen time, against 120 s on the plan.
    expect(quote?.textContent).toMatch(/3 min/);
  });
});

describe('signature rejection', () => {
  it('stays on the policy step and submits nothing when the first signature is refused', async () => {
    installWallet({ signs: false });
    await reachPolicyStep();

    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));

    await screen.findByText(/The policy signature was not completed/i);
    // Still on step 1 of 2, nothing sent.
    expect(screen.getByRole('button', { name: /^sign the policy$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /submit both signatures/i })).toBeNull();
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('submission', () => {
  it('sends the prepared objects back untouched, by reference', async () => {
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    await screen.findByText(/authorize this exact execution/i);
    fireEvent.click(screen.getByRole('button', { name: /sign the execution plan/i }));
    await screen.findByRole('button', { name: /submit both signatures/i });

    fireEvent.click(screen.getByRole('button', { name: /submit both signatures/i }));

    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    const sent = executeMock.mock.calls[0]?.[0] as {
      signedIntent: { intent: unknown; intentHash: string };
      signedPlan: { plan: unknown; planHash: string };
      quote: unknown;
      sourceSnapshot: unknown;
    };

    // Identity, not deep equality: a rebuilt object would pass toEqual and
    // still be a different payload from the one the backend hashed.
    expect(sent.signedIntent.intent).toBe(prepared.intent);
    expect(sent.signedPlan.plan).toBe(prepared.plan);
    expect(sent.quote).toBe(prepared.quote);
    expect(sent.sourceSnapshot).toBe(prepared.sourceSnapshot);
    expect(sent.signedIntent.intentHash).toBe(prepared.intentHash);
    expect(sent.signedPlan.planHash).toBe(prepared.planHash);
  });

  it('says plainly that submitting is not completion', async () => {
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    await screen.findByText(/authorize this exact execution/i);
    fireEvent.click(screen.getByRole('button', { name: /sign the execution plan/i }));
    await screen.findByRole('button', { name: /submit both signatures/i });

    expect(screen.getByText(/Submitting is not completion/i)).toBeDefined();
  });

  it('persists only the migration id, never a signature or a payload', async () => {
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    await screen.findByText(/authorize this exact execution/i);
    fireEvent.click(screen.getByRole('button', { name: /sign the execution plan/i }));
    await screen.findByRole('button', { name: /submit both signatures/i });
    fireEvent.click(screen.getByRole('button', { name: /submit both signatures/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());

    const stored = JSON.stringify(Object.fromEntries(Object.entries(window.localStorage)));
    expect(stored).toContain(prepared.plan.migrationId);
    expect(stored).not.toContain(prepared.intentHash);
    expect(stored).not.toContain(prepared.plan.targetDebtMaxUnits);
    expect(stored.toLowerCase()).not.toContain('signature');
  });
});

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
import fixture from '../../lib/demo/recordings/prepare.json' with { type: 'json' };

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

/** The review is several grouped lists; together they are the signed fields. */
function reviewText(): string {
  const lists = [...document.querySelectorAll('dl.facts')];
  expect(lists.length).toBeGreaterThan(0);
  return lists.map((list) => list.textContent ?? '').join('\n');
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
    const text = reviewText();

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
    const text = reviewText();

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

    // Every mention of a 1Click transaction on this screen must be a denial.
    // Checking the sense, not the mere presence of the words: the banner
    // legitimately says "not a 1Click transaction".
    const mentions = [...text.matchAll(/(.{0,12})1Click (testnet )?transaction/g)];
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect(mention[1], mention[0]).toMatch(/not an? $/);
    }
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

/* ----------------------------------------------------- strategy 2026-11-12 */

/** The same real payload, carrying the shape the contract now specifies. */
function withEnvironment(environment: Record<string, unknown> | undefined) {
  const { simulation: _legacy, ...rest } = prepared as unknown as Record<string, unknown>;
  return environment === undefined ? rest : { ...rest, environment };
}

async function reachSubmitStep() {
  await reachPolicyStep();
  fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
  await screen.findByText(/authorize this exact execution/i);
  fireEvent.click(screen.getByRole('button', { name: /sign the execution plan/i }));
  return screen.findByRole('button', { name: /submit both signatures/i });
}

describe('the environment comes from the backend', () => {
  it('labels today legacy response as the contract-backed sandbox', async () => {
    await reachPolicyStep();
    const banner = screen.getByRole('note');
    expect(banner.textContent).toContain('Contract-backed sandbox · test funds');
    expect(banner.textContent).toContain('Mode sandbox · transport DEBTSHIFT_SIMULATOR');
  });

  it('reads the new environment shape without the legacy field', async () => {
    prepareMock.mockResolvedValue(
      withEnvironment({
        mode: 'testnet',
        transportProvider: 'DEBTSHIFT_SIMULATOR',
        executionEnabled: true,
        warning: 'Public testnet assets only.',
      }),
    );
    await reachPolicyStep();

    const banner = screen.getByRole('note');
    expect(banner.textContent).toContain('Public testnet · simulated transport');
    expect(banner.textContent).toContain('Public testnet assets only.');
  });

  it('renders the review even when the backend sends no warning', async () => {
    prepareMock.mockResolvedValue(
      withEnvironment({
        mode: 'sandbox',
        transportProvider: 'DEBTSHIFT_SIMULATOR',
        executionEnabled: true,
      }),
    );
    await reachPolicyStep();
    expect(screen.getByRole('button', { name: /^sign the policy$/i })).toBeDefined();
  });
});

describe('when the backend does not allow execution', () => {
  it('disables submission on mainnet while the server switch is off', async () => {
    prepareMock.mockResolvedValue(
      withEnvironment({
        mode: 'mainnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        executionEnabled: false,
      }),
    );
    const submit = await reachSubmitStep();

    expect(submit).toHaveProperty('disabled', true);
    expect(screen.getByRole('note').textContent).toContain('Mainnet execution disabled');
    expect(screen.getByText(/Nothing in this browser can enable it\./)).toBeDefined();

    fireEvent.click(submit);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('never offers submission in a read-only environment', async () => {
    prepareMock.mockResolvedValue(
      withEnvironment({
        mode: 'mainnet-readonly',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        executionEnabled: true,
      }),
    );
    const submit = await reachSubmitStep();
    expect(submit).toHaveProperty('disabled', true);
    expect(screen.getByText(/read-only environment/i)).toBeDefined();
  });

  it('fails closed when the backend reports no environment at all', async () => {
    // Neither shape present: the app must not assume a sandbox.
    prepareMock.mockResolvedValue(withEnvironment(undefined));
    const submit = await reachSubmitStep();

    expect(submit).toHaveProperty('disabled', true);
    expect(screen.getByRole('note').textContent).toContain('Environment not reported');
    fireEvent.click(submit);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('allows submission on mainnet only when the backend reports it enabled', async () => {
    prepareMock.mockResolvedValue(
      withEnvironment({
        mode: 'mainnet',
        transportProvider: 'NEAR_INTENTS_1CLICK',
        executionEnabled: true,
      }),
    );
    const submit = await reachSubmitStep();
    expect(submit).toHaveProperty('disabled', false);
    expect(screen.getByRole('note').textContent).toContain('Mainnet · real funds');
  });
});

/* --------------------------------------------------------- the recorded demo */

describe('the submit step in the recorded demo', () => {
  /** Puts the tab in the demo, as the landing page button does. */
  function enterDemo() {
    window.sessionStorage.setItem('debtshift:demo', '1');
  }

  afterEach(() => {
    window.sessionStorage.clear();
  });

  /** The same walk as `reachSubmitStep`, ending on the demo's own button. */
  async function reachDemoSubmitStep() {
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    await screen.findByText(/authorize this exact execution/i);
    fireEvent.click(screen.getByRole('button', { name: /sign the execution plan/i }));
    return screen.findByRole('button', { name: /replay the recorded migration/i });
  }

  it('never calls a placeholder a collected signature', async () => {
    enterDemo();
    await reachDemoSubmitStep();

    expect(screen.getAllByText('Demo placeholder')).toHaveLength(2);
    expect(screen.queryByText('Collected')).toBeNull();
  });

  it('says that nothing is submitted, and names the action as a replay', async () => {
    enterDemo();
    await reachDemoSubmitStep();

    expect(screen.getByText(/Nothing is submitted in the demo/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /submit both signatures/i })).toBeNull();
  });

  it('keeps the real wording outside the demo', async () => {
    await reachSubmitStep();
    expect(screen.getAllByText('Collected')).toHaveLength(2);
    expect(screen.queryByText(/Nothing is submitted in the demo/i)).toBeNull();
  });
});

describe('the review layout', () => {
  it('shows every signed policy field exactly once in the grouped lists', async () => {
    await reachPolicyStep();
    const rows = document.querySelectorAll('dl.facts .review__row');
    expect(rows).toHaveLength(16);
  });

  it('repeats a few limits at the top without replacing the full list', async () => {
    await reachPolicyStep();
    const glance = screen.getByRole('group', { name: /at a glance/i });
    expect(glance.querySelectorAll('.review__glance-item')).toHaveLength(4);
    expect(glance.textContent).toMatch(/all 16 signed fields are below/i);
    // The same label is still in the full list.
    expect(screen.getAllByText('Repay at most')).toHaveLength(2);
  });

  it('names each group and leaves no field ungrouped', async () => {
    await reachPolicyStep();
    for (const title of ['Who and where', 'Your limits', 'Time and replay']) {
      expect(screen.getByRole('heading', { level: 3, name: new RegExp(title) })).toBeDefined();
    }
    expect(screen.queryByText(/Other signed fields/i)).toBeNull();
  });

  it('keeps the sign button after the terms in the document', async () => {
    await reachPolicyStep();
    const lastRow = [...document.querySelectorAll('.review__row')].at(-1)!;
    const button = screen.getByRole('button', { name: /^sign the policy$/i });
    expect(lastRow.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the stepper', () => {
  function steps() {
    const list = screen.getByRole('list', { name: /authorization steps/i });
    return [...list.querySelectorAll('li')].map((item) => ({
      status: item.getAttribute('data-status'),
      current: item.getAttribute('aria-current'),
      text: item.textContent ?? '',
    }));
  }

  it('marks the policy as the current step after preparing', async () => {
    await reachPolicyStep();
    const all = steps();
    expect(all.map((step) => step.status)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    expect(all[1]!.current).toBe('step');
    expect(all[1]!.text).toMatch(/Signature 1 of 2 · sign now/);
  });

  it('says a real signature was signed', async () => {
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    await screen.findByText(/authorize this exact execution/i);
    const all = steps();
    expect(all[1]!.text).toMatch(/Signed/);
    expect(all[2]!.text).toMatch(/Signature 2 of 2 · sign now/);
  });

  it('never says a demo placeholder was signed', async () => {
    window.sessionStorage.setItem('debtshift:demo', '1');
    try {
      await reachPolicyStep();
      fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
      await screen.findByText(/authorize this exact execution/i);
      const all = steps();
      expect(all[1]!.text).toMatch(/Demo placeholder, not signed/);
      expect(all[1]!.text).not.toMatch(/^.*\bSigned$/);
    } finally {
      window.sessionStorage.clear();
    }
  });
});

describe('moving between steps', () => {
  it('moves focus to the new heading after a signature', async () => {
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: /authorize this exact execution/i,
    });
    // The reader is taken to the top of the new review, not left where the
    // old sign button was.
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('announces a notice that appears after an action', async () => {
    installWallet({ signs: false });
    await reachPolicyStep();
    fireEvent.click(screen.getByRole('button', { name: /^sign the policy$/i }));
    // A failure interrupts: it is an alert, not a silent paragraph.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/policy signature was not completed/i);
  });
});

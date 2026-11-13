// @vitest-environment jsdom

/*
 * The borrower session, from connect to signed in.
 *
 * The real `WalletProvider` and the real gate run against a minimal EIP-1193
 * provider; only the HTTP boundary is replaced. What is checked is the contract
 * with the API: the login message is signed exactly as issued, for the account
 * it was issued to, only on a user action, and a session for another account
 * is not a session.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { stringToHex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';

const BORROWER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const MESSAGE = `localhost:3000 wants you to sign in with your Ethereum account:\n${BORROWER}\n\nSign in to DebtShift. This proves wallet control and does not authorize a refinance or transaction.\n\nChain ID: 31337`;

const sessionMock = vi.fn();
const challengeMock = vi.fn();
const verifyMock = vi.fn();
const logoutMock = vi.fn();
let pathname = '/position';

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return {
    ...actual,
    api: {
      session: (...args: unknown[]) => sessionMock(...args) as unknown,
      authChallenge: (...args: unknown[]) => challengeMock(...args) as unknown,
      authVerify: (...args: unknown[]) => verifyMock(...args) as unknown,
      logout: (...args: unknown[]) => logoutMock(...args) as unknown,
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => pathname,
}));

interface WalletOptions {
  readonly accounts?: readonly string[];
  readonly chain?: string;
  readonly sign?: () => Promise<string>;
  readonly switchChain?: () => Promise<null>;
}

function installWallet(options: WalletOptions = {}) {
  let chain = options.chain ?? '0x7a69';
  const provider = {
    request: vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return options.accounts ?? [BORROWER];
      }
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        const result = await (options.switchChain ?? (() => Promise.resolve(null)))();
        chain = '0x7a69';
        return result;
      }
      if (method === 'personal_sign') {
        return (options.sign ?? (() => Promise.resolve(SIGNATURE)))();
      }
      throw new Error(`unexpected ${method}`);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  (window as unknown as { ethereum: unknown }).ethereum = provider;
  return provider;
}

function calls(provider: ReturnType<typeof installWallet>, method: string) {
  return provider.request.mock.calls
    .map(([call]) => call as { method: string; params?: unknown[] })
    .filter((call) => call.method === method);
}

async function renderGate() {
  const { WalletProvider, useWallet } = await import('./wallet-context');
  const { SessionGate } = await import('./session-gate');
  // Outside the gate, so a test can wait for the session itself. The gate
  // also shows its children while the wallet is still starting up, so their
  // presence alone does not prove anyone is signed in.
  function SessionProbe() {
    return <output data-testid="session">{useWallet().session.status}</output>;
  }
  return render(
    <WalletProvider>
      <SessionProbe />
      <SessionGate>
        <p>the borrower screen</p>
      </SessionGate>
    </WalletProvider>,
  );
}

async function signedIn() {
  await waitFor(() => expect(screen.getByTestId('session').textContent).toBe('active'));
}

const challenge = {
  challengeId: '0b3f6b0e-6d0a-4c57-9a55-0c8f0a3f6f11',
  wallet: BORROWER,
  chainId: 31337,
  message: MESSAGE,
  expiresAt: '2026-11-13T15:05:00.000Z',
};
const opened = { wallet: BORROWER, chainId: 31337, expiresAt: '2026-11-13T23:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  pathname = '/position';
  sessionMock.mockResolvedValue(undefined);
  challengeMock.mockResolvedValue(challenge);
  verifyMock.mockResolvedValue(opened);
  logoutMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  window.sessionStorage.clear();
});

describe('a connected wallet that has not signed in', () => {
  it('sees the sign-in screen instead of the borrower screen', async () => {
    installWallet();
    await renderGate();
    expect(
      await screen.findByRole('heading', { level: 1, name: /prove this wallet is yours/i }),
    ).toBeDefined();
    expect(screen.queryByText('the borrower screen')).toBeNull();
  });

  it('is told what the signature does not authorize', async () => {
    installWallet();
    await renderGate();
    await screen.findByRole('heading', { level: 1, name: /prove this wallet is yours/i });
    expect(
      screen.getByText(/does not authorize a refinance, approve a token or move funds/i),
    ).toBeDefined();
    expect(screen.getByText(/not a transaction and costs no gas/i)).toBeDefined();
  });

  it('is asked for nothing until the button is pressed', async () => {
    const provider = installWallet();
    await renderGate();
    await screen.findByRole('button', { name: /sign in with wallet/i });
    expect(challengeMock).not.toHaveBeenCalled();
    expect(calls(provider, 'personal_sign')).toHaveLength(0);
  });
});

describe('signing in', () => {
  it('signs the message exactly as issued and opens the borrower screen', async () => {
    const provider = installWallet();
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));

    await signedIn();
    expect(screen.getByText('the borrower screen')).toBeDefined();
    expect(challengeMock).toHaveBeenCalledWith(BORROWER);

    const [signed] = calls(provider, 'personal_sign');
    expect(signed!.params).toEqual([stringToHex(MESSAGE), BORROWER]);
    expect(verifyMock).toHaveBeenCalledWith(challenge.challengeId, SIGNATURE);
  });

  it('asks the wallet to move to the chain the message names first', async () => {
    const provider = installWallet({ chain: '0x1' });
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));
    await screen.findByText('the borrower screen');

    const order = provider.request.mock.calls
      .map(([call]) => (call as { method: string }).method)
      .filter((method) => method === 'wallet_switchEthereumChain' || method === 'personal_sign');
    expect(order).toEqual(['wallet_switchEthereumChain', 'personal_sign']);
    expect(calls(provider, 'wallet_switchEthereumChain')[0]!.params).toEqual([
      { chainId: '0x7a69' },
    ]);
  });

  it('signs nothing when the network switch is declined', async () => {
    const provider = installWallet({
      chain: '0x1',
      switchChain: () => Promise.reject(Object.assign(new Error('rejected'), { code: 4001 })),
    });
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));

    expect(await screen.findByText(/declined the network switch/i)).toBeDefined();
    expect(calls(provider, 'personal_sign')).toHaveLength(0);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(screen.queryByText('the borrower screen')).toBeNull();
  });

  it('says so and stays signed out when the signature is declined', async () => {
    installWallet({
      sign: () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 })),
    });
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));

    expect(await screen.findByText(/declined the sign-in request/i)).toBeDefined();
    expect(verifyMock).not.toHaveBeenCalled();
    expect(screen.queryByText('the borrower screen')).toBeNull();
    // The way forward is still on screen.
    expect(screen.getByRole('button', { name: /sign in with wallet/i })).toBeDefined();
  });

  it('will not sign a message issued for another account', async () => {
    const provider = installWallet();
    challengeMock.mockResolvedValue({
      ...challenge,
      wallet: OTHER,
      message: MESSAGE.replace(BORROWER, OTHER),
    });
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));

    expect(await screen.findByText(/for a different account\. Nothing was signed/i)).toBeDefined();
    expect(calls(provider, 'personal_sign')).toHaveLength(0);
  });

  it('will not sign a message that does not name the account', async () => {
    const provider = installWallet();
    challengeMock.mockResolvedValue({ ...challenge, message: 'Sign this.' });
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));

    await screen.findByText(/Nothing was signed/i);
    expect(calls(provider, 'personal_sign')).toHaveLength(0);
  });

  it('does not treat a session opened for another account as signed in', async () => {
    installWallet();
    verifyMock.mockResolvedValue({ ...opened, wallet: OTHER });
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));

    expect(await screen.findByText(/session for a different account/i)).toBeDefined();
    expect(screen.queryByText('the borrower screen')).toBeNull();
  });

  it('shows the backend sentence when the proof is refused', async () => {
    installWallet();
    const { ApiError } = await import('../../lib/api/client');
    verifyMock.mockRejectedValue(
      new ApiError({
        code: 'UNAUTHORIZED',
        status: 401,
        messages: ['Wallet challenge has expired.'],
        path: '/auth/verify',
      }),
    );
    await renderGate();
    fireEvent.click(await screen.findByRole('button', { name: /sign in with wallet/i }));
    expect(await screen.findByText('Wallet challenge has expired.')).toBeDefined();
  });
});

describe('an existing session', () => {
  it('is restored without asking the wallet for anything', async () => {
    const provider = installWallet();
    sessionMock.mockResolvedValue(opened);
    await renderGate();
    await signedIn();
    expect(screen.getByText('the borrower screen')).toBeDefined();
    expect(calls(provider, 'personal_sign')).toHaveLength(0);
    expect(challengeMock).not.toHaveBeenCalled();
  });

  it('for a different account does not count', async () => {
    installWallet();
    sessionMock.mockResolvedValue({ ...opened, wallet: OTHER });
    await renderGate();
    await screen.findByRole('heading', { level: 1, name: /prove this wallet is yours/i });
    expect(screen.queryByText('the borrower screen')).toBeNull();
  });

  it('returns to the sign-in screen when a borrower route rejects it', async () => {
    installWallet();
    sessionMock.mockResolvedValue(opened);
    await renderGate();
    await signedIn();

    // What the HTTP boundary does on a 401 from a borrower route.
    const { DebtShiftApi } = await import('../../lib/api/client');
    const expired = new DebtShiftApi({
      baseUrl: 'http://localhost:3001/v1',
      fetcher: async () =>
        new Response(JSON.stringify({ message: 'Wallet session is required.' }), { status: 401 }),
    });
    await expired.position(BORROWER).catch(() => undefined);

    expect(await screen.findByText(/Your session ended\. Sign in again/i)).toBeDefined();
    expect(screen.queryByText('the borrower screen')).toBeNull();
  });

  it('is revoked on the server when the user disconnects', async () => {
    installWallet();
    sessionMock.mockResolvedValue(opened);
    const { WalletProvider, useWallet } = await import('./wallet-context');
    function Disconnect() {
      const wallet = useWallet();
      return (
        <button type="button" onClick={wallet.disconnect}>
          {wallet.session.status}
        </button>
      );
    }
    render(
      <WalletProvider>
        <Disconnect />
      </WalletProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'active' }));
    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
  });
});

describe('when the API cannot be asked', () => {
  it('says so and offers to check again, without claiming either state', async () => {
    installWallet();
    const { ApiError } = await import('../../lib/api/client');
    sessionMock.mockRejectedValueOnce(
      new ApiError({
        code: 'NETWORK',
        status: 0,
        messages: ['The API could not be reached. Is it running on this machine?'],
        path: '/auth/session',
      }),
    );
    await renderGate();
    expect(await screen.findByText(/The API could not be reached\. Is it running/i)).toBeDefined();

    sessionMock.mockResolvedValue(opened);
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText('the borrower screen')).toBeDefined();
  });
});

describe('where the gate does not apply', () => {
  it('leaves the landing page and settings alone', async () => {
    installWallet();
    for (const path of ['/', '/settings']) {
      pathname = path;
      await renderGate();
      expect(await screen.findByText('the borrower screen')).toBeDefined();
      cleanup();
    }
  });

  it('lets the recorded demo through: it has no backend to sign in to', async () => {
    window.sessionStorage.setItem('debtshift:demo', '1');
    const provider = installWallet();
    await renderGate();
    expect(await screen.findByText('the borrower screen')).toBeDefined();
    expect(sessionMock).not.toHaveBeenCalled();
    expect(provider.request).not.toHaveBeenCalled();
  });

  it('leaves a disconnected visitor to the screen own connect prompt', async () => {
    installWallet({ accounts: [] });
    await renderGate();
    expect(await screen.findByText('the borrower screen')).toBeDefined();
  });

  it('asks a disconnected visitor of a migration link to connect', async () => {
    pathname = `/migrations/0x${'ab'.repeat(32)}`;
    installWallet({ accounts: [] });
    await renderGate();
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /connect the wallet that started this migration/i,
      }),
    ).toBeDefined();
    expect(screen.queryByText('the borrower screen')).toBeNull();
  });
});

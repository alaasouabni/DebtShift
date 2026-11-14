// @vitest-environment jsdom

/*
 * Offering to add a network the wallet does not know.
 *
 * The rule under test is the one in the frontend contract: a network is never
 * switched or added without a user action. So a failed switch must only ever
 * produce an offer, the offer must show what would be added, and the details
 * handed to the wallet must be the fixed ones from `lib/chains`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../../lib/api/client';
import { walletChainParameters } from '../../lib/chains';

const BORROWER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BASE_SEPOLIA = 84532;

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../../lib/api/client');
  return { ...actual, api: { session: () => Promise.resolve(undefined) } };
});

interface WalletOptions {
  /** What the wallet answers to a switch request. Default: it does not know the chain. */
  readonly onSwitch?: (known: boolean) => Promise<null>;
  readonly onAdd?: () => Promise<null>;
  /** Whether adding a network also moves the wallet onto it. */
  readonly switchesAfterAdd?: boolean;
}

function installWallet(options: WalletOptions = {}) {
  let chain = '0xaa36a7';
  let known = false;
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [BORROWER];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        const result = await (
          options.onSwitch ??
          ((isKnown: boolean) =>
            isKnown
              ? Promise.resolve(null)
              : Promise.reject(
                  Object.assign(new Error('Unrecognized chain ID "0x14a34".'), { code: 4902 }),
                ))
        )(known);
        chain = (params![0] as { chainId: string }).chainId;
        return result;
      }
      if (method === 'wallet_addEthereumChain') {
        const result = await (options.onAdd ?? (() => Promise.resolve(null)))();
        known = true;
        if (options.switchesAfterAdd ?? true) {
          chain = (params![0] as { chainId: string }).chainId;
        }
        return result;
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

async function renderPrompt(target = BASE_SEPOLIA) {
  const { WalletProvider, useWallet } = await import('./wallet-context');
  const { NetworkHelp } = await import('./network-help');
  function Prompt() {
    const wallet = useWallet();
    return (
      <>
        <output data-testid="chain">{wallet.chainId ?? 'none'}</output>
        <button type="button" onClick={() => void wallet.requestChain(target)}>
          Switch network
        </button>
        <NetworkHelp chainId={target} />
      </>
    );
  }
  render(
    <WalletProvider>
      <Prompt />
    </WalletProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('chain').textContent).toBe('11155111'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe('the fixed network details', () => {
  it('exist for the public testnets and name the right chain', () => {
    expect(walletChainParameters(84532)).toEqual({
      chainId: '0x14a34',
      chainName: 'Base Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://sepolia.base.org'],
      blockExplorerUrls: ['https://sepolia.basescan.org'],
    });
    expect(walletChainParameters(11155111)?.chainId).toBe('0xaa36a7');
    expect(walletChainParameters(421614)?.chainId).toBe('0x66eee');
  });

  it('are never offered for a mainnet, a sandbox chain or an unknown chain', () => {
    for (const chainId of [1, 8453, 42161, 31337, 31338, 999, undefined, null]) {
      expect(walletChainParameters(chainId)).toBeUndefined();
    }
  });

  it('only use https endpoints', () => {
    for (const chainId of [84532, 11155111, 421614]) {
      const parameters = walletChainParameters(chainId)!;
      for (const url of [...parameters.rpcUrls, ...parameters.blockExplorerUrls]) {
        expect(url.startsWith('https://')).toBe(true);
      }
    }
  });
});

describe('a wallet that does not know the network', () => {
  it('is offered the network, and nothing is added by the failed switch', async () => {
    const provider = installWallet();
    await renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));

    expect(await screen.findByRole('button', { name: 'Add Base Sepolia' })).toBeDefined();
    expect(calls(provider, 'wallet_addEthereumChain')).toHaveLength(0);
  });

  it('sees exactly what would be added before pressing anything', async () => {
    installWallet();
    await renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    await screen.findByRole('button', { name: 'Add Base Sepolia' });

    expect(screen.getByText('https://sepolia.base.org')).toBeDefined();
    expect(screen.getByText('https://sepolia.basescan.org')).toBeDefined();
    expect(screen.getByText('Base Sepolia · 84532')).toBeDefined();
    expect(screen.getByText(/nothing is added until you do/i)).toBeDefined();
  });

  it('adds the fixed details on the user press, and the offer goes away', async () => {
    const provider = installWallet();
    await renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Base Sepolia' }));

    await waitFor(() => expect(screen.getByTestId('chain').textContent).toBe('84532'));
    expect(calls(provider, 'wallet_addEthereumChain')).toHaveLength(1);
    expect(calls(provider, 'wallet_addEthereumChain')[0]!.params).toEqual([
      walletChainParameters(84532),
    ]);
    expect(screen.queryByRole('button', { name: 'Add Base Sepolia' })).toBeNull();
  });

  it('asks a wallet that added but did not move to switch, in the same action', async () => {
    const provider = installWallet({ switchesAfterAdd: false });
    await renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Base Sepolia' }));

    await waitFor(() => expect(screen.getByTestId('chain').textContent).toBe('84532'));
    const order = provider.request.mock.calls
      .map(([call]) => (call as { method: string }).method)
      .filter((method) => method.startsWith('wallet_'));
    expect(order).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ]);
  });

  it('keeps the offer and says so when the user declines in the wallet', async () => {
    installWallet({
      onAdd: () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 })),
    });
    await renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Base Sepolia' }));

    expect(await screen.findByText(/You declined adding Base Sepolia/i)).toBeDefined();
    expect(screen.getByTestId('chain').textContent).toBe('11155111');
    expect(screen.getByRole('button', { name: 'Add Base Sepolia' })).toBeDefined();
  });

  it('recognises the unknown-chain error however the wallet wraps it', async () => {
    installWallet({
      onSwitch: () => Promise.reject({ code: -32603, data: { originalError: { code: 4902 } } }),
    });
    await renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    expect(await screen.findByRole('button', { name: 'Add Base Sepolia' })).toBeDefined();
  });
});

describe('what is not offered', () => {
  it('a declined switch is reported, with no offer to add', async () => {
    installWallet({
      onSwitch: () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 })),
    });
    await renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));

    expect(await screen.findByText('You declined the network switch.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Add /i })).toBeNull();
  });

  it('a network this app does not list must be added by hand', async () => {
    const provider = installWallet();
    await renderPrompt(999);
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));

    expect(await screen.findByText(/Add it in your wallet, then try again/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Add /i })).toBeNull();
    expect(calls(provider, 'wallet_addEthereumChain')).toHaveLength(0);
  });

  it('refuses to add a network it does not list, even if asked directly', async () => {
    const provider = installWallet();
    const { WalletProvider, useWallet } = await import('./wallet-context');
    function Direct() {
      const wallet = useWallet();
      return (
        <button type="button" onClick={() => void wallet.addChain(1)}>
          add mainnet
        </button>
      );
    }
    render(
      <WalletProvider>
        <Direct />
      </WalletProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'add mainnet' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls(provider, 'wallet_addEthereumChain')).toHaveLength(0);
  });

  it('nothing shows before the user has asked for a switch', async () => {
    installWallet();
    await renderPrompt();
    expect(screen.queryByRole('button', { name: /^Add /i })).toBeNull();
    expect(screen.queryByText(/does not have/i)).toBeNull();
  });
});

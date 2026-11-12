'use client';

/*
 * EIP-1193 wallet connection.
 *
 * What this module will never do, per the frontend contract:
 *   - request, accept, log or persist a private key or seed phrase;
 *   - connect without a user action;
 *   - switch or add a network without a user action.
 *
 * It also exposes `accountEpoch`, which increments on every account or chain
 * change. The authorization flow watches it and throws away any prepared
 * payload and signature when it moves, so a signature can never be submitted
 * against an account the user has since left.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { chainName } from '../../lib/chains';

export type WalletStatus =
  'initialising' | 'unavailable' | 'disconnected' | 'connecting' | 'connected' | 'rejected';

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
}

export interface WalletState {
  readonly status: WalletStatus;
  readonly account?: string | undefined;
  readonly chainId?: number | undefined;
  /** Increments on any account or chain change. Watch it to invalidate state. */
  readonly accountEpoch: number;
  readonly error?: string | undefined;
  connect(): Promise<void>;
  disconnect(): void;
  /** Ask the wallet to move to `chainId`. Only ever called from a user action. */
  requestChain(chainId: number): Promise<void>;
  /** Sign EIP-712 typed data. Returns the signature; throws on rejection. */
  signTypedData(typedData: unknown): Promise<string>;
}

const WalletContext = createContext<WalletState | undefined>(undefined);

function readProvider(): Eip1193Provider | undefined {
  if (typeof window === 'undefined') return undefined;
  const injected = (window as { ethereum?: Eip1193Provider }).ethereum;
  return injected;
}

function isUserRejection(error: unknown): boolean {
  // EIP-1193 user-rejected-request.
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === 4001 || code === 'ACTION_REJECTED') return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('user rejected') || message.includes('user denied');
}

function describe(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}

export function WalletProvider({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>('initialising');
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const providerRef = useRef<Eip1193Provider | undefined>(undefined);

  useEffect(() => {
    const provider = readProvider();
    providerRef.current = provider;
    if (provider === undefined) {
      setStatus('unavailable');
      return;
    }

    let cancelled = false;

    // eth_accounts does not prompt: it only reports an existing authorization.
    void (async () => {
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        const chain = (await provider.request({ method: 'eth_chainId' })) as string;
        if (cancelled) return;
        setChainId(Number.parseInt(chain, 16));
        if (Array.isArray(accounts) && accounts.length > 0) {
          setAccount(accounts[0]);
          setStatus('connected');
        } else {
          setStatus('disconnected');
        }
      } catch {
        if (!cancelled) setStatus('disconnected');
      }
    })();

    const onAccountsChanged = (...args: never[]) => {
      const accounts = args[0] as unknown as string[] | undefined;
      setAccountEpoch((epoch) => epoch + 1);
      if (!Array.isArray(accounts) || accounts.length === 0) {
        setAccount(undefined);
        setStatus('disconnected');
        return;
      }
      setAccount(accounts[0]);
      setStatus('connected');
      setError(undefined);
    };

    const onChainChanged = (...args: never[]) => {
      const chain = args[0] as unknown as string | undefined;
      setAccountEpoch((epoch) => epoch + 1);
      if (typeof chain === 'string') setChainId(Number.parseInt(chain, 16));
    };

    const onDisconnect = () => {
      setAccountEpoch((epoch) => epoch + 1);
      setAccount(undefined);
      setStatus('disconnected');
    };

    provider.on?.('accountsChanged', onAccountsChanged);
    provider.on?.('chainChanged', onChainChanged);
    provider.on?.('disconnect', onDisconnect);

    return () => {
      cancelled = true;
      provider.removeListener?.('accountsChanged', onAccountsChanged);
      provider.removeListener?.('chainChanged', onChainChanged);
      provider.removeListener?.('disconnect', onDisconnect);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = providerRef.current;
    if (provider === undefined) {
      setStatus('unavailable');
      return;
    }
    setStatus('connecting');
    setError(undefined);
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const chain = (await provider.request({ method: 'eth_chainId' })) as string;
      setChainId(Number.parseInt(chain, 16));
      if (!Array.isArray(accounts) || accounts.length === 0) {
        setStatus('disconnected');
        setError('The wallet returned no account.');
        return;
      }
      setAccount(accounts[0]);
      setAccountEpoch((epoch) => epoch + 1);
      setStatus('connected');
    } catch (caught) {
      if (isUserRejection(caught)) {
        setStatus('rejected');
        setError('You declined the connection request.');
        return;
      }
      setStatus('disconnected');
      setError(describe(caught, 'The wallet could not be connected.'));
    }
  }, []);

  const disconnect = useCallback(() => {
    // An injected wallet cannot be force-disconnected from a page; this drops
    // the app's own session, which is what the user is asking for.
    setAccount(undefined);
    setStatus('disconnected');
    setError(undefined);
    setAccountEpoch((epoch) => epoch + 1);
  }, []);

  const requestChain = useCallback(async (target: number) => {
    const provider = providerRef.current;
    if (provider === undefined) return;
    const hex = `0x${target.toString(16)}`;
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hex }],
      });
      setError(undefined);
    } catch (caught) {
      if (isUserRejection(caught)) {
        setError('You declined the network switch.');
        return;
      }
      // 4902: the chain is unknown to the wallet. We do NOT add it silently —
      // adding a network is the user's decision, made in their wallet.
      setError(
        describe(
          caught,
          `This wallet is not on chain ${String(target)}. Add it in your wallet, then try again.`,
        ),
      );
    }
  }, []);

  const signTypedData = useCallback(
    async (typedData: unknown): Promise<string> => {
      const provider = providerRef.current;
      if (provider === undefined) throw new Error('No wallet is available.');
      if (account === undefined) throw new Error('No account is connected.');

      // BigInt values in the typed message cannot survive JSON, so they are
      // stringified here. The hash the wallet shows is unchanged: EIP-712
      // encodes a uint256 identically whether it arrived as a BigInt or a
      // decimal string.
      const payload = JSON.stringify(typedData, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );

      const signature = (await provider.request({
        method: 'eth_signTypedData_v4',
        params: [account, payload],
      })) as string;

      if (typeof signature !== 'string' || !signature.startsWith('0x')) {
        throw new Error('The wallet returned a signature this app cannot use.');
      }
      return signature;
    },
    [account],
  );

  const value = useMemo<WalletState>(
    () => ({
      status,
      account,
      chainId,
      accountEpoch,
      error,
      connect,
      disconnect,
      requestChain,
      signTypedData,
    }),
    [
      status,
      account,
      chainId,
      accountEpoch,
      error,
      connect,
      disconnect,
      requestChain,
      signTypedData,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const state = useContext(WalletContext);
  if (state === undefined) {
    throw new Error('useWallet must be used inside a WalletProvider.');
  }
  return state;
}

/** True when the wallet is usable for reads. */
export function isConnected(state: WalletState): state is WalletState & { account: string } {
  return state.status === 'connected' && typeof state.account === 'string';
}

/** The user-visible label for a chain id, from the known-chain map. */
export function chainLabel(chainId: number | undefined): string {
  return chainName(chainId);
}

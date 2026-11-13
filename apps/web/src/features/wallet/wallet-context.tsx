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

import { getTypesForEIP712Domain, serializeTypedData, type TypedDataDomain } from 'viem';
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
import { DEMO_ACCOUNT, DEMO_CHAIN_ID, isDemoActive, startDemo, stopDemo } from '../../lib/demo';

/** What "signing" returns in the recorded demo. Deliberately not a signature. */
export const DEMO_SIGNATURE = `0x${'de'.repeat(65)}`;

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
  /**
   * Ask the wallet to send one transaction and return its hash. Only ever
   * called from a user action, for a lending-protocol permission the
   * backend prepared. Throws on rejection, and always in the recorded demo.
   */
  sendTransaction(transaction: { readonly to: string; readonly data: string }): Promise<string>;
  /**
   * Wait until a transaction is mined. Resolves with its block and whether
   * it succeeded; rejects if it is not mined within the timeout.
   */
  waitForTransaction(
    hash: string,
    timeoutMs?: number,
  ): Promise<{ readonly blockNumber: string; readonly succeeded: boolean }>;
  /**
   * True while this tab is in the recorded demo: no wallet is involved, the
   * account is the one the recording was made with, and nothing is signed.
   */
  readonly isDemo: boolean;
  /** Enter the recorded demo. Only ever called from a user action. */
  enterDemo(): void;
  /** Leave the recorded demo and return to the real wallet state. */
  exitDemo(): void;
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
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    const provider = readProvider();
    providerRef.current = provider;

    // A reload inside the recorded demo stays in the demo. The real wallet is
    // not consulted at all while it is active.
    if (isDemoActive()) {
      setIsDemo(true);
      setAccount(DEMO_ACCOUNT);
      setChainId(DEMO_CHAIN_ID);
      setStatus('connected');
      return;
    }

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

  const enterDemo = useCallback(() => {
    startDemo();
    setIsDemo(true);
    setAccount(DEMO_ACCOUNT);
    setChainId(DEMO_CHAIN_ID);
    setStatus('connected');
    setError(undefined);
    setAccountEpoch((epoch) => epoch + 1);
  }, []);

  const exitDemo = useCallback(() => {
    stopDemo();
    setIsDemo(false);
    setAccount(undefined);
    setChainId(undefined);
    setStatus(providerRef.current === undefined ? 'unavailable' : 'disconnected');
    setError(undefined);
    setAccountEpoch((epoch) => epoch + 1);
  }, []);

  const disconnect = useCallback(() => {
    if (isDemoActive()) {
      exitDemo();
      return;
    }
    // An injected wallet cannot be force-disconnected from a page; this drops
    // the app's own session, which is what the user is asking for.
    setAccount(undefined);
    setStatus('disconnected');
    setError(undefined);
    setAccountEpoch((epoch) => epoch + 1);
  }, [exitDemo]);

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
      /*
       * In the recorded demo there is no wallet and nothing is signed. The
       * value returned is a visibly artificial placeholder — all `de` bytes —
       * so it can never be mistaken for, or used as, a real signature. The
       * demo's data source executes nothing with it.
       */
      if (isDemoActive()) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return DEMO_SIGNATURE;
      }
      const provider = providerRef.current;
      if (provider === undefined) throw new Error('No wallet is available.');
      if (account === undefined) throw new Error('No account is connected.');

      /*
       * A wallet computes the domain separator from `types.EIP712Domain`. The
       * helpers that build these messages leave it out, as libraries that sign
       * with a local key derive it themselves. Sent as-is, a wallet would hash
       * an empty domain and produce a signature that verifies nowhere. So the
       * domain type is derived here from the fields the domain actually has,
       * and the payload is serialized the way wallets expect (BigInt values as
       * decimal strings, which EIP-712 encodes identically).
       */
      const data = typedData as {
        domain?: TypedDataDomain;
        types: Record<string, readonly { name: string; type: string }[]>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const payload = serializeTypedData({
        domain: data.domain ?? {},
        types: {
          EIP712Domain: getTypesForEIP712Domain({ domain: data.domain }),
          ...data.types,
        },
        primaryType: data.primaryType,
        message: data.message,
      } as never);

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

  const sendTransaction = useCallback(
    async (transaction: { readonly to: string; readonly data: string }): Promise<string> => {
      // The demo replays recordings. It never asks for a transaction.
      if (isDemoActive()) throw new Error('The recorded demo sends no transactions.');
      const provider = providerRef.current;
      if (provider === undefined) throw new Error('No wallet is available.');
      if (account === undefined) throw new Error('No account is connected.');
      const hash = (await provider.request({
        method: 'eth_sendTransaction',
        // No value is ever attached: these are permission calls, not payments.
        params: [{ from: account, to: transaction.to, data: transaction.data, value: '0x0' }],
      })) as string;
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error('The wallet returned a transaction hash this app cannot use.');
      }
      return hash;
    },
    [account],
  );

  const waitForTransaction = useCallback(
    async (
      hash: string,
      timeoutMs = 120_000,
    ): Promise<{ readonly blockNumber: string; readonly succeeded: boolean }> => {
      const provider = providerRef.current;
      if (provider === undefined) throw new Error('No wallet is available.');
      const startedAt = Date.now();
      for (;;) {
        const receipt = (await provider.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        })) as { blockNumber?: string; status?: string } | null;
        if (receipt !== null && typeof receipt.blockNumber === 'string') {
          return {
            blockNumber: BigInt(receipt.blockNumber).toString(),
            succeeded: receipt.status === '0x1',
          };
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error('The transaction was not mined in time. Check it in your wallet.');
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    },
    [],
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
      sendTransaction,
      waitForTransaction,
      isDemo,
      enterDemo,
      exitDemo,
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
      sendTransaction,
      waitForTransaction,
      isDemo,
      enterDemo,
      exitDemo,
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

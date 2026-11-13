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
 *
 * And it owns the borrower session. Connecting a wallet only tells the app an
 * address; the API answers nothing about that address until its owner signs a
 * one-time login message. That signature proves control of the wallet for API
 * access and authorizes nothing else. The session itself is an HttpOnly
 * cookie: this module learns whether one exists, never what it is.
 */

import {
  getTypesForEIP712Domain,
  isAddressEqual,
  serializeTypedData,
  stringToHex,
  type Address,
  type TypedDataDomain,
} from 'viem';
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

import { ApiError, api, onSessionLost } from '../../lib/api/client';
import { chainName } from '../../lib/chains';
import { DEMO_ACCOUNT, DEMO_CHAIN_ID, isDemoActive, startDemo, stopDemo } from '../../lib/demo';

/** What "signing" returns in the recorded demo. Deliberately not a signature. */
export const DEMO_SIGNATURE = `0x${'de'.repeat(65)}`;

export type WalletStatus =
  'initialising' | 'unavailable' | 'disconnected' | 'connecting' | 'connected' | 'rejected';

/**
 * Where the borrower session stands.
 *
 *   unknown      not asked yet (no wallet connected, or still starting up)
 *   checking     asking the API whether this browser already has a session
 *   none         no session for the connected account: a sign-in is needed
 *   signing      a sign-in is in progress in the wallet
 *   active       the API recognises the connected account
 *   unreachable  the API could not be asked; nothing is known either way
 */
export type SessionStatus = 'unknown' | 'checking' | 'none' | 'signing' | 'active' | 'unreachable';

export interface SessionState {
  readonly status: SessionStatus;
  /** When the active session ends, as the API reported it. */
  readonly expiresAt?: string | undefined;
  /** Why there is no session, when there is something to say. */
  readonly notice?: string | undefined;
}

function sameAccount(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  try {
    return isAddressEqual(left as Address, right as Address);
  } catch {
    return false;
  }
}

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
  /** The borrower session for the connected account. */
  readonly session: SessionState;
  /**
   * Prove control of the connected wallet to the API: fetch a one-time
   * message, have the wallet sign it exactly as issued, and exchange the
   * signature for a session. Only ever called from a user action.
   */
  signIn(): Promise<void>;
  /** Ask the API again whether a session exists. */
  recheckSession(): void;
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
  const [session, setSession] = useState<SessionState>({ status: 'unknown' });
  const [sessionTick, setSessionTick] = useState(0);
  // True while a sign-in is in flight. Signing in can switch the wallet's
  // network, which moves `accountEpoch`; the session check below must not
  // overwrite the sign-in's own outcome when that happens.
  const signingRef = useRef(false);
  const sessionRef = useRef<SessionState>(session);
  sessionRef.current = session;

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

  /*
   * Whether this browser already has a session for the connected account.
   *
   * Asked whenever the account can have changed. A session for another
   * account is not a session for this one: the screens behind it would be
   * refused, so it counts as none.
   */
  useEffect(() => {
    if (isDemo) {
      setSession({ status: 'active' });
      return;
    }
    if (status !== 'connected' || account === undefined) {
      setSession({ status: 'unknown' });
      return;
    }
    if (signingRef.current) return;

    let cancelled = false;
    setSession((previous) =>
      // A re-check of an account that is already signed in keeps the screens
      // mounted; only a first check shows the waiting state.
      previous.status === 'active' ? previous : { status: 'checking' },
    );
    void (async () => {
      try {
        const current = await api.session();
        if (cancelled || signingRef.current) return;
        if (current !== undefined && sameAccount(current.wallet, account)) {
          setSession({ status: 'active', expiresAt: current.expiresAt });
        } else {
          setSession({ status: 'none' });
        }
      } catch (caught) {
        if (cancelled || signingRef.current) return;
        setSession({
          status: 'unreachable',
          notice:
            caught instanceof ApiError
              ? caught.message
              : 'The API could not be asked whether you are signed in.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDemo, status, account, accountEpoch, sessionTick]);

  // A borrower route refused the session: it expired, was revoked, or belongs
  // to another account. Ask for a new proof rather than leaving every screen
  // to fail on its own.
  useEffect(
    () =>
      onSessionLost((reason) => {
        if (signingRef.current) return;
        if (sessionRef.current.status !== 'active') return;
        setSession({
          status: 'none',
          notice:
            reason === 'mismatch'
              ? 'Your session belongs to a different account. Sign in with this one.'
              : 'Your session ended. Sign in again to continue.',
        });
      }),
    [],
  );

  const recheckSession = useCallback(() => setSessionTick((value) => value + 1), []);

  const signIn = useCallback(async () => {
    if (isDemoActive()) return;
    const provider = providerRef.current;
    if (provider === undefined || account === undefined) {
      setSession({ status: 'none', notice: 'Connect a wallet first.' });
      return;
    }
    if (signingRef.current) return;
    signingRef.current = true;
    setSession({ status: 'signing' });
    try {
      const challenge = await api.authChallenge(account);

      // The message must be the one issued for this account. Anything else is
      // not signed.
      if (
        !sameAccount(challenge.wallet, account) ||
        typeof challenge.message !== 'string' ||
        !challenge.message.toLowerCase().includes(account.toLowerCase())
      ) {
        setSession({
          status: 'none',
          notice: 'The API issued a login message for a different account. Nothing was signed.',
        });
        return;
      }

      // The login message names the chain the session is bound to, so the
      // wallet is asked to be on it first. This runs inside the user's click.
      const walletChain = Number.parseInt(
        (await provider.request({ method: 'eth_chainId' })) as string,
        16,
      );
      if (walletChain !== challenge.chainId) {
        try {
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${challenge.chainId.toString(16)}` }],
          });
        } catch (caught) {
          setSession({
            status: 'none',
            notice: isUserRejection(caught)
              ? 'You declined the network switch. Nothing was signed.'
              : `Signing in needs your wallet on ${chainName(challenge.chainId)} (chain ${String(challenge.chainId)}). Add or select it in your wallet, then try again.`,
          });
          return;
        }
      }

      let signature: string;
      try {
        signature = (await provider.request({
          method: 'personal_sign',
          params: [stringToHex(challenge.message), account],
        })) as string;
      } catch (caught) {
        setSession({
          status: 'none',
          notice: isUserRejection(caught)
            ? 'You declined the sign-in request. Nothing was signed.'
            : describe(caught, 'The wallet could not sign the login message.'),
        });
        return;
      }
      if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
        setSession({
          status: 'none',
          notice: 'The wallet returned a signature this app cannot use.',
        });
        return;
      }

      const opened = await api.authVerify(challenge.challengeId, signature);
      if (!sameAccount(opened.wallet, account)) {
        setSession({
          status: 'none',
          notice: 'The API opened a session for a different account. Sign in again.',
        });
        return;
      }
      setSession({ status: 'active', expiresAt: opened.expiresAt });
    } catch (caught) {
      const unreachable =
        caught instanceof ApiError && (caught.code === 'NETWORK' || caught.code === 'TIMEOUT');
      setSession({
        status: unreachable ? 'unreachable' : 'none',
        notice:
          caught instanceof ApiError
            ? caught.message
            : describe(caught, 'Signing in did not complete.'),
      });
    } finally {
      signingRef.current = false;
    }
  }, [account]);

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
    // the app's own session, which is what the user is asking for. The API
    // session is revoked too, so the cookie left in this browser is worthless.
    if (sessionRef.current.status === 'active') {
      void api.logout().catch(() => {
        // Not reachable: the cookie still expires on its own.
      });
    }
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
      session,
      signIn,
      recheckSession,
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
      session,
      signIn,
      recheckSession,
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

/** True when the API recognises the connected account. */
export function hasSession(state: WalletState): boolean {
  return isConnected(state) && state.session.status === 'active';
}

/** The user-visible label for a chain id, from the known-chain map. */
export function chainLabel(chainId: number | undefined): string {
  return chainName(chainId);
}

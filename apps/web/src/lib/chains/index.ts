/*
 * Chain names and block explorers.
 *
 * The frontend contract allows "an environment map only for known chains":
 * explorer metadata is not an API contract yet, so links are built here for
 * chains this file explicitly knows, and for nothing else. An unknown chain
 * gets its numeric id and no link; the two local sandbox chains have names and
 * deliberately no explorer.
 *
 * This replaced labels that were hardcoded for the local stack (31337/31338),
 * which would have been wrong the moment the app was hosted against a public
 * testnet.
 */

interface KnownChain {
  readonly name: string;
  /** Explorer origin, without a trailing slash. Absent for private chains. */
  readonly explorer?: string;
  /**
   * A public RPC endpoint a wallet can be given for this chain. Present only
   * for the public testnets this app may ask a wallet to add; see
   * `walletChainParameters`.
   */
  readonly publicRpc?: string;
}

const KNOWN_CHAINS: Readonly<Record<number, KnownChain>> = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io' },
  10: { name: 'OP Mainnet', explorer: 'https://optimistic.etherscan.io' },
  137: { name: 'Polygon', explorer: 'https://polygonscan.com' },
  8453: { name: 'Base', explorer: 'https://basescan.org' },
  42161: { name: 'Arbitrum One', explorer: 'https://arbiscan.io' },
  11155111: {
    name: 'Sepolia',
    explorer: 'https://sepolia.etherscan.io',
    publicRpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  84532: {
    name: 'Base Sepolia',
    explorer: 'https://sepolia.basescan.org',
    publicRpc: 'https://sepolia.base.org',
  },
  421614: {
    name: 'Arbitrum Sepolia',
    explorer: 'https://sepolia.arbiscan.io',
    publicRpc: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  // Private sandbox chains: real transactions, no public explorer.
  31337: { name: 'Sandbox source chain' },
  31338: { name: 'Sandbox destination chain' },
};

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/u;

/** `Base · 8453`, or `Chain 999` for a chain this app does not know. */
export function chainName(chainId: number | null | undefined): string {
  if (chainId === null || chainId === undefined) return 'Unknown network';
  const known = KNOWN_CHAINS[chainId];
  return known ? `${known.name} · ${String(chainId)}` : `Chain ${String(chainId)}`;
}

/** True when this app recognises the chain at all. */
export function isKnownChain(chainId: number | null | undefined): boolean {
  return chainId !== null && chainId !== undefined && KNOWN_CHAINS[chainId] !== undefined;
}

/**
 * A block-explorer URL for a transaction, or `undefined`.
 *
 * `undefined` whenever the chain is unknown, has no public explorer, or the
 * hash is not a well-formed transaction hash. A link is only ever built from a
 * fixed origin in the map above plus a validated hash — never from a value the
 * backend sent as a URL.
 */
export function explorerTransactionUrl(
  chainId: number | null | undefined,
  transactionHash: string | null | undefined,
): string | undefined {
  if (chainId === null || chainId === undefined) return undefined;
  if (typeof transactionHash !== 'string' || !TRANSACTION_HASH.test(transactionHash)) {
    return undefined;
  }
  const explorer = KNOWN_CHAINS[chainId]?.explorer;
  return explorer === undefined ? undefined : `${explorer}/tx/${transactionHash}`;
}

/** What `wallet_addEthereumChain` (EIP-3085) is given for one chain. */
export interface WalletChainParameters {
  readonly chainId: string;
  readonly chainName: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: 18;
  };
  readonly rpcUrls: readonly string[];
  readonly blockExplorerUrls: readonly string[];
}

/**
 * The network details this app may offer to add to a wallet, or `undefined`.
 *
 * Only public testnets are offered. A mainnet is something a wallet already
 * has, and pointing one at an RPC endpoint of this app's choosing is not a
 * decision to make for the user. The private sandbox chains exist only on a
 * developer's machine, so there is nothing meaningful to add for them.
 *
 * Every value comes from the fixed map above. Nothing the backend sends is
 * ever passed to a wallet as a network.
 */
export function walletChainParameters(
  chainId: number | null | undefined,
): WalletChainParameters | undefined {
  if (chainId === null || chainId === undefined) return undefined;
  const known = KNOWN_CHAINS[chainId];
  if (known?.publicRpc === undefined || known.explorer === undefined) return undefined;
  return {
    chainId: `0x${chainId.toString(16)}`,
    chainName: known.name,
    // Every testnet offered here pays gas in test ETH.
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [known.publicRpc],
    blockExplorerUrls: [known.explorer],
  };
}

/**
 * True for the two private sandbox chains.
 *
 * Used to decide whether a hint that only makes sense on a developer's local
 * chain — an idle Anvil mines no block, so data ages out — should be shown.
 * On a public testnet that hint would be wrong and is withheld.
 */
export function isPrivateSandboxChain(chainId: number | null | undefined): boolean {
  return chainId === 31337 || chainId === 31338;
}

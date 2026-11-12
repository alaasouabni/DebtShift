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
}

const KNOWN_CHAINS: Readonly<Record<number, KnownChain>> = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io' },
  10: { name: 'OP Mainnet', explorer: 'https://optimistic.etherscan.io' },
  137: { name: 'Polygon', explorer: 'https://polygonscan.com' },
  8453: { name: 'Base', explorer: 'https://basescan.org' },
  42161: { name: 'Arbitrum One', explorer: 'https://arbiscan.io' },
  11155111: { name: 'Sepolia', explorer: 'https://sepolia.etherscan.io' },
  84532: { name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
  421614: { name: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io' },
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

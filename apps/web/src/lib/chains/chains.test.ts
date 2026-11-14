import { describe, expect, it } from 'vitest';

import { chainName, explorerTransactionUrl, isKnownChain, isPrivateSandboxChain } from './index';

const HASH = `0x${'ab'.repeat(32)}`;

describe('chainName', () => {
  it('names the public chains the product may run on', () => {
    expect(chainName(1)).toBe('Ethereum · 1');
    expect(chainName(8453)).toBe('Base · 8453');
    expect(chainName(11155111)).toBe('Sepolia · 11155111');
  });

  it('names the sandbox chains without calling them a public network', () => {
    expect(chainName(31337)).toBe('Sandbox source chain · 31337');
    expect(chainName(31338)).toBe('Sandbox destination chain · 31338');
  });

  it('shows the bare id for a chain it does not know, rather than guessing', () => {
    expect(chainName(999_999)).toBe('Chain 999999');
  });

  it('handles a missing chain id', () => {
    expect(chainName(undefined)).toBe('Unknown network');
    expect(chainName(null)).toBe('Unknown network');
  });
});

describe('explorerTransactionUrl', () => {
  it('builds a link for a known public chain', () => {
    expect(explorerTransactionUrl(1, HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
    expect(explorerTransactionUrl(84532, HASH)).toBe(`https://sepolia.basescan.org/tx/${HASH}`);
  });

  it('builds none for the sandbox chains, which have no explorer', () => {
    expect(explorerTransactionUrl(31337, HASH)).toBeUndefined();
    expect(explorerTransactionUrl(31338, HASH)).toBeUndefined();
  });

  it('builds none for an unknown chain', () => {
    expect(explorerTransactionUrl(999_999, HASH)).toBeUndefined();
  });

  it('builds none from the null columns a real migration returns', () => {
    expect(explorerTransactionUrl(null, null)).toBeUndefined();
    expect(explorerTransactionUrl(1, null)).toBeUndefined();
    expect(explorerTransactionUrl(undefined, HASH)).toBeUndefined();
  });

  it('refuses anything that is not a well-formed transaction hash', () => {
    // The URL is only ever a fixed origin plus a validated hash, so a value
    // that tries to smuggle a path or a script in yields no link at all.
    expect(explorerTransactionUrl(1, '0x1234')).toBeUndefined();
    expect(explorerTransactionUrl(1, `${HASH}/../../evil`)).toBeUndefined();
    expect(explorerTransactionUrl(1, 'javascript:alert(1)')).toBeUndefined();
    expect(explorerTransactionUrl(1, `0x${'zz'.repeat(32)}`)).toBeUndefined();
  });
});

describe('isKnownChain', () => {
  it('distinguishes known from unknown', () => {
    expect(isKnownChain(1)).toBe(true);
    expect(isKnownChain(31337)).toBe(true);
    expect(isKnownChain(999_999)).toBe(false);
    expect(isKnownChain(undefined)).toBe(false);
  });
});

describe('isPrivateSandboxChain', () => {
  it('is true only for the two sandbox chains', () => {
    expect(isPrivateSandboxChain(31337)).toBe(true);
    expect(isPrivateSandboxChain(31338)).toBe(true);
    expect(isPrivateSandboxChain(11155111)).toBe(false);
    expect(isPrivateSandboxChain(1)).toBe(false);
    expect(isPrivateSandboxChain(null)).toBe(false);
  });
});

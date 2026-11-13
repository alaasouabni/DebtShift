import { existsSync } from 'node:fs';

const readyFile = process.env.DEBTSHIFT_LOCAL_STACK_READY_FILE;
if (readyFile !== undefined && !existsSync(readyFile)) {
  throw new Error('The local chains are reachable but the DebtShift deployment is not ready.');
}

const chains = [
  {
    name: 'source',
    rpcUrl: process.env.SOURCE_RPC_URL ?? 'http://127.0.0.1:8545',
    expectedChainId: Number(process.env.SOURCE_CHAIN_ID ?? 31_337),
  },
  {
    name: 'destination',
    rpcUrl: process.env.DESTINATION_RPC_URL ?? 'http://127.0.0.1:8546',
    expectedChainId: Number(process.env.DESTINATION_CHAIN_ID ?? 31_338),
  },
];

for (const chain of chains) {
  const response = await fetch(chain.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`${chain.name} RPC returned HTTP ${response.status}.`);
  const body = await response.json();
  const actualChainId = Number.parseInt(body.result, 16);
  if (actualChainId !== chain.expectedChainId) {
    throw new Error(
      `${chain.name} RPC chain mismatch: expected ${chain.expectedChainId}, received ${actualChainId}.`,
    );
  }
}

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { createPublicClient, defineChain, http, type Chain, type PublicClient } from 'viem';

export interface LocalAnvilChain {
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly publicClient: PublicClient;
  stop(): Promise<void>;
}

export interface StartAnvilOptions {
  readonly chainId: number;
  readonly port: number;
  readonly anvilPath?: string;
}

type AnvilProcess = ChildProcessByStdio<null, Readable, Readable>;

export async function startAnvil(options: StartAnvilOptions): Promise<LocalAnvilChain> {
  const rpcUrl = `http://127.0.0.1:${options.port}`;
  const chain = defineChain({
    id: options.chainId,
    name: `DebtShift Local ${options.chainId}`,
    nativeCurrency: { name: 'Local Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const child = spawn(
    resolveAnvilPath(options.anvilPath),
    [
      '--port',
      String(options.port),
      '--chain-id',
      String(options.chainId),
      '--host',
      '127.0.0.1',
      '--silent',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const errors: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString('utf8')));
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  try {
    await waitForRpc(publicClient, child, errors);
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    chain,
    rpcUrl,
    publicClient,
    stop: () => stopProcess(child),
  };
}

export function resolveAnvilPath(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.length > 0) return explicitPath;
  if (process.env.ANVIL_PATH !== undefined && process.env.ANVIL_PATH.length > 0) {
    return process.env.ANVIL_PATH;
  }
  const foundryInstallation = join(
    homedir(),
    '.foundry',
    'bin',
    process.platform === 'win32' ? 'anvil.exe' : 'anvil',
  );
  return existsSync(foundryInstallation) ? foundryInstallation : 'anvil';
}

async function waitForRpc(
  client: PublicClient,
  child: AnvilProcess,
  errors: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Anvil exited before becoming ready: ${errors.join('').trim()}`);
    }
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error(`Timed out waiting for Anvil RPC. ${errors.join('').trim()}`);
}

async function stopProcess(child: AnvilProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

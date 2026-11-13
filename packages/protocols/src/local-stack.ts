import { deployLocalDebtShift } from './local-deployment.js';
import { startAnvil } from './local-chain.js';
import { rm, writeFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const readyFile = process.env.DEBTSHIFT_LOCAL_STACK_READY_FILE;
  if (readyFile !== undefined) await rm(readyFile, { force: true });
  const bindHost = process.env.ANVIL_BIND_HOST ?? '127.0.0.1';
  const blockTimeSeconds = parsePositiveInteger(
    process.env.ANVIL_BLOCK_TIME_SECONDS ?? '1',
    'ANVIL_BLOCK_TIME_SECONDS',
  );
  const source = await startAnvil({
    chainId: 31_337,
    port: 8_545,
    bindHost,
    blockTimeSeconds,
  });
  const destination = await startAnvil({
    chainId: 31_338,
    port: 8_546,
    bindHost,
    blockTimeSeconds,
  });
  try {
    const deployment = await deployLocalDebtShift(
      source.chain,
      source.publicClient,
      destination.chain,
      destination.publicClient,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'ready',
          warning: 'Disposable Anvil test assets only.',
          sourceRpc: source.rpcUrl,
          destinationRpc: destination.rpcUrl,
          borrower: deployment.borrower,
          deployment,
        },
        undefined,
        2,
      )}\n`,
    );
    if (readyFile !== undefined) {
      await writeFile(
        readyFile,
        `${JSON.stringify({ status: 'ready', borrower: deployment.borrower })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    }
    await waitForShutdown();
  } finally {
    if (readyFile !== undefined) await rm(readyFile, { force: true });
    await Promise.all([source.stop(), destination.stop()]);
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolvePromise) => {
    process.once('SIGINT', resolvePromise);
    process.once('SIGTERM', resolvePromise);
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

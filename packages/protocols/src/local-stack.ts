import { deployLocalDebtShift } from './local-deployment.js';
import { startAnvil } from './local-chain.js';

async function main(): Promise<void> {
  const source = await startAnvil({ chainId: 31_337, port: 8_545 });
  const destination = await startAnvil({ chainId: 31_338, port: 8_546 });
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
    await waitForShutdown();
  } finally {
    await Promise.all([source.stop(), destination.stop()]);
  }
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

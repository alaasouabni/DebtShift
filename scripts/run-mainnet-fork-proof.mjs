import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.env.MAINNET_EXECUTION_ENABLED === 'true') {
  throw new Error('The mainnet-fork proof requires MAINNET_EXECUTION_ENABLED=false.');
}

const reportPath = resolve(
  process.env.MAINNET_FORK_PROOF_REPORT_PATH ??
    'deployment/evidence/mainnet-fork-route-discovery-proof-20261114.json',
);
const environment = {
  ...process.env,
  MAINNET_EXECUTION_ENABLED: 'false',
  BASE_FORK_RPC_URL: process.env.BASE_FORK_RPC_URL ?? 'https://mainnet.base.org',
  ARBITRUM_FORK_RPC_URL: process.env.ARBITRUM_FORK_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',
  MAINNET_FORK_PROOF_REPORT_PATH: reportPath,
};
const windows = process.platform === 'win32';
const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const argumentsList = windows
  ? [
      '/d',
      '/s',
      '/c',
      'npm.cmd run test --workspace @debtshift/protocols -- --run src/discovered-route-fork.integration.test.ts',
    ]
  : [
      'run',
      'test',
      '--workspace',
      '@debtshift/protocols',
      '--',
      '--run',
      'src/discovered-route-fork.integration.test.ts',
    ];
const result = spawnSync(command, argumentsList, {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(reportPath)) throw new Error(`Fork proof did not write ${reportPath}.`);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (
  report.status !== 'PASSED' ||
  report.mainnetExecutionEnabled !== false ||
  report.transport?.executionBoundary !== 'SIMULATED_1CLICK_BOUNDARY'
) {
  throw new Error('Fork proof report failed its completion and safety invariants.');
}
console.log(
  JSON.stringify({
    status: report.status,
    reportPath,
    selectedCandidateId: report.discovery?.selectedCandidateId,
    sourceBlock: report.sourceBlock,
    destinationBlock: report.destinationBlock,
    transportBoundary: report.transport.executionBoundary,
    mainnetExecutionEnabled: report.mainnetExecutionEnabled,
  }),
);

import { spawnSync } from 'node:child_process';

const forkRpcUrl = process.env.BASE_FORK_RPC_URL;
if (forkRpcUrl === undefined || forkRpcUrl.trim().length === 0) {
  console.error(
    'BASE_FORK_RPC_URL is required. Supply an archival Base RPC URL; no real wallet or funds are used.',
  );
  process.exit(1);
}
if (!forkRpcUrl.startsWith('https://')) {
  console.error('BASE_FORK_RPC_URL must use HTTPS.');
  process.exit(1);
}

const windows = process.platform === 'win32';
const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const argumentsList = windows
  ? ['/d', '/s', '/c', 'npm.cmd run test:fork --workspace @debtshift/protocols']
  : ['run', 'test:fork', '--workspace', '@debtshift/protocols'];
const result = spawnSync(command, argumentsList, {
  cwd: process.cwd(),
  env: { ...process.env, BASE_FORK_RPC_URL: forkRpcUrl },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);

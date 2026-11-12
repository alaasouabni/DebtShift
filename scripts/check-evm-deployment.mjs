import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';
const commands = [
  ['run', 'build', '--workspace', '@debtshift/domain'],
  ['run', 'build', '--workspace', '@debtshift/protocols'],
  ['run', 'test:deployment', '--workspace', '@debtshift/protocols'],
];

for (const arguments_ of commands) {
  // Windows batch shims (npm.cmd) cannot be executed directly by every
  // supported Node release. Use the command shell only on Windows; Linux CI
  // keeps the narrower direct-spawn path.
  const result = spawnSync('npm', arguments_, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: isWindows,
    windowsHide: true,
    env: { ...process.env, RUN_EVM_DEPLOYMENT_TESTS: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

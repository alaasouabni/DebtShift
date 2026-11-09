import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installedForge = join(
  homedir(),
  '.foundry',
  'bin',
  process.platform === 'win32' ? 'forge.exe' : 'forge',
);
const forge = process.env.FORGE_PATH || (existsSync(installedForge) ? installedForge : 'forge');
const commands = [
  ['fmt', '--check', '--root', 'contracts/evm'],
  ['build', '--root', 'contracts/evm'],
  ['test', '--root', 'contracts/evm'],
];

for (const arguments_ of commands) {
  const result = spawnSync(forge, arguments_, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

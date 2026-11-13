import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const expectedFoundryVersion = readFileSync(
  join(repositoryRoot, '.foundry-version'),
  'utf8',
).trim();
const versionResult = spawnSync(forge, ['--version'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (versionResult.error) throw versionResult.error;
if (versionResult.status !== 0) {
  process.stderr.write(
    versionResult.stderr || versionResult.stdout || 'Unable to read Foundry version.\n',
  );
  process.exit(versionResult.status ?? 1);
}
const installedVersion = /forge Version:\s+(\d+\.\d+\.\d+)/u.exec(versionResult.stdout)?.[1];
if (installedVersion !== expectedFoundryVersion) {
  process.stderr.write(
    `Foundry ${expectedFoundryVersion} is required by .foundry-version; ${forge} reported ${installedVersion ?? 'an unknown version'}.\n`,
  );
  process.exit(1);
}

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

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const projectRoot = resolve(repositoryRoot, 'contracts/morpho-testnet');
const expectedVersion = readFileSync(resolve(repositoryRoot, '.foundry-version'), 'utf8').trim();
const installedForge = join(
  homedir(),
  '.foundry',
  'bin',
  process.platform === 'win32' ? 'forge.exe' : 'forge',
);
const forge = process.env.FORGE_PATH || (existsSync(installedForge) ? installedForge : 'forge');
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
if (installedVersion !== expectedVersion) {
  throw new Error(
    `Foundry ${expectedVersion} is required; ${forge} reported ${installedVersion ?? 'an unknown version'}.`,
  );
}
for (const args of [['fmt', '--check'], ['build', '--force'], ['test']]) {
  const result = spawnSync(forge, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

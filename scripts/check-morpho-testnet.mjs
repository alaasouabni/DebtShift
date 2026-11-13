import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const projectRoot = resolve(repositoryRoot, 'contracts/morpho-testnet');
const expectedVersion = readFileSync(resolve(repositoryRoot, '.foundry-version'), 'utf8').trim();
const actualVersion = execFileSync('forge', ['--version'], { encoding: 'utf8' });
if (!actualVersion.includes(expectedVersion)) {
  throw new Error(`Foundry ${expectedVersion} is required; received ${actualVersion.trim()}.`);
}
for (const args of [['fmt', '--check'], ['build', '--force'], ['test']]) {
  const result = spawnSync('forge', args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const root = resolve('contracts/morpho-testnet/vendor/morpho-blue');
const manifestPath = resolve(root, 'UPSTREAM.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(manifest.commit)) {
  throw new Error('Vendored Morpho upstream commit must be a full lowercase Git SHA-1.');
}
const expected = new Map(Object.entries(manifest.gitBlobIds));
const actualPaths = (await walk(root))
  .map((path) => relative(root, path).split(sep).join('/'))
  .filter((path) => path !== 'UPSTREAM.json')
  .sort();
const expectedPaths = [...expected.keys()].sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error('Vendored Morpho file inventory differs from UPSTREAM.json.');
}
for (const path of actualPaths) {
  const blob = execFileSync('git', ['hash-object', '--no-filters', resolve(root, path)], {
    encoding: 'utf8',
  }).trim();
  if (blob !== expected.get(path)) {
    throw new Error(`Vendored Morpho file does not match the pinned upstream blob: ${path}`);
  }
}
console.log(
  JSON.stringify({
    status: 'PINNED_MORPHO_SOURCE_VERIFIED',
    repository: manifest.repository,
    commit: manifest.commit,
    files: actualPaths.length,
  }),
);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

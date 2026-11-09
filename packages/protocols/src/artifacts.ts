import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Abi, Hex } from 'viem';

export interface FoundryArtifact {
  readonly abi: Abi;
  readonly bytecode: Hex;
}

interface FoundryArtifactJson {
  readonly abi?: unknown;
  readonly bytecode?: { readonly object?: unknown };
}

export async function loadFoundryArtifact(contractName: string): Promise<FoundryArtifact> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const artifactPath = resolve(
    repositoryRoot,
    'contracts',
    'evm',
    'out',
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  const parsed = JSON.parse(await readFile(artifactPath, 'utf8')) as FoundryArtifactJson;
  if (!Array.isArray(parsed.abi)) {
    throw new Error(`Foundry artifact ${contractName} has no ABI.`);
  }
  if (
    typeof parsed.bytecode?.object !== 'string' ||
    !parsed.bytecode.object.startsWith('0x') ||
    parsed.bytecode.object.length <= 2
  ) {
    throw new Error(`Foundry artifact ${contractName} has no deployable bytecode.`);
  }

  return {
    abi: parsed.abi as Abi,
    bytecode: parsed.bytecode.object as Hex,
  };
}

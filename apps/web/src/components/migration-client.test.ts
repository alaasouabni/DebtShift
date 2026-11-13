import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  latestMigrationEventSequence,
  migrationIdFromSearch,
  migrationStreamUrl,
  migrationUrl,
} from './migration-client';

const MIGRATION_ID = `0x${'ab'.repeat(32)}`;

describe('migration browser recovery', () => {
  it('accepts only canonical migration identifiers from the URL', () => {
    expect(migrationIdFromSearch(`?migration=${MIGRATION_ID}`)).toBe(MIGRATION_ID);
    expect(migrationIdFromSearch('?migration=not-a-migration')).toBeUndefined();
    expect(migrationIdFromSearch('')).toBeUndefined();
  });

  it('adds and removes a migration without discarding other URL state', () => {
    const withMigration = migrationUrl(
      'https://debtshift.test/?mode=sandbox#workspace',
      MIGRATION_ID,
    );
    expect(withMigration).toBe(`/?mode=sandbox&migration=${MIGRATION_ID}#workspace`);
    expect(migrationUrl(`https://debtshift.test${withMigration}`)).toBe('/?mode=sandbox#workspace');
  });

  it('builds a cursor-resumable stream URL and finds the newest durable sequence', () => {
    expect(migrationStreamUrl('https://api.test/v1/', MIGRATION_ID, 12)).toBe(
      `https://api.test/v1/migrations/${MIGRATION_ID}/stream?after=12`,
    );
    expect(latestMigrationEventSequence([{ sequence: 9 }, { sequence: 3 }, { sequence: 12 }])).toBe(
      12,
    );
  });

  it('keeps browser secrets out of cookies and analytics sinks', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const productionSource = readProductionSources(sourceRoot)
      .map((file) => file.text)
      .join('\n');

    expect(productionSource).not.toMatch(
      /\b(?:indexedDB|sendBeacon|dataLayer|captureException|Sentry|posthog|mixpanel)\b/i,
    );
    expect(productionSource).not.toMatch(/document\.cookie/i);
  });

  /*
   * Browser storage is allowed for four short, non-secret values and nowhere
   * else: the theme choice, the recorded-demo flag, the explanation
   * preferences (never the API key) and the id of the last migration, so a
   * refresh can resume monitoring. A new file that reaches for storage fails
   * here until it is added on purpose.
   */
  it('keeps browser storage to the known non-secret values', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const sources = readProductionSources(sourceRoot);
    const allowed = new Set([
      'features/authorization/authorize-view.tsx',
      'features/history/history-view.tsx',
      'features/migrations/migration-view.tsx',
      'features/settings/explanation-settings.ts',
      'lib/demo/index.ts',
      'lib/theme/index.ts',
    ]);
    const usesStorage = /\bwindow\.(?:localStorage|sessionStorage)\b|\bstorage\(\)\?\./;

    const offenders = sources
      .filter((file) => usesStorage.test(file.text) && !allowed.has(file.path))
      .map((file) => file.path);
    expect(offenders).toEqual([]);

    // Whatever is written is written under one of the fixed keys.
    const keys = sources.flatMap((file) =>
      [...file.text.matchAll(/\.setItem\(\s*([A-Za-z_]+)/g)].map((match) => match[1]),
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(
      new Set(['MIGRATION_STORAGE_KEY', 'STORAGE_KEY', 'THEME_STORAGE_KEY', 'FLAG']),
    );

    // The modules that hold the session and the wallet never touch storage.
    for (const path of [
      'lib/api/client.ts',
      'features/wallet/wallet-context.tsx',
      'features/wallet/session-gate.tsx',
    ]) {
      const file = sources.find((candidate) => candidate.path === path);
      expect(file, path).toBeDefined();
      expect(file!.text).not.toMatch(/\b(?:localStorage|sessionStorage)\b/);
    }
  });
});

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function readProductionSources(directory: string, root = directory): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry): SourceFile[] => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readProductionSources(path, root);
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.includes('.test.')) {
      return [];
    }
    return [
      {
        // Always forward slashes, whatever the platform's separator is.
        path: path.slice(root.length).split(sep).filter(Boolean).join('/'),
        text: readFileSync(path, 'utf8'),
      },
    ];
  });
}

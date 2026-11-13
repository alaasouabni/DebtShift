import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

  it('keeps browser secrets out of persistence, cookies, and analytics sinks', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const productionSource = readProductionSources(sourceRoot).join('\n');

    expect(productionSource).not.toMatch(
      /\b(?:localStorage|sessionStorage|indexedDB|sendBeacon|dataLayer|captureException|Sentry|posthog|mixpanel)\b/i,
    );
    expect(productionSource).not.toMatch(/document\.cookie/i);
  });
});

function readProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readProductionSources(path);
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.includes('.test.')) {
      return [];
    }
    return [readFileSync(path, 'utf8')];
  });
}

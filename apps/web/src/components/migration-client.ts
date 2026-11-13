const migrationIdPattern = /^0x[0-9a-f]{64}$/;

export interface SequencedMigrationEvent {
  readonly sequence: number;
}

export function migrationIdFromSearch(search: string): string | undefined {
  const value = new URLSearchParams(search).get('migration');
  return value !== null && migrationIdPattern.test(value) ? value : undefined;
}

export function migrationUrl(currentUrl: string, migrationId?: string): string {
  const url = new URL(currentUrl);
  if (migrationId === undefined) url.searchParams.delete('migration');
  else {
    assertMigrationId(migrationId);
    url.searchParams.set('migration', migrationId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function migrationStreamUrl(
  apiBase: string,
  migrationId: string,
  afterSequence: number,
): string {
  assertMigrationId(migrationId);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('Migration event cursor must be a non-negative safe integer.');
  }
  return `${apiBase.replace(/\/$/, '')}/migrations/${migrationId}/stream?after=${afterSequence}`;
}

export function latestMigrationEventSequence(events: readonly SequencedMigrationEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.sequence), 0);
}

function assertMigrationId(migrationId: string): void {
  if (!migrationIdPattern.test(migrationId)) throw new Error('Migration identifier is invalid.');
}

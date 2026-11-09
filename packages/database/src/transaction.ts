import { sql } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';

export type DebtShiftTransaction = Parameters<Parameters<DebtShiftDatabase['transaction']>[0]>[0];

export async function inSerializableTransaction<T>(
  database: DebtShiftDatabase,
  operation: (transaction: DebtShiftTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(operation, {
    isolationLevel: 'serializable',
    accessMode: 'read write',
    deferrable: false,
  });
}

export async function lockMigration(
  transaction: DebtShiftTransaction,
  migrationId: string,
): Promise<void> {
  const result = await transaction.execute(sql`
    SELECT migration_id
    FROM migrations
    WHERE migration_id = ${migrationId}
    FOR UPDATE
  `);

  if (result.rowCount !== 1) {
    throw new Error(`Migration ${migrationId} does not exist.`);
  }
}

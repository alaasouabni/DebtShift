import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema.js';

export type DebtShiftDatabase = NodePgDatabase<typeof schema>;

export interface DebtShiftDatabaseClient {
  readonly db: DebtShiftDatabase;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDebtShiftDatabase(config: PoolConfig): DebtShiftDatabaseClient {
  const pool = new Pool({
    ...config,
    application_name: config.application_name ?? 'debtshift',
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => pool.end(),
  };
}

export function createDebtShiftDatabaseFromUrl(databaseUrl: string): DebtShiftDatabaseClient {
  if (databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL must not be empty.');
  }

  return createDebtShiftDatabase({ connectionString: databaseUrl });
}

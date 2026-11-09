import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://debtshift:debtshift_local@localhost:5432/debtshift';
const pool = new pg.Pool({ connectionString, application_name: 'debtshift-migrator', max: 1 });

try {
  await migrate(drizzle(pool), { migrationsFolder });
  process.stdout.write(`Applied DebtShift migrations from ${migrationsFolder}\n`);
} finally {
  await pool.end();
}

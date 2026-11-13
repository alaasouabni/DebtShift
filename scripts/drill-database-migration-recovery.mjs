import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const composeFile = resolve('infra/docker/docker-compose.yml');
const migrationScript = resolve('packages/database/scripts/migrate.mjs');
const postgresUser = validatedIdentifier(process.env.POSTGRES_USER ?? 'debtshift', 'POSTGRES_USER');
const postgresPassword = process.env.POSTGRES_PASSWORD ?? 'debtshift_local';
const postgresPort = validatedPort(process.env.POSTGRES_PORT ?? '5432');
const drillDatabase = `debtshift_migration_${process.pid}_${randomBytes(4).toString('hex')}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'debtshift-migration-drill-'));
const baselineBackupPath = join(temporaryDirectory, 'before-forward-migration.dump');

let drillDatabaseCreated = false;
try {
  await assertPostgresReady();
  await createDrillDatabase();
  await runCheckedInMigrations();

  const checkedInTables = await listTables();
  if (checkedInTables.length === 0) {
    throw new Error('Checked-in migrations created no public tables in the isolated database.');
  }
  const migrationCount = await queryScalar(
    `SELECT count(*)::text FROM drizzle.__drizzle_migrations`,
  );
  if (!/^[1-9][0-9]*$/.test(migrationCount)) {
    throw new Error('Checked-in migrations did not create a non-empty Drizzle migration history.');
  }

  await executeSql(`
    CREATE TABLE public.debtshift_migration_drill (
      id integer PRIMARY KEY,
      state text NOT NULL
    );
    INSERT INTO public.debtshift_migration_drill (id, state) VALUES (1, 'baseline');
  `);

  const baselineTables = await listTables();
  const baselineCounts = await readTableCounts(baselineTables);
  const baselineMigrationFingerprint = await migrationFingerprint();

  await dumpDatabase(baselineBackupPath);
  const backup = await stat(baselineBackupPath);
  if (backup.size === 0) throw new Error('pg_dump created an empty baseline backup artifact.');

  let expectedFailureObserved = false;
  try {
    await executeSql(`
      BEGIN;
      ALTER TABLE public.debtshift_migration_drill
        ADD COLUMN failed_candidate_marker text;
      SELECT 1 / 0;
      COMMIT;
    `);
  } catch (error) {
    if (!error.message.includes('division by zero')) throw error;
    expectedFailureObserved = true;
  }
  if (!expectedFailureObserved) {
    throw new Error('The intentionally invalid transactional migration unexpectedly succeeded.');
  }
  await assertColumnPresence('failed_candidate_marker', false);
  await assertDrillState('baseline');

  await executeSql(`
    BEGIN;
    ALTER TABLE public.debtshift_migration_drill
      ADD COLUMN forward_candidate_marker text;
    UPDATE public.debtshift_migration_drill
      SET state = 'forward-applied', forward_candidate_marker = 'candidate-v1'
      WHERE id = 1;
    COMMIT;
  `);
  await assertColumnPresence('forward_candidate_marker', true);
  await assertDrillState('forward-applied');

  await dropDrillDatabase();
  await createDrillDatabase();
  await restoreBackup(baselineBackupPath);

  const recoveredTables = await listTables();
  assertSameValues('public table set', baselineTables, recoveredTables);
  assertSameCounts(baselineCounts, await readTableCounts(recoveredTables));
  if ((await migrationFingerprint()) !== baselineMigrationFingerprint) {
    throw new Error('Recovered Drizzle migration history differs from the pre-change baseline.');
  }
  await assertColumnPresence('forward_candidate_marker', false);
  await assertColumnPresence('failed_candidate_marker', false);
  await assertDrillState('baseline');

  await runCheckedInMigrations();
  assertSameValues('idempotently migrated public table set', baselineTables, await listTables());
  assertSameCounts(baselineCounts, await readTableCounts(baselineTables));
  if ((await migrationFingerprint()) !== baselineMigrationFingerprint) {
    throw new Error('Idempotent migration changed the recovered Drizzle migration history.');
  }

  console.log(
    JSON.stringify({
      status: 'DATABASE_MIGRATION_RECOVERY_DRILL_PASSED',
      drillDatabase,
      checkedInMigrationCount: Number(migrationCount),
      verifiedPublicTables: recoveredTables.length,
      verifiedRows: [...baselineCounts.values()]
        .reduce((total, count) => total + count, 0n)
        .toString(),
      backupBytes: backup.size,
      backupSha256: await sha256File(baselineBackupPath),
      failedTransactionRolledBack: true,
      forwardCandidateApplied: true,
      preChangeStateRecovered: true,
      recoveredMigrationsIdempotent: true,
      sourceDatabaseAccessed: false,
    }),
  );
} finally {
  if (drillDatabaseCreated) {
    await dropDrillDatabase().catch((error) => {
      console.error(
        `Failed to remove isolated migration database ${drillDatabase}: ${error.message}`,
      );
      process.exitCode = 1;
    });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function assertPostgresReady() {
  await dockerComposeExec(['pg_isready', '--username', postgresUser, '--dbname', 'postgres']);
}

async function createDrillDatabase() {
  await dockerComposeExec([
    'createdb',
    '--username',
    postgresUser,
    '--template',
    'template0',
    drillDatabase,
  ]);
  drillDatabaseCreated = true;
}

async function dropDrillDatabase() {
  await dockerComposeExec([
    'dropdb',
    '--username',
    postgresUser,
    '--force',
    '--if-exists',
    drillDatabase,
  ]);
  drillDatabaseCreated = false;
}

async function runCheckedInMigrations() {
  const connectionUrl = new URL('postgresql://127.0.0.1');
  connectionUrl.username = postgresUser;
  connectionUrl.password = postgresPassword;
  connectionUrl.port = postgresPort;
  connectionUrl.pathname = `/${drillDatabase}`;

  await spawnCommand(process.execPath, [migrationScript], {
    env: { ...process.env, DATABASE_URL: connectionUrl.toString() },
  });
}

async function dumpDatabase(path) {
  const output = createWriteStream(path, { flags: 'wx' });
  await dockerComposeExec(
    [
      'pg_dump',
      '--username',
      postgresUser,
      '--dbname',
      drillDatabase,
      '--format',
      'custom',
      '--no-owner',
      '--no-privileges',
    ],
    { stdout: output },
  );
}

async function restoreBackup(path) {
  const input = createReadStream(path);
  await dockerComposeExec(
    [
      'pg_restore',
      '--username',
      postgresUser,
      '--dbname',
      drillDatabase,
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
    ],
    { stdin: input },
  );
}

async function executeSql(sql) {
  await dockerComposeExec([
    'psql',
    '--username',
    postgresUser,
    '--dbname',
    drillDatabase,
    '--quiet',
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    sql,
  ]);
}

async function listTables() {
  const output = await queryScalar(
    `SELECT COALESCE(string_agg(tablename, ',' ORDER BY tablename), '') FROM pg_catalog.pg_tables WHERE schemaname = 'public'`,
  );
  if (output.length === 0) return [];
  return output.split(',').map((table) => validatedIdentifier(table, 'database table'));
}

async function readTableCounts(tables) {
  const counts = new Map();
  for (const table of tables) {
    const count = await queryScalar(`SELECT count(*)::text FROM public."${table}"`);
    if (!/^(0|[1-9][0-9]*)$/.test(count)) {
      throw new Error(`Unexpected row count for table ${table}.`);
    }
    counts.set(table, BigInt(count));
  }
  return counts;
}

async function migrationFingerprint() {
  return queryScalar(
    `SELECT COALESCE(string_agg(hash::text, ',' ORDER BY created_at, hash), '') FROM drizzle.__drizzle_migrations`,
  );
}

async function assertColumnPresence(column, expected) {
  const count = await queryScalar(`
    SELECT count(*)::text
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'debtshift_migration_drill'
      AND column_name = '${column}'
  `);
  if ((count === '1') !== expected) {
    throw new Error(
      `Column ${column} presence was ${count === '1' ? 'present' : 'absent'}; expected ${expected ? 'present' : 'absent'}.`,
    );
  }
}

async function assertDrillState(expected) {
  const actual = await queryScalar(
    `SELECT state FROM public.debtshift_migration_drill WHERE id = 1`,
  );
  if (actual !== expected) {
    throw new Error(`Migration drill state is ${actual}; expected ${expected}.`);
  }
}

async function queryScalar(query) {
  return (
    await dockerComposeExec([
      'psql',
      '--username',
      postgresUser,
      '--dbname',
      drillDatabase,
      '--tuples-only',
      '--no-align',
      '--quiet',
      '--command',
      query,
    ])
  ).trim();
}

function assertSameValues(label, expected, actual) {
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    throw new Error(`${label} differs after recovery.`);
  }
}

function assertSameCounts(expected, actual) {
  for (const [table, count] of expected) {
    if (actual.get(table) !== count) {
      throw new Error(
        `Recovered row count for ${table} is ${actual.get(table)?.toString() ?? 'missing'}; expected ${count.toString()}.`,
      );
    }
  }
}

function validatedIdentifier(value, label) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier.`);
  }
  return value;
}

function validatedPort(value) {
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65_535) {
    throw new Error('POSTGRES_PORT must be an integer from 1 through 65535.');
  }
  return value;
}

async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function dockerComposeExec(command, streams = {}) {
  return spawnCommand(
    'docker',
    ['compose', '--file', composeFile, 'exec', '--no-TTY', 'postgres', ...command],
    streams,
  );
}

async function spawnCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    stdio: [
      options.stdin === undefined ? 'ignore' : 'pipe',
      options.stdout === undefined ? 'pipe' : 'pipe',
      'pipe',
    ],
    windowsHide: true,
  });
  if (options.stdin !== undefined) {
    options.stdin.once('error', (error) => child.destroy(error));
    options.stdin.pipe(child.stdin);
  }
  const outputFinished =
    options.stdout === undefined
      ? Promise.resolve()
      : new Promise((resolveFinish, reject) => {
          options.stdout.once('finish', resolveFinish);
          options.stdout.once('error', reject);
        });
  if (options.stdout !== undefined) child.stdout.pipe(options.stdout);
  let stdout = '';
  let stderr = '';
  if (options.stdout === undefined)
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(
      `${command} command failed with exit code ${exitCode}: ${stderr.trim() || args[0]}`,
    );
  }
  await outputFinished;
  return stdout;
}

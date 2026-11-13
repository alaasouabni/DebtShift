import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const composeFile = resolve('infra/docker/docker-compose.yml');
const postgresUser = validatedIdentifier(process.env.POSTGRES_USER ?? 'debtshift', 'POSTGRES_USER');
const sourceDatabase = validatedIdentifier(process.env.POSTGRES_DB ?? 'debtshift', 'POSTGRES_DB');
const restoreDatabase = `debtshift_restore_${process.pid}_${randomBytes(4).toString('hex')}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'debtshift-restore-drill-'));
const backupPath = join(temporaryDirectory, 'debtshift.dump');

let restoreDatabaseCreated = false;
try {
  await assertPostgresReady();
  const sourceTables = await listTables(sourceDatabase);
  if (sourceTables.length === 0) {
    throw new Error(`Source database ${sourceDatabase} has no public tables to restore.`);
  }
  const sourceCounts = await readTableCounts(sourceDatabase, sourceTables);

  await dumpDatabase(backupPath);
  const backup = await stat(backupPath);
  if (backup.size === 0) throw new Error('pg_dump created an empty backup artifact.');

  await dockerComposeExec([
    'createdb',
    '--username',
    postgresUser,
    '--template',
    'template0',
    restoreDatabase,
  ]);
  restoreDatabaseCreated = true;
  await restoreBackup(backupPath);

  const restoredTables = await listTables(restoreDatabase);
  assertSameValues('public table set', sourceTables, restoredTables);
  const restoredCounts = await readTableCounts(restoreDatabase, restoredTables);
  assertSameCounts(sourceCounts, restoredCounts);

  const migrationFingerprint = await queryScalar(
    restoreDatabase,
    `SELECT COALESCE(string_agg(hash::text, ',' ORDER BY created_at, hash), '') FROM drizzle.__drizzle_migrations`,
  );
  const sourceMigrationFingerprint = await queryScalar(
    sourceDatabase,
    `SELECT COALESCE(string_agg(hash::text, ',' ORDER BY created_at, hash), '') FROM drizzle.__drizzle_migrations`,
  );
  if (migrationFingerprint !== sourceMigrationFingerprint) {
    throw new Error('Restored migration history does not match the source database.');
  }

  console.log(
    JSON.stringify({
      status: 'DATABASE_RESTORE_DRILL_PASSED',
      sourceDatabase,
      restoreDatabase,
      backupBytes: backup.size,
      backupSha256: await sha256File(backupPath),
      verifiedPublicTables: restoredTables.length,
      verifiedRows: [...restoredCounts.values()]
        .reduce((total, count) => total + count, 0n)
        .toString(),
      sourceDatabaseMutated: false,
    }),
  );
} finally {
  if (restoreDatabaseCreated) {
    await dockerComposeExec([
      'dropdb',
      '--username',
      postgresUser,
      '--force',
      '--if-exists',
      restoreDatabase,
    ]).catch((error) => {
      console.error(
        `Failed to remove isolated restore database ${restoreDatabase}: ${error.message}`,
      );
      process.exitCode = 1;
    });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function assertPostgresReady() {
  await dockerComposeExec(['pg_isready', '--username', postgresUser, '--dbname', sourceDatabase]);
}

async function dumpDatabase(path) {
  const output = createWriteStream(path, { flags: 'wx' });
  await dockerComposeExec(
    [
      'pg_dump',
      '--username',
      postgresUser,
      '--dbname',
      sourceDatabase,
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
      restoreDatabase,
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
    ],
    { stdin: input },
  );
}

async function listTables(database) {
  const output = await queryScalar(
    database,
    `SELECT COALESCE(string_agg(tablename, ',' ORDER BY tablename), '') FROM pg_catalog.pg_tables WHERE schemaname = 'public'`,
  );
  if (output.length === 0) return [];
  return output.split(',').map((table) => validatedIdentifier(table, 'database table'));
}

async function readTableCounts(database, tables) {
  const counts = new Map();
  for (const table of tables) {
    const count = await queryScalar(database, `SELECT count(*)::text FROM public."${table}"`);
    if (!/^(0|[1-9][0-9]*)$/.test(count)) {
      throw new Error(`Unexpected row count for table ${table}.`);
    }
    counts.set(table, BigInt(count));
  }
  return counts;
}

async function queryScalar(database, query) {
  return (
    await dockerComposeExec([
      'psql',
      '--username',
      postgresUser,
      '--dbname',
      database,
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
    throw new Error(`${label} differs after restore.`);
  }
}

function assertSameCounts(expected, actual) {
  for (const [table, count] of expected) {
    if (actual.get(table) !== count) {
      throw new Error(
        `Restored row count for ${table} is ${actual.get(table)?.toString() ?? 'missing'}; expected ${count.toString()}.`,
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

async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function dockerComposeExec(command, streams = {}) {
  const child = spawn(
    'docker',
    ['compose', '--file', composeFile, 'exec', '--no-TTY', 'postgres', ...command],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: [
        streams.stdin === undefined ? 'ignore' : 'pipe',
        streams.stdout === undefined ? 'pipe' : 'pipe',
        'pipe',
      ],
      windowsHide: true,
    },
  );
  if (streams.stdin !== undefined) {
    streams.stdin.once('error', (error) => child.destroy(error));
    streams.stdin.pipe(child.stdin);
  }
  const outputFinished =
    streams.stdout === undefined
      ? Promise.resolve()
      : new Promise((resolveFinish, reject) => {
          streams.stdout.once('finish', resolveFinish);
          streams.stdout.once('error', reject);
        });
  if (streams.stdout !== undefined) child.stdout.pipe(streams.stdout);
  let stdout = '';
  let stderr = '';
  if (streams.stdout === undefined)
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(
      `docker compose postgres command failed with exit code ${exitCode}: ${stderr.trim() || command[0]}`,
    );
  }
  await outputFinished;
  return stdout;
}

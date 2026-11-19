/**
 * Project-local PostgreSQL for development, using the PostgreSQL binaries already installed.
 * No admin rights and no system postgres password needed: it creates a separate cluster in ./.pgdata
 * (git-ignored), owned by the current user, listening on 127.0.0.1:5433 with a generated password.
 *
 *   npm run db:local:init     create the cluster + svs_dev database, write DATABASE_URL into .env, start it
 *   npm run db:local:start    start it (e.g. after a reboot)
 *   npm run db:local:stop     stop it
 *   npm run db:local:status   show whether it is running
 *
 * Env overrides: PG_BIN (folder with pg_ctl/initdb), LOCAL_PG_PORT (default 5433).
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = join(root, '.pgdata');
const logFile = join(dataDir, 'server.log');
const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const dbUser = 'svs';
const dbName = 'svs_dev';
const testDbName = 'svs_test';
const isWin = process.platform === 'win32';
const pgBin = process.env.PG_BIN ?? (isWin ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '');
const bin = (name: string) => (pgBin ? join(pgBin, isWin ? `${name}.exe` : name) : name);

function run(name: string, args: string[], opts: SpawnSyncOptions = {}) {
  const res = spawnSync(bin(name), args, { encoding: 'utf8', ...opts });
  if (res.error) throw new Error(`${name} failed to start: ${res.error.message}. Set PG_BIN to your PostgreSQL bin folder.`);
  return res;
}

const initialised = () => existsSync(join(dataDir, 'PG_VERSION'));

function isRunning(): boolean {
  return run('pg_ctl', ['-D', dataDir, 'status'], { stdio: 'ignore' }).status === 0;
}

function start() {
  if (!initialised()) throw new Error('No local cluster yet. Run: npm run db:local:init');
  if (isRunning()) {
    console.log(`✔ Local PostgreSQL already running on 127.0.0.1:${port}`);
    return;
  }
  // stdio 'ignore': the server process outlives pg_ctl and must not hold this process's pipes open.
  const res = run(
    'pg_ctl',
    ['-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', '-t', '30', 'start'],
    { stdio: 'ignore' },
  );
  if (res.status !== 0 || !isRunning()) throw new Error(`Server did not start. See ${logFile}`);
  console.log(`✔ Local PostgreSQL running on 127.0.0.1:${port} (data: .pgdata, log: .pgdata/server.log)`);
}

function stop() {
  if (!initialised() || !isRunning()) {
    console.log('Local PostgreSQL is not running.');
    return;
  }
  run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  console.log('✔ Local PostgreSQL stopped.');
}

const envPath = join(root, '.env');

function writeEnvVar(name: string, value: string) {
  if (!existsSync(envPath)) copyFileSync(join(root, '.env.example'), envPath);
  const current = readFileSync(envPath, 'utf8');
  const re = new RegExp(`^#?\\s*${name}=.*$`, 'm');
  const line = `${name}=${value}`;
  writeFileSync(envPath, re.test(current) ? current.replace(re, line) : `${current.trimEnd()}\n${line}\n`);
}

function readEnvVar(name: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  return new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(envPath, 'utf8'))?.[1]?.trim() || undefined;
}

/** Creates the svs_test database (used by the integration tests) and records TEST_DATABASE_URL in .env. */
function ensureTestDatabase() {
  const url = readEnvVar('DATABASE_URL');
  const password = url ? new URL(url).password : undefined;
  if (!password) {
    console.log('ⓘ DATABASE_URL not found in .env; skipping test database.');
    return;
  }
  const res = run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', dbUser, testDbName], {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(password) },
  });
  if (res.status !== 0 && !/already exists/.test(String(res.stderr ?? ''))) throw new Error(`createdb ${testDbName} failed:\n${res.stderr}`);
  if (res.status === 0) console.log(`✔ Created database "${testDbName}"`);
  writeEnvVar('TEST_DATABASE_URL', `postgres://${dbUser}:${password}@127.0.0.1:${port}/${testDbName}`);
}

function init() {
  if (initialised()) {
    console.log('Local cluster already exists in .pgdata. Starting it…');
    start();
    ensureTestDatabase();
    return;
  }
  const password = randomBytes(18).toString('base64url');
  const pwFile = join(tmpdir(), `svs-pg-${process.pid}.pw`);
  writeFileSync(pwFile, password, { mode: 0o600 });
  try {
    const res = run('initdb', ['-D', dataDir, '-U', dbUser, `--pwfile=${pwFile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-locale']);
    if (res.status !== 0) throw new Error(`initdb failed:\n${res.stderr || res.stdout}`);
  } finally {
    rmSync(pwFile, { force: true });
  }
  console.log('✔ Created local cluster in .pgdata');
  start();
  const created = run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', dbUser, dbName], {
    env: { ...process.env, PGPASSWORD: password },
  });
  if (created.status !== 0) throw new Error(`createdb failed:\n${created.stderr}`);
  console.log(`✔ Created database "${dbName}"`);
  writeEnvVar('DATABASE_URL', `postgres://${dbUser}:${password}@127.0.0.1:${port}/${dbName}`);
  console.log('✔ Wrote DATABASE_URL to .env (the password is only stored there)');
  ensureTestDatabase();
}

const command = process.argv[2];
try {
  if (command === 'init') init();
  else if (command === 'start') start();
  else if (command === 'stop') stop();
  else if (command === 'status') {
    if (!initialised()) console.log('No local cluster (run npm run db:local:init).');
    else console.log(isRunning() ? `✔ Running on 127.0.0.1:${port}` : '✖ Not running (npm run db:local:start)');
  } else {
    console.error('Usage: tsx scripts/local-db.ts <init|start|stop|status>');
    process.exit(1);
  }
} catch (err) {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

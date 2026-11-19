/** npm run db:migrate: applies pending migrations to DATABASE_URL (or the URL given as the first argument). */
import { createDb } from './db';
import { loadEnv } from './env';
import { runMigrations } from './migrate';

const url = process.argv[2] ?? loadEnv().DATABASE_URL;
const db = createDb(url);
if (!db) {
  console.error('✖ DATABASE_URL is not set.');
  process.exit(1);
}
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `✔ Applied: ${applied.join(', ')}` : '✔ Database is up to date.');
} catch (err) {
  console.error(`✖ Migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}

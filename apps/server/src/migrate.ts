import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './db';

/** apps/server/migrations (same relative path from src/ and from the bundled dist/). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending *.sql migrations in filename order, each in its own transaction.
 * Applied versions are recorded in schema_migrations. Returns the versions applied by this call.
 */
export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => r.version));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    await db.tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    });
    applied.push(version);
  }
  return applied;
}

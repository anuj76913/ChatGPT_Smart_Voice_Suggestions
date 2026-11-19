import pg from 'pg';

/**
 * The analytics scripts default to a separate `svs_analytics` database next to DATABASE_URL, so synthetic data never
 * lands in the dev database. `--database-url` (or ANALYTICS_DATABASE_URL) overrides it.
 */
export async function analyticsDatabaseUrl(explicit: string | undefined, opts: { create: boolean }): Promise<string> {
  if (explicit) return explicit;
  if (process.env.ANALYTICS_DATABASE_URL) return process.env.ANALYTICS_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('Set DATABASE_URL (npm run db:local:init) or pass --database-url');
  const url = new URL(base);
  url.pathname = '/svs_analytics';
  if (opts.create) {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['svs_analytics']);
      if (!exists.rowCount) await admin.query('CREATE DATABASE svs_analytics');
    } finally {
      await admin.end();
    }
  }
  return url.toString();
}

/** host/db for logs, never the password. */
export const describeUrl = (url: string) => {
  const u = new URL(url);
  return `${u.host}${u.pathname}`;
};

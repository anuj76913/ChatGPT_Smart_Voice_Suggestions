/**
 * Checks the PostgreSQL connection in DATABASE_URL.
 *   npm run db:check
 */
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

loadDotenv({ quiet: true });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('✖ DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ db: string; version: string }>(
      'SELECT current_database() AS db, version() AS version',
    );
    console.log(`✔ Connected to database "${rows[0]?.db}"`);
    console.log(`  ${rows[0]?.version}`);
  } catch (err) {
    console.error(`✖ Could not connect: ${err instanceof Error ? err.message : String(err)}`);
    console.error('  If the database does not exist yet, create it with: createdb -U postgres svs_dev');
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

void main();

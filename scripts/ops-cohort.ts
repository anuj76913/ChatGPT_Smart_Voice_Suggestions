/**
 * P8.1 enrol dogfood participants (India staff + student beta panel) in a cohort, straight in the database.
 *   npm run ops:cohort -- add --cohort dogfood <handle> [<handle> …]
 *   npm run ops:cohort -- remove <handle> [<handle> …]        (cohort back to none)
 *   npm run ops:cohort -- list [--cohort dogfood]
 * Users must have signed in once (dev login creates them). Cards for a cohort also need it in config
 * `dogfoodCohorts` (npm run ops:config -- preset dogfood-baseline).
 * Options: --database-url <url> (default DATABASE_URL).
 */
import { config as loadDotenv } from 'dotenv';
import { createDb } from '../apps/server/src/db';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [cmd, ...handles] = positional;
const url = flag('database-url') ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL or pass --database-url');
const db = createDb(url)!;
try {
  if (cmd === 'add' || cmd === 'remove') {
    const cohort = cmd === 'add' ? flag('cohort') : null;
    if (cmd === 'add' && !/^[a-z0-9_-]{1,32}$/.test(cohort ?? '')) throw new Error('--cohort <name> (a-z, 0-9, _ or -) is required');
    if (!handles.length) throw new Error('give one or more user handles');
    const lower = handles.map((h) => h.toLowerCase());
    const r = await db.query<{ handle: string }>('UPDATE users SET cohort = $2 WHERE handle = ANY($1) RETURNING handle', [lower, cohort]);
    const done = new Set(r.rows.map((x) => x.handle));
    console.log(`✔ ${cmd === 'add' ? `Added to "${cohort}"` : 'Removed from their cohort'}: ${[...done].join(', ') || 'nobody'}`);
    const missing = lower.filter((h) => !done.has(h));
    if (missing.length) console.log(`  Not found (they need to sign in once first): ${missing.join(', ')}`);
  } else if (cmd === 'list') {
    const cohort = flag('cohort');
    const { rows } = await db.query<{ cohort: string | null; n: number; consent: string }>(
      `SELECT cohort, count(*)::int AS n,
              count(*) FILTER (WHERE research_consent = 'granted')::int || ' granted / ' || count(*) FILTER (WHERE research_consent = 'declined')::int || ' declined' AS consent
         FROM users WHERE ($1::text IS NULL OR cohort = $1) GROUP BY 1 ORDER BY 2 DESC`,
      [cohort ?? null],
    );
    for (const r of rows) console.log(`${(r.cohort ?? '(none)').padEnd(16)} ${String(r.n).padStart(6)} users · research consent ${r.consent}`);
  } else {
    console.log('Commands: add --cohort <name> <handles…> | remove <handles…> | list [--cohort <name>]');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`✖ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}

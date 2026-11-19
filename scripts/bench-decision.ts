/**
 * P7.1: suggestion decision pre-checks must stay at p95 ≤ 20 ms (architecture §13.1).
 * Times SuggestionEngine.decide() with no classifier, so it covers exactly the pre-checks:
 * gate (config, kill switch, rollout) → prefs → conversation cap → organic-voice check → weekly cap → arm assignment.
 *
 *   npm run bench:decision -- [--n 2000] [--concurrency 1,10,25] [--database-url …]
 *
 * Runs against the synthetic analytics database (npm run analytics:seed), whose users already have realistic
 * suggestion / session history, so the cap queries do real work.
 */
import { config as loadDotenv } from 'dotenv';
import { mergeConfig } from '@svs/shared';
import type { AuthUser } from '../apps/server/src/auth';
import { percentile } from '../apps/server/src/analytics/stats';
import { ConfigService } from '../apps/server/src/config/service';
import { createDb } from '../apps/server/src/db';
import { SuggestionEngine } from '../apps/server/src/suggestions/engine';
import { analyticsDatabaseUrl, describeUrl } from './analytics/target';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const N = Number(opt('n', '2000'));
const levels = opt('concurrency', '1,10,25').split(',').map(Number);

const url = await analyticsDatabaseUrl(opt('database-url', '') || undefined, { create: false });
const db = createDb(url)!;
const config = new ConfigService(db, { reloadMs: 60000 });
await config.load();
const cfg = mergeConfig(config.get(), { enabled: true, rolloutPercent: 100 });
config.get = () => cfg;
config.isFresh = () => true;
const engine = new SuggestionEngine(db, null, config);

const { rows } = await db.query<{ user_id: string; conversation_id: string; message_id: string }>(
  `SELECT s.user_id, s.conversation_id, s.message_id FROM suggestions s JOIN users u ON u.id = s.user_id WHERE u.cohort = 'synthetic' ORDER BY s.evaluated_at DESC LIMIT 500`,
);
if (!rows.length) throw new Error('No synthetic data: run `npm run analytics:seed` first.');
const user = (id: string): AuthUser => ({ id, handle: 'bench', display_name: 'bench', region: 'IN', tier: null, primary_language: null, cohort: 'synthetic', timezone: 'Asia/Kolkata', research_consent: null, is_admin: false });

console.log(`Decision pre-checks against ${describeUrl(url)} (${rows.length} real user/conversation pairs), ${N} decisions per level\n`);
console.log('| Concurrency | p50 ms | p95 ms | p99 ms | max ms | Budget (p95 ≤ 20 ms) |');
console.log('|---|---|---|---|---|---|');
// Fresh conversation ids: each decision runs every pre-check (the conversation cap passes) through to the arm.
// Warm the pool and caches.
for (let i = 0; i < 50; i++) {
  const r = rows[i % rows.length]!;
  await engine.decide({ user: user(r.user_id), conversationId: crypto.randomUUID(), messageId: r.message_id, query: 'x', recentTurns: [] });
}
let worst = 0;
for (const c of levels) {
  const times: number[] = [];
  let next = 0;
  const reasons = new Map<string, number>();
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (next < N) {
        const r = rows[next++ % rows.length]!;
        const t0 = performance.now();
        const d = await engine.decide({ user: user(r.user_id), conversationId: crypto.randomUUID(), messageId: r.message_id, query: 'x', recentTurns: [] });
        times.push(performance.now() - t0);
        const reason = d.eligible ? 'eligible' : d.reason;
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }),
  );
  const p95 = percentile(times, 0.95)!;
  worst = Math.max(worst, p95);
  console.log(`| ${c} | ${percentile(times, 0.5)!.toFixed(1)} | ${p95.toFixed(1)} | ${percentile(times, 0.99)!.toFixed(1)} | ${Math.max(...times).toFixed(1)} | ${p95 <= 20 ? '✅' : '❌'} |`);
  if (c === levels[0]) console.error(`  outcomes: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
await db.close();
process.exit(worst <= 20 ? 0 : 1);

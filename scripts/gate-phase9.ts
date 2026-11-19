/**
 * Phase 8 → 9 gate (implementation-plan "Gate to Phase 9", from the PRD). Checks what it can automatically and reads
 * human sign-offs from docs/phase8/gate-attestations.json.
 *
 *   npm run gate:phase9 -- [--database-url …] [--baseline-experiment svs_baseline]
 *
 * Automatic: classifier precision ≥ 85% on the extended eval set (seed + labelled dogfood queries), ≥ 1,000
 * human-reviewed rows including dogfood ones, ≥ 14 days of baseline data with no cards shown to the baseline, and the
 * baseline report exists. Manual: Legal / T&S, Groq terms, retention, Groq capacity, auth, open P0 bugs, frozen plan.
 * Exits non-zero until everything passes.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { createDb } from '../apps/server/src/db';
import { loadAllRows } from './eval/shared';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const baselineExp = flag('baseline-experiment') ?? 'svs_baseline';
type Status = 'PASS' | 'FAIL' | 'PENDING';
const rows: Array<{ check: string; status: Status; detail: string }> = [];
const add = (check: string, status: Status, detail: string) => rows.push({ check, status, detail });

// 1. Classifier precision on the extended set.
try {
  const out = execSync('npm run -s eval:check', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  add('Classifier precision ≥ 85% (eval gate)', /eval gate passed/i.test(out) ? 'PASS' : 'FAIL', out.trim().split('\n').slice(-2).join(' '));
} catch (err) {
  add('Classifier precision ≥ 85% (eval gate)', 'FAIL', String((err as { stdout?: string }).stdout ?? err).trim().split('\n').slice(-2).join(' '));
}
const all = loadAllRows();
const reviewedMain = all.filter((r) => r.reviewed && r.set === 'main').length;
const dogfoodRows = all.filter((r) => r.source === 'dogfood').length;
add('≥ 1,000 human-reviewed main-set rows', reviewedMain >= 1000 ? 'PASS' : 'FAIL', `${reviewedMain} reviewed (${dogfoodRows} from dogfood)`);
add('Eval set extended with real dogfood queries (P8.2)', dogfoodRows > 0 ? 'PASS' : 'FAIL', `${dogfoodRows} dogfood rows`);

// 2. Baselines recorded.
const url = flag('database-url') ?? process.env.DATABASE_URL;
if (url) {
  const db = createDb(url)!;
  try {
    const r = (
      await db.query<{ first: Date | null; last: Date | null; users: number; shown: number }>(
        `SELECT min(ts) AS first, max(ts) AS last, count(DISTINCT user_id)::int AS users,
                (SELECT count(*)::int FROM events WHERE event = 'suggestion_shown' AND experiment_id = $1) AS shown
           FROM events WHERE event = 'suggestion_eligible' AND experiment_id = $1`,
        [baselineExp],
      )
    ).rows[0]!;
    const days = r.first && r.last ? (new Date(r.last).getTime() - new Date(r.first).getTime()) / 86_400_000 : 0;
    add('Baseline pre-period ≥ 14 days', days >= 14 ? 'PASS' : 'FAIL', `${days.toFixed(1)} days of \`${baselineExp}\` eligibility, ${r.users} eligible users`);
    add('Baseline clean (no cards shown in it)', r.users === 0 ? 'PENDING' : r.shown === 0 ? 'PASS' : 'FAIL', `${r.shown} suggestion_shown events in the baseline experiment`);
  } finally {
    await db.close();
  }
} else add('Baseline pre-period ≥ 14 days', 'PENDING', 'no DATABASE_URL / --database-url');
add('Baseline report written', existsSync('docs/phase8/baseline-report.md') ? 'PASS' : 'FAIL', 'npm run analytics:baseline -- --out docs/phase8/baseline-report.md');

// 3. Human sign-offs.
type Att = { approved_by?: string | null; checked_by?: string | null; date?: string | null; open?: number | null };
const att = JSON.parse(readFileSync('docs/phase8/gate-attestations.json', 'utf8')) as Record<string, Att>;
const signed = (k: string, label: string) => {
  const a = att[k];
  add(label, a?.approved_by && a.date ? 'PASS' : 'PENDING', a?.approved_by ? `${a.approved_by} on ${a.date}` : 'not signed off');
};
signed('legal_privacy_copy', 'Privacy copy approved by Legal and T&S');
signed('groq_data_terms', 'Groq data terms approved');
signed('transcript_retention', 'Transcript retention matches the Voice Mode policy');
signed('groq_capacity', 'Groq capacity confirmed for the A/B (BB-05)');
signed('auth_or_private_network', 'Real sign-in or private network (BB-13)');
signed('analysis_plan_frozen', 'Analysis plan frozen (P8.5)');
const p0 = att.p0_bugs;
add('No open P0 bugs', p0?.open === 0 && p0.checked_by ? 'PASS' : p0?.open ? 'FAIL' : 'PENDING', p0?.checked_by ? `${p0.open} open, checked by ${p0.checked_by} on ${p0.date}` : 'not checked');

const icon: Record<Status, string> = { PASS: '✅', FAIL: '❌', PENDING: '⏳' };
console.log('| Gate check | Status | Detail |\n|---|---|---|');
for (const r of rows) console.log(`| ${r.check} | ${icon[r.status]} ${r.status} | ${r.detail} |`);
const ok = rows.every((r) => r.status === 'PASS');
console.log(`\n${ok ? '✔ Gate passed: Phase 9 may start.' : `✖ Gate not passed (${rows.filter((r) => r.status !== 'PASS').length} open).`}`);
process.exit(ok ? 0 : 1);

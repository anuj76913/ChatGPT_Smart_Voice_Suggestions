/**
 * P6.7 experiment analysis ("notebook" as a reproducible script): computes every PRD metric for a window, checks the
 * split (SRM), applies the PRD decision rules (Ship / Iterate / Kill) and writes a markdown report.
 *
 *   npm run analytics:report -- [--days 28 | --from ISO --to ISO] [--experiment svs_v1|all] [--include-test]
 *                               [--database-url …] [--out docs/phase6/analysis-synthetic.md] [--json]
 *
 * Default database: svs_analytics (see target.ts). Runtime config overrides in that database are applied.
 */
import { writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import type { MetricsReport } from '@svs/shared';
import { decideExperiment, type DecisionResult } from '../../apps/server/src/analytics/decision';
import { buildReport } from '../../apps/server/src/analytics/report';
import { ConfigService } from '../../apps/server/src/config/service';
import { createDb } from '../../apps/server/src/db';
import { analyticsDatabaseUrl, describeUrl } from './target';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);
const pp = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)} pp`);
const pv = (v: number | null) => (v === null ? '—' : v < 0.0001 ? '<0.0001' : v.toFixed(4));
const usd = (v: number | null) => (v === null ? '—' : `$${v.toFixed(v < 0.01 ? 5 : 3)}`);

export function toMarkdown(r: MetricsReport, d: DecisionResult | null, source: string): string {
  const m = r.metrics;
  const L: string[] = [];
  L.push(`# Experiment analysis: ${r.window.experiment_id ?? 'all traffic'}`, '');
  L.push(`> Generated ${r.generated_at} by \`npm run analytics:report\` · metrics ${r.version} · data: ${source}`);
  L.push(`> Window ${r.window.from} → ${r.window.to}${r.window.include_test ? ' · test users included' : ''}`, '');
  if (d) {
    L.push(`## Decision: **${d.decision.toUpperCase()}**`, '');
    for (const x of d.reasons) L.push(`- ${x}`);
    L.push('', '| Check | Result | Detail |', '|---|---|---|');
    for (const c of d.checks) L.push(`| ${c.name} | ${c.pass === null ? '– no data' : c.pass ? '✅ pass' : '❌ fail'} | ${c.detail} |`);
    L.push('');
  }
  L.push('## Metrics by arm', '', '| Metric | Control | Treatment | Difference | p |', '|---|---|---|---|---|');
  const row = (name: string, c: typeof m.eligible_start_rate) =>
    L.push(`| ${name} | ${pct(c.control.rate)} (${c.control.num}/${c.control.den}) | ${pct(c.treatment.rate)} (${c.treatment.num}/${c.treatment.den}) | ${pp(c.diff)} | ${pv(c.p_value)} |`);
  row('Eligible-user voice start rate (primary)', m.eligible_start_rate);
  row('D7 voice retention (primary)', m.d7_voice_retention);
  row('D30 retention (proxy)', m.d30_retention);
  L.push(`| Thumbs-down (control-eligible → with card) | ${pct(m.thumbs_down.control_eligible.rate)} (${m.thumbs_down.control_eligible.den}) | ${pct(m.thumbs_down.with_card.rate)} (${m.thumbs_down.with_card.den}) | ${pp(m.thumbs_down.diff)} | ${pv(m.thumbs_down.p_value)} |`);
  const spw = m.sessions_per_user_week;
  L.push(`| Sessions per user per week | ${spw.control.value?.toFixed(2) ?? '—'} | ${spw.treatment.value?.toFixed(2) ?? '—'} | | |`);
  L.push('');
  L.push('## Treatment-only and overall', '');
  L.push(`- **Card-level start rate:** ${pct(m.card_start_rate.rate)} (${m.card_start_rate.num}/${m.card_start_rate.den}; PRD target ≥ 15%)`);
  for (const b of m.card_start_rate.by_intent) L.push(`  - ${b.intent}: ${pct(b.rate)} (${b.num}/${b.den})`);
  L.push(`- **Card tap rate:** ${pct(m.tap_rate.rate)} (${m.tap_rate.num}/${m.tap_rate.den})`);
  L.push(`- **Opt-out rate:** ${pct(m.opt_out_rate.rate)} (${m.opt_out_rate.num}/${m.opt_out_rate.den}; guardrail ≤ 5%)`);
  L.push(`- **Cost:** SVS ${usd(m.cost.svs_usd)} (chat ${usd(m.cost.chat_usd)}) over ${m.cost.wavl_learner_weeks} WAVL learner-weeks = **${usd(m.cost.per_wavl_usd)} per WAVL** (budget ${m.cost.budget_per_wavl_usd === null ? 'not set' : usd(m.cost.budget_per_wavl_usd)})`);
  L.push(`  - by use case: ${Object.entries(m.cost.by_use_case).map(([k, v]) => `${k} ${usd(v)}`).join(' · ')}`);
  L.push('', '### WAVL by ISO week', '', '| Week | Control | Treatment | Not in experiment |', '|---|---|---|---|');
  const weeks = [...new Set(m.wavl.map((w) => w.week))];
  for (const wk of weeks) {
    const g = (a: string) => m.wavl.find((w) => w.week === wk && w.arm === a)?.learners ?? 0;
    L.push(`| ${wk} | ${g('control')} | ${g('treatment')} | ${g('none')} |`);
  }
  L.push('', '## Funnel (treatment, unit = eligible suggestion)', '', '| Step | Count | % of previous |', '|---|---|---|');
  const steps = r.funnel.filter((f) => f.arm === 'treatment');
  const sum = (k: keyof (typeof steps)[number]['steps']) => steps.reduce((s, f) => s + f.steps[k], 0);
  const order = ['eligible', 'shown', 'tapped', 'permission_ok', 'started', 'completed_30s', 'returned_d7'] as const;
  order.forEach((k, i) => L.push(`| ${k} | ${sum(k)} | ${i ? pct(sum(order[i - 1]!) ? sum(k) / sum(order[i - 1]!) : null) : ''} |`));
  if (r.experiment) {
    const e = r.experiment;
    L.push('', '## Experiment health', '', '| Count | Control | Treatment | SRM p | Mismatch |', '|---|---|---|---|---|');
    for (const [name, s] of [
      ['Assignments', e.assignments],
      ['Eligible users', e.eligible_users],
      ['Eligible events', e.eligible_events],
    ] as const)
      L.push(`| ${name} | ${s.control} | ${s.treatment} | ${pv(s.p_value)} | ${s.mismatch ? '❌ yes' : 'no'} |`);
  }
  L.push('', '## Groq health', '', `Voice start p50 ${r.health.voice_start.p50_ms?.toFixed(0) ?? '—'} ms · p95 ${r.health.voice_start.p95_ms?.toFixed(0) ?? '—'} ms (n=${r.health.voice_start.n})`, '');
  L.push('| Use case | Calls | Errors | 429 | Fallback | p95 ms | TTFT p95 ms |', '|---|---|---|---|---|---|---|');
  for (const u of r.health.use_cases) L.push(`| ${u.use_case} | ${u.calls} | ${pct(u.error_rate)} | ${pct(u.rate_limited_rate)} | ${pct(u.fallback_rate)} | ${u.p95_ms?.toFixed(0) ?? '—'} | ${u.ttft_p95_ms?.toFixed(0) ?? '—'} |`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const url = await analyticsDatabaseUrl(opt('database-url'), { create: false });
  const db = createDb(url)!;
  try {
    const config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    const cfg = config.get();
    const to = opt('to') ? new Date(opt('to')!) : new Date();
    const from = opt('from') ? new Date(opt('from')!) : new Date(to.getTime() - Number(opt('days') ?? 28) * 86_400_000);
    const exp = opt('experiment') ?? cfg.experiment.id;
    const report = await buildReport(db, { from, to, experimentId: exp === 'all' ? null : exp, includeTest: args.includes('--include-test') }, cfg);
    const decision = report.experiment ? decideExperiment(report, cfg) : null;
    if (args.includes('--json')) {
      console.log(JSON.stringify({ report, decision }, null, 2));
      return;
    }
    const md = toMarkdown(report, decision, describeUrl(url));
    const out = opt('out');
    if (out) {
      writeFileSync(out, md);
      console.log(`✔ Wrote ${out}`);
    }
    console.log(md);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

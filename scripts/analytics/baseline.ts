/**
 * P8.4 baseline pre-period report (instrumentation on, suggestions off) and the sizing it implies for the A/B test.
 *
 *   npm run analytics:baseline -- [--days 14] [--experiment svs_baseline] [--rollout 0.10] [--weeks 4]
 *                                 [--database-url …] [--out docs/phase8/baseline-report.md]
 *
 * During the pre-period everyone in the rollout sits in the baseline "experiment" (treatment share 0): the classifier
 * runs and logs eligibility, nobody sees a card, and voice is only reachable from the mic button. So the control-arm
 * numbers ARE the baselines. The report gives:
 *   - baseline eligible-user voice start rate, D7 voice retention, WAVL per week, sessions per user per week,
 *     thumbs-down rate on eligible answers, and new eligible users per week
 *   - the PRD targets expressed against those baselines (so they can be confirmed or adjusted, P8.4)
 *   - power for the planned A/B (rollout × 50/50 × weeks): is a +2 pp start-rate lift and a +5 pp D7 lift detectable,
 *     and what rollout would be needed (P6.6 / P8.5)
 */
import { writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { buildReport } from '../../apps/server/src/analytics/report';
import { powerFor, sampleSizePerArm } from '../../apps/server/src/analytics/stats';
import { ConfigService } from '../../apps/server/src/config/service';
import { createDb } from '../../apps/server/src/db';
import { analyticsDatabaseUrl, describeUrl } from './target';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = Number(flag('days') ?? '14');
const experiment = flag('experiment') ?? 'svs_baseline';
const rollout = Number(flag('rollout') ?? '0.10');
const weeks = Number(flag('weeks') ?? '4');
const START_MDE = 0.02;
const D7_MDE = 0.05;

const url = flag('database-url') ?? process.env.DATABASE_URL ?? (await analyticsDatabaseUrl(undefined, { create: false }));
const db = createDb(url)!;
try {
  const config = new ConfigService(db, { reloadMs: 60000 });
  await config.load();
  const cfg = config.get();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const r = await buildReport(db, { from, to, experimentId: experiment, includeTest: false }, cfg);
  const m = r.metrics;
  const perWeek = (n: number) => (n * 7) / days;

  // Baselines: everyone is control during the pre-period.
  const eligible = m.eligible_start_rate.control.den;
  const startRate = m.eligible_start_rate.control.rate;
  const d7 = m.d7_voice_retention.control;
  const wavlControl = m.wavl.filter((w) => w.arm === 'control');
  const wavlPerWeek = wavlControl.length ? wavlControl.reduce((s, w) => s + w.learners, 0) / new Set(wavlControl.map((w) => w.week)).size : 0;
  const thumbs = m.thumbs_down.control_eligible;
  const eligiblePerWeek = perWeek(eligible); // pre-period rollout share is in config (rolloutPercent)
  const preRollout = cfg.experiment.id === experiment ? cfg.rolloutPercent / 100 : 1;
  const eligiblePerWeekAt100 = preRollout > 0 ? eligiblePerWeek / preRollout : eligiblePerWeek;
  const firstVoicePerWeekAt100 = preRollout > 0 ? perWeek(d7.den) / preRollout : perWeek(d7.den);

  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);
  const L: string[] = [];
  L.push('# Baseline Pre-period Report (P8.4)', '');
  L.push(`> Generated ${r.generated_at} by \`npm run analytics:baseline\` · metrics ${r.version} · data: ${describeUrl(url)} · experiment \`${experiment}\` (treatment share 0: no cards)`);
  L.push(`> Window ${r.window.from.slice(0, 10)} → ${r.window.to.slice(0, 10)} (${days} days). Pre-period rollout: ${(preRollout * 100).toFixed(0)}% of the target population.`, '');
  if (r.experiment && r.experiment.assignments.treatment > 0) L.push(`⚠ ${r.experiment.assignments.treatment} users are in treatment: this window is not a clean baseline.`, '');
  if (days < 14) L.push(`⚠ The PRD asks for a 2-week pre-period; this window is ${days} days.`, '');

  L.push('## Baselines', '', '| Metric | Baseline | Sample |', '|---|---|---|');
  L.push(`| Eligible-user voice start rate (voice from the mic button, no cards) | ${pct(startRate)} | ${m.eligible_start_rate.control.num}/${eligible} eligible users |`);
  L.push(`| D7 voice retention (first-time voice users) | ${pct(d7.rate)} | ${d7.num}/${d7.den} |`);
  L.push(`| WAVL per week | ${wavlPerWeek.toFixed(1)} | ${wavlControl.length} weeks |`);
  L.push(`| Sessions per user per week | ${m.sessions_per_user_week.control.value?.toFixed(2) ?? '—'} | ${m.sessions_per_user_week.control.sessions} sessions |`);
  L.push(`| Thumbs-down rate on eligible answers | ${pct(thumbs.rate)} | ${thumbs.num}/${thumbs.den} votes |`);
  L.push(`| New eligible users per week (at 100% rollout) | ${Math.round(eligiblePerWeekAt100).toLocaleString('en-US')} | |`);
  L.push(`| New first-time voice users per week (at 100%, no cards) | ${firstVoicePerWeekAt100.toFixed(1)} | |`, '');

  L.push('## PRD targets against these baselines', '', '| PRD target | Means |', '|---|---|');
  L.push(`| Voice start rate ≥ 15% (card-level, treatment) | Absolute; the baseline eligible-user rate is ${pct(startRate)} |`);
  L.push(`| D7 voice retention +5 pp | ${pct(d7.rate)} → ${d7.rate === null ? '—' : pct(d7.rate + 0.05)}${d7.rate !== null && d7.rate < 0.1 ? ' (more than 1.5× the baseline: ambitious)' : ''} |`);
  L.push(`| WAVL +25% relative | ${wavlPerWeek.toFixed(1)} → ${(wavlPerWeek * 1.25).toFixed(1)} per week (scaled to the experiment population) |`);
  L.push(`| Sessions per user per week +20% | ${m.sessions_per_user_week.control.value?.toFixed(2) ?? '—'} → ${m.sessions_per_user_week.control.value ? (m.sessions_per_user_week.control.value * 1.2).toFixed(2) : '—'} |`);
  L.push('| Opt-out ≤ 5%, no significant rise in thumbs-down | Guardrails; thumbs-down baseline above |', '');

  L.push(`## A/B sizing: ${(rollout * 100).toFixed(0)}% rollout, 50/50, ${weeks} weeks`, '');
  const perArmStart = eligiblePerWeekAt100 * rollout * 0.5 * weeks;
  const perArmD7 = firstVoicePerWeekAt100 * rollout * 0.5 * weeks; // control arm: organic first-time voice users only
  L.push('| Test | Baseline | Needed per arm | Expected per arm | Power | Rollout for 80% power |', '|---|---|---|---|---|---|');
  if (startRate !== null) {
    const p1 = Math.max(startRate, 0.001);
    const need = sampleSizePerArm(p1, p1 + START_MDE);
    const pw = powerFor(p1, p1 + START_MDE, Math.max(1, Math.floor(perArmStart)));
    L.push(`| Start rate +${START_MDE * 100} pp | ${pct(startRate)} | ${need.toLocaleString('en-US')} | ${Math.round(perArmStart).toLocaleString('en-US')} | ${(pw * 100).toFixed(0)}% | ${Math.min(100, Math.ceil(((need * 2) / (eligiblePerWeekAt100 * weeks)) * 100))}% |`);
  }
  if (d7.rate !== null) {
    const p1 = Math.max(d7.rate, 0.001);
    const need = sampleSizePerArm(p1, p1 + D7_MDE);
    const pw = powerFor(p1, p1 + D7_MDE, Math.max(1, Math.floor(perArmD7)));
    const rolloutNeeded = firstVoicePerWeekAt100 > 0 ? Math.ceil(((need * 2) / (firstVoicePerWeekAt100 * weeks)) * 100) : Infinity;
    L.push(`| D7 retention +${D7_MDE * 100} pp (control arm limits it) | ${pct(d7.rate)} | ${need.toLocaleString('en-US')} | ${perArmD7.toFixed(0)} | ${(pw * 100).toFixed(0)}% | ${Number.isFinite(rolloutNeeded) && rolloutNeeded <= 100 ? `${rolloutNeeded}%` : '> 100%: extend the test or accept a larger detectable effect'} |`);
  }
  L.push('', 'Freeze the chosen rollout and duration in [analysis-plan.md](analysis-plan.md) before Phase 9 (P8.5). Never change them after the test starts.', '');
  const md = L.join('\n');
  console.log(md);
  const out = flag('out');
  if (out) {
    writeFileSync(out, md);
    console.error(`✔ Wrote ${out}`);
  }
} finally {
  await db.close();
}

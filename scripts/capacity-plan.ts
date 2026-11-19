/**
 * P7.6 capacity plan vs Groq limits (architecture §13.5). Projects peak requests / tokens per minute and daily totals
 * per model for a traffic scenario, and compares them with the org limits in config (`analytics.groqLimits`).
 *
 *   npm run capacity:plan -- [--scenario dogfood|ab10|ramp100] [--users N] [--msgs 6] [--rollout 1]
 *                            [--measured]   (use average tokens per call from llm_usage in DATABASE_URL)
 *
 * Model of one day (all knobs are flags; defaults are proposals to replace with Phase 8 measurements):
 *   chat messages            = users × msgs                       (chat runs for everyone, on the same models)
 *   classifier calls         = messages × rollout × prefilterPass  (both arms classify: symmetric eligibility)
 *   cards shown              = classified × eligibleShare × treatment share × cap factor
 *   voice sessions           = cards × startRate + organic
 *   per session              = 1 opening + turns × (1 STT + 1 coach) + 1 summary
 * Peak minute = daily × peakHourShare / 60 × burst.
 */
import { config as loadDotenv } from 'dotenv';
import { DEFAULT_SVS_CONFIG } from '@svs/shared';
import { createDb } from '../apps/server/src/db';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};

const SCENARIOS: Record<string, { users: number; rollout: number; label: string }> = {
  dogfood: { users: 300, rollout: 1, label: 'Phase 8 dogfood: 300 staff/beta users, everyone enabled' },
  ab10: { users: 100_000, rollout: 0.1, label: 'Phase 9 A/B: 100k daily active learners, 10% in the experiment' },
  ramp100: { users: 100_000, rollout: 1, label: 'Phase 10 full ramp: 100k daily active learners, everyone enabled' },
};
const sc = SCENARIOS[opt('scenario', 'ab10')] ?? SCENARIOS.ab10!;
const P = {
  users: Number(opt('users', String(sc.users))),
  rollout: Number(opt('rollout', String(sc.rollout))),
  msgs: Number(opt('msgs', '6')), // chat messages per active user per day
  prefilterPass: Number(opt('prefilter-pass', '0.2')), // share of messages that reach the classifier
  eligibleShare: Number(opt('eligible-share', '0.35')), // classified as voice-friendly above threshold
  capFactor: Number(opt('cap-factor', '0.5')), // share surviving per-conversation / weekly caps
  treatment: DEFAULT_SVS_CONFIG.experiment.treatmentShare,
  startRate: Number(opt('start-rate', '0.15')), // PRD target
  organic: Number(opt('organic', '0.01')), // sessions per active SVS user per day without a card
  turns: Number(opt('turns', '6')),
  audioS: Number(opt('audio-s', '12')), // average spoken answer (Groq bills ≥10 s)
  peakHourShare: Number(opt('peak-hour', '0.15')),
  burst: Number(opt('burst', '2')),
};
// Average tokens per call (measured on real Groq calls in Phases 1–5; see docs/phase7/capacity-plan.md).
const TOKENS = { chat: 740, classifier: 880, opening: 550, coach: 620, summary: 620 };

if (args.includes('--measured') && process.env.DATABASE_URL) {
  const db = createDb(process.env.DATABASE_URL)!;
  const { rows } = await db.query<{ use_case: keyof typeof TOKENS; avg: number }>(
    "SELECT use_case, avg(total_tokens)::float8 AS avg FROM llm_usage WHERE status = 'ok' AND total_tokens IS NOT NULL GROUP BY 1",
  );
  for (const r of rows) if (r.use_case in TOKENS) TOKENS[r.use_case] = Math.round(r.avg);
  await db.close();
}

const cfg = DEFAULT_SVS_CONFIG;
const lim = cfg.analytics.groqLimits;
const m = cfg.llm.models;

const messages = P.users * P.msgs;
const svsUsers = P.users * P.rollout;
const classified = messages * P.rollout * P.prefilterPass;
const cards = classified * P.eligibleShare * P.capFactor * P.treatment;
const sessions = cards * P.startRate + svsUsers * P.organic;
const turns = sessions * P.turns;

/** Daily requests and tokens per (model) — primary models only (fallbacks only add load on failures). */
const perModel = new Map<string, { req: number; tok: number }>();
const add = (model: string, req: number, tokensEach: number) => {
  const cur = perModel.get(model) ?? { req: 0, tok: 0 };
  cur.req += req;
  cur.tok += req * tokensEach;
  perModel.set(model, cur);
};
add(m.chat.primary, messages, TOKENS.chat);
add(m.classifier.primary, classified, TOKENS.classifier);
add(m.opening.primary, sessions, TOKENS.opening);
add(m.coach.primary, turns, TOKENS.coach);
add(m.summary.primary, sessions, TOKENS.summary);
const peak = (daily: number) => ((daily * P.peakHourShare) / 60) * P.burst;

const f = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
const x = (v: number, limit: number) => `${f(v)} / ${limit.toLocaleString('en-US')} (${(v / limit).toFixed(v / limit < 10 ? 2 : 0)}×)`;
console.log(`## ${sc.label}\n`);
console.log(`Users ${P.users.toLocaleString('en-US')} · rollout ${P.rollout * 100}% · ${P.msgs} msgs/user/day → ${f(messages)} chat messages, ${f(classified)} classifier calls, ${f(cards)} cards, ${f(sessions)} voice sessions, ${f(turns)} spoken turns per day\n`);
console.log('| Model | Peak req/min vs limit | Peak tokens/min vs limit | Req/day vs limit | Tokens/day vs limit |');
console.log('|---|---|---|---|---|');
let worst = 0;
for (const [model, v] of perModel) {
  const ratios = [peak(v.req) / lim.requestsPerMinute, peak(v.tok) / lim.tokensPerMinute, v.req / lim.requestsPerDay, v.tok / lim.tokensPerDay];
  worst = Math.max(worst, ...ratios);
  console.log(`| ${model} | ${x(peak(v.req), lim.requestsPerMinute)} | ${x(peak(v.tok), lim.tokensPerMinute)} | ${x(v.req, lim.requestsPerDay)} | ${x(v.tok, lim.tokensPerDay)} |`);
}
const sttPeakHourAudio = turns * P.peakHourShare * Math.max(P.audioS, cfg.analytics.pricing.sttMinBilledS);
const sttRatios = [peak(turns) / lim.sttRequestsPerMinute, turns / lim.sttRequestsPerDay, sttPeakHourAudio / lim.audioSecondsPerHour];
worst = Math.max(worst, ...sttRatios);
console.log(`| ${cfg.stt.model} | ${x(peak(turns), lim.sttRequestsPerMinute)} | audio s/peak hour ${x(sttPeakHourAudio, lim.audioSecondsPerHour)} | ${x(turns, lim.sttRequestsPerDay)} | — |`);

// Cost (list prices): per day, and SVS spend per voice session.
const price = cfg.analytics.pricing;
const tokCost = (model: string, tokens: number, outShare: number) => {
  const p = price.models[model];
  return p ? (tokens * (1 - outShare) * p.inputPerM + tokens * outShare * p.outputPerM) / 1e6 : 0;
};
const sessionUsd =
  tokCost(m.opening.primary, TOKENS.opening, 0.08) +
  P.turns * tokCost(m.coach.primary, TOKENS.coach, 0.1) +
  tokCost(m.summary.primary, TOKENS.summary, 0.25) +
  (P.turns * Math.max(P.audioS, price.sttMinBilledS) * (price.sttPerHour[cfg.stt.model] ?? 0)) / 3600;
const classifierUsd = classified * tokCost(m.classifier.primary, TOKENS.classifier, 0.05);
const chatUsd = messages * tokCost(m.chat.primary, TOKENS.chat, 0.68);
console.log(`\nCost/day at list prices: chat $${chatUsd.toFixed(2)} · SVS $${(classifierUsd + sessions * sessionUsd).toFixed(2)} (classifier $${classifierUsd.toFixed(2)}, ${f(sessions)} sessions × $${sessionUsd.toFixed(4)})`);
console.log(`\n${worst <= cfg.analytics.groqLimits.warnShare ? '✅ Fits within' : `❌ Exceeds`} the current per-model limits (worst ratio ${worst.toFixed(1)}×, warn at ${cfg.analytics.groqLimits.warnShare}).`);

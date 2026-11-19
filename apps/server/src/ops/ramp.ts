import type { SvsConfig } from '@svs/shared';
import { cost, optOutRate, wavl } from '../analytics/report';
import { twoProportionTest } from '../analytics/stats';
import type { Queryable } from '../db';

/**
 * P10.1 / P10.2 / P10.4 ramp gate (no A/B in the prototype: everyone in the rollout gets cards).
 * Before each rollout step: enough time at the current step, no firing critical alerts, the PRD guardrails hold
 * (opt-out ≤ 5%, no significant thumbs-down rise on answers with a card), cost per WAVL within budget, and the Groq
 * load projected at the target rollout fits the org limits. "warn" = not enough data to judge; it doesn't block.
 */
export type RampStatus = 'pass' | 'warn' | 'fail';
export interface RampCheck {
  name: string;
  status: RampStatus;
  detail: string;
}

const DAY = 86_400_000;
const SVS_USE_CASES = ['classifier', 'opening', 'coach', 'summary', 'stt'];

export async function evaluateRamp(c: Queryable, cfg: SvsConfig, target: number, now = new Date()): Promise<{ current: number; checks: RampCheck[]; allowed: boolean }> {
  const checks: RampCheck[] = [];
  const add = (name: string, status: RampStatus, detail: string) => checks.push({ name, status, detail });
  const current = cfg.enabled ? cfg.rolloutPercent : 0;
  const a = cfg.analytics.alerts;
  const w = { from: new Date(now.getTime() - cfg.ramp.windowDays * DAY), to: now, experimentId: null, includeTest: false };

  // 1. The step itself.
  if (!(target > 0 && target <= 100)) add('Target rollout', 'fail', `${target}% is not between 1 and 100`);
  else if (target <= current) add('Target rollout', 'fail', `already at ${current}% (ramp only goes up; lower it with ops:config rollout)`);
  else add('Target rollout', 'pass', `${current}% → ${target}%`);

  // 2. Time at the current step (from the config audit trail).
  const audit = await c.query<{ changed_at: Date; old_r: string | null; new_r: string | null }>(
    `SELECT changed_at, old_overrides->>'rolloutPercent' AS old_r, new_overrides->>'rolloutPercent' AS new_r
       FROM svs_config_audit ORDER BY id DESC LIMIT 200`,
  );
  const lastStep = audit.rows.find((r) => r.old_r !== r.new_r);
  if (!lastStep || current === 0) add('Time at current step', 'pass', current === 0 ? 'first step' : 'no earlier rollout change');
  else {
    const hours = (now.getTime() - new Date(lastStep.changed_at).getTime()) / 3_600_000;
    add('Time at current step', hours >= cfg.ramp.minHoursPerStep ? 'pass' : 'fail', `${hours.toFixed(0)} h at ${current}% (minimum ${cfg.ramp.minHoursPerStep} h)`);
  }

  // 3. No firing critical alerts.
  const firing = (await c.query<{ rule: string; key: string }>("SELECT rule, key FROM alert_events WHERE status = 'firing' AND severity = 'critical'")).rows;
  add('No critical alerts firing', firing.length ? 'fail' : 'pass', firing.length ? firing.map((f) => (f.key ? `${f.rule}:${f.key}` : f.rule)).join(', ') : 'none');

  // 4. Opt-out guardrail (PRD ≤ 5%).
  const opt = await optOutRate(c, w);
  if (opt.den < a.minShownUsers) add('Opt-out ≤ 5%', 'warn', `not enough data: ${opt.den} users shown a card (need ${a.minShownUsers})`);
  else add('Opt-out ≤ 5%', (opt.rate ?? 0) <= a.optOutRate ? 'pass' : 'fail', `${((opt.rate ?? 0) * 100).toFixed(2)}% of ${opt.den} users`);

  // 5. Text satisfaction: thumbs-down on answers with a card vs answers without one (no control arm in a ramp).
  const td = (
    await c.query<{ with_card: boolean; n: number; down: number }>(
      `WITH fb AS (
         SELECT DISTINCT ON (e.props->>'message_id') e.props->>'message_id' AS mid, e.props->>'thumbs' AS thumbs
           FROM events e JOIN users u ON u.id = e.user_id AND NOT u.is_test
          WHERE e.event = 'answer_feedback' AND e.ts >= $1 ORDER BY e.props->>'message_id', e.ts DESC)
       SELECT EXISTS (SELECT 1 FROM suggestions s WHERE s.message_id::text = fb.mid AND s.status IN ('shown','tapped','dismissed','opted_out','ignored')) AS with_card,
              count(*)::int AS n, count(*) FILTER (WHERE fb.thumbs = 'down')::int AS down
         FROM fb GROUP BY 1`,
      [w.from.toISOString()],
    )
  ).rows;
  const g = (k: boolean) => td.find((r) => r.with_card === k) ?? { n: 0, down: 0 };
  const withCard = g(true);
  const without = g(false);
  if (withCard.n < a.minFeedbackPerArm || without.n < a.minFeedbackPerArm)
    add('No rise in thumbs-down with a card', 'warn', `not enough votes: ${withCard.n} with a card, ${without.n} without (need ${a.minFeedbackPerArm} each)`);
  else {
    const t = twoProportionTest(without.down, without.n, withCard.down, withCard.n)!;
    const worse = t.diff > 0 && t.p < a.thumbsDownPValue;
    add('No rise in thumbs-down with a card', worse ? 'fail' : 'pass', `${((withCard.down / withCard.n) * 100).toFixed(1)}% with vs ${((without.down / without.n) * 100).toFixed(1)}% without (p=${t.p.toFixed(3)})`);
  }

  // 6. Cost per WAVL (P10.4).
  const weeks = (await wavl(c, w)).reduce((s, r) => s + r.learners, 0);
  const co = await cost(c, w, cfg, weeks);
  const budget = cfg.analytics.costBudgetPerWavlUsd;
  if (budget === null) add('Cost per WAVL within budget', 'warn', 'no budget set');
  else if (co.per_wavl_usd === null) add('Cost per WAVL within budget', 'warn', `no WAVL yet (SVS spend $${co.svs_usd.toFixed(4)})`);
  else add('Cost per WAVL within budget', co.per_wavl_usd <= budget ? 'pass' : 'fail', `$${co.per_wavl_usd.toFixed(4)} vs budget $${budget}`);

  // 7. Groq capacity at the target (P10.2): chat stays as is; SVS load scales with the users it reaches.
  const days = cfg.ramp.windowDays;
  const load = (
    await c.query<{ model: string; svs: boolean; req: number; tok: number; audio: number }>(
      `SELECT model, use_case = ANY($2) AS svs, count(*)::float8 / $3 AS req, COALESCE(sum(total_tokens), 0)::float8 / $3 AS tok,
              COALESCE(sum(GREATEST(COALESCE(audio_seconds, 0), $4)) FILTER (WHERE use_case = 'stt'), 0)::float8 / $3 AS audio
         FROM llm_usage WHERE at >= $1 GROUP BY 1, 2`,
      [w.from.toISOString(), SVS_USE_CASES, days, cfg.analytics.pricing.sttMinBilledS],
    )
  ).rows;
  const reach = (
    await c.query<{ svs_users: number; active: number }>(
      `SELECT (SELECT count(DISTINCT (user_id, at::date))::float8 / $2 FROM suggestion_decisions
                WHERE at >= $1 AND outcome NOT IN ('stale_config', 'disabled', 'kill_switch', 'rollout')) AS svs_users,
              (SELECT count(DISTINCT (c.user_id, m.created_at::date))::float8 / $2 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE m.role = 'user' AND m.created_at >= $1) AS active`,
      [w.from.toISOString(), days],
    )
  ).rows[0]!;
  if (!reach.svs_users || !load.some((l) => l.svs)) add('Groq capacity at target', 'warn', 'no SVS traffic measured yet: run npm run capacity:plan for a modelled estimate');
  else {
    const scale = (reach.active * (target / 100)) / reach.svs_users;
    const lim = cfg.analytics.groqLimits;
    const perModel = new Map<string, { req: number; tok: number; audio: number }>();
    for (const l of load) {
      const m = perModel.get(l.model) ?? { req: 0, tok: 0, audio: 0 };
      const f = l.svs ? scale : 1;
      m.req += l.req * f;
      m.tok += l.tok * f;
      m.audio += l.audio * f;
      perModel.set(l.model, m);
    }
    const over: string[] = [];
    const lines: string[] = [];
    for (const [model, m] of perModel) {
      const stt = model in cfg.analytics.pricing.sttPerHour;
      const ratio = stt ? Math.max(m.req / lim.sttRequestsPerDay, m.audio / 24 / lim.audioSecondsPerHour) : Math.max(m.req / lim.requestsPerDay, m.tok / lim.tokensPerDay);
      lines.push(`${model} ${(ratio * 100).toFixed(0)}%`);
      if (ratio > lim.warnShare) over.push(model);
    }
    add('Groq capacity at target', over.length ? 'fail' : 'pass', `projected daily use vs limits (×${scale.toFixed(2)} SVS load): ${lines.join(' · ')}${over.length ? ` · over ${lim.warnShare * 100}%: ${over.join(', ')}` : ''}`);
  }

  return { current, checks, allowed: checks.every((c) => c.status !== 'fail') };
}

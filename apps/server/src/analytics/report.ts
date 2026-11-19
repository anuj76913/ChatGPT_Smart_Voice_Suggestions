import {
  FUNNEL_STEPS,
  METRICS_VERSION,
  type AlertRow,
  type ArmComparison,
  type ArmOrNone,
  type CostReport,
  type FunnelRow,
  type FunnelStep,
  type MetricsReport,
  type Proportion,
  type SvsConfig,
} from '@svs/shared';
import type { Queryable } from '../db';
import {
  Q_CARD_START,
  Q_CLASSIFIER,
  Q_COST,
  Q_D30,
  Q_D7,
  Q_ELIGIBLE_START,
  Q_EXPERIMENT,
  Q_FUNNEL,
  Q_HEADROOM,
  Q_HEALTH,
  Q_OPT_OUT,
  Q_SESSIONS_PER_WEEK,
  Q_THUMBS,
  Q_VOICE_START,
  Q_WAVL,
} from './queries';
import { compareArms, proportion, srm, twoProportionTest } from './stats';

export interface ReportWindow {
  from: Date;
  to: Date;
  /** null = all traffic (dogfood included), no arm comparison. */
  experimentId: string | null;
  includeTest: boolean;
}

/** SVS use cases for cost per WAVL; chat is the existing product and reported separately. */
const SVS_USE_CASES = new Set(['classifier', 'opening', 'coach', 'summary', 'stt']);
const ARMS: ArmOrNone[] = ['control', 'treatment', 'none'];

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const params = (w: ReportWindow) => [w.from.toISOString(), w.to.toISOString(), w.experimentId, w.includeTest];

/** Rows of {arm, num, den} → Proportion per arm. */
function byArm(rows: Array<{ arm: string; num: number; den: number }>): Record<ArmOrNone, Proportion> {
  const out = { control: proportion(0, 0), treatment: proportion(0, 0), none: proportion(0, 0) };
  for (const r of rows) out[(ARMS.includes(r.arm as ArmOrNone) ? r.arm : 'none') as ArmOrNone] = proportion(r.num, r.den);
  return out;
}
const armComparison = (rows: Array<{ arm: string; num: number; den: number }>): ArmComparison => {
  const a = byArm(rows);
  return compareArms(a.control, a.treatment);
};

export async function funnel(db: Queryable, w: ReportWindow): Promise<FunnelRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(Q_FUNNEL, params(w));
  return rows.map((r) => ({
    arm: r.arm as ArmOrNone,
    intent: (r.intent as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    steps: Object.fromEntries(FUNNEL_STEPS.map((s) => [s, Number(r[s] ?? 0)])) as Record<FunnelStep, number>,
  }));
}

export async function optOutRate(db: Queryable, w: ReportWindow): Promise<Proportion> {
  const r = (await db.query<{ num: number; den: number }>(Q_OPT_OUT, params(w))).rows[0];
  return proportion(r?.num ?? 0, r?.den ?? 0);
}

export async function thumbsDown(db: Queryable, w: ReportWindow): Promise<MetricsReport['metrics']['thumbs_down']> {
  const { rows } = await db.query<{ grp: string; num: number; den: number }>(Q_THUMBS, params(w));
  const g = (k: string) => rows.find((r) => r.grp === k) ?? { num: 0, den: 0 };
  const withCard = proportion(g('with_card').num, g('with_card').den);
  const control = proportion(g('control_eligible').num, g('control_eligible').den);
  const t = twoProportionTest(control.num, control.den, withCard.num, withCard.den);
  return { with_card: withCard, control_eligible: control, diff: t?.diff ?? null, p_value: t?.p ?? null };
}

export async function wavl(db: Queryable, w: ReportWindow) {
  return (await db.query<{ week: string; arm: ArmOrNone; learners: number }>(Q_WAVL, params(w))).rows;
}

export async function cost(db: Queryable, w: ReportWindow, cfg: SvsConfig, wavlLearnerWeeks: number): Promise<CostReport> {
  const p = cfg.analytics.pricing;
  const { rows } = await db.query<{ use_case: string; model: string; arm: ArmOrNone; prompt_tokens: number; completion_tokens: number; audio_seconds: number }>(Q_COST, [
    ...params(w),
    p.sttMinBilledS,
  ]);
  const byUseCase: Record<string, number> = {};
  const byArmUsd: Record<ArmOrNone, number> = { control: 0, treatment: 0, none: 0 };
  let svs = 0;
  let chat = 0;
  for (const r of rows) {
    const price = p.models[r.model];
    const usd =
      r.use_case === 'stt'
        ? (r.audio_seconds / 3600) * (p.sttPerHour[r.model] ?? 0)
        : price
          ? (r.prompt_tokens / 1e6) * price.inputPerM + (r.completion_tokens / 1e6) * price.outputPerM
          : 0;
    byUseCase[r.use_case] = (byUseCase[r.use_case] ?? 0) + usd;
    if (SVS_USE_CASES.has(r.use_case)) {
      svs += usd;
      byArmUsd[r.arm] = (byArmUsd[r.arm] ?? 0) + usd;
    } else chat += usd;
  }
  return {
    svs_usd: svs,
    chat_usd: chat,
    by_use_case: byUseCase,
    by_arm: byArmUsd,
    wavl_learner_weeks: wavlLearnerWeeks,
    per_wavl_usd: wavlLearnerWeeks > 0 ? svs / wavlLearnerWeeks : null,
    budget_per_wavl_usd: cfg.analytics.costBudgetPerWavlUsd,
  };
}

export async function health(db: Queryable, w: ReportWindow, cfg: SvsConfig): Promise<MetricsReport['health']> {
  const range = [w.from.toISOString(), w.to.toISOString()];
  const [h, head, vs, cl] = await Promise.all([
    db.query<Record<string, unknown>>(Q_HEALTH, range),
    db.query<{ model: string; peak_tpm: number; requests_today: number }>(Q_HEADROOM, range),
    db.query<{ n: number; p50_ms: unknown; p95_ms: unknown }>(Q_VOICE_START, range),
    db.query<{ calls: number; errors: number }>(Q_CLASSIFIER, range),
  ]);
  const rate = (n: unknown, d: number) => (d > 0 ? Number(n) / d : null);
  const c = cl.rows[0] ?? { calls: 0, errors: 0 };
  return {
    use_cases: h.rows.map((r) => {
      const calls = Number(r.calls);
      return {
        use_case: String(r.use_case),
        calls,
        error_rate: rate(r.errors, calls),
        rate_limited_rate: rate(r.rate_limited, calls),
        server_error_rate: rate(r.server_errors, calls),
        timeout_rate: rate(r.timeouts, calls),
        fallback_rate: rate(r.fallbacks, calls),
        p50_ms: num(r.p50_ms),
        p95_ms: num(r.p95_ms),
        ttft_p95_ms: num(r.ttft_p95_ms),
        tokens: Number(r.tokens),
      };
    }),
    headroom: head.rows.map((r) => ({
      model: r.model,
      peak_tokens_per_minute: r.peak_tpm,
      requests_today: r.requests_today,
      tpm_limit: r.model in cfg.analytics.pricing.sttPerHour ? null : cfg.analytics.groqLimits.tokensPerMinute,
      rpd_limit: cfg.analytics.groqLimits.requestsPerDay,
    })),
    voice_start: { n: vs.rows[0]?.n ?? 0, p50_ms: num(vs.rows[0]?.p50_ms), p95_ms: num(vs.rows[0]?.p95_ms) },
    classifier: { calls: c.calls, errors: c.errors, error_rate: c.calls > 0 ? c.errors / c.calls : null },
  };
}

export async function experimentChecks(db: Queryable, w: ReportWindow, cfg: SvsConfig): Promise<MetricsReport['experiment']> {
  if (!w.experimentId) return null;
  const { rows } = await db.query<{ what: string; arm: string; n: number }>(Q_EXPERIMENT, params(w));
  const share = cfg.experiment.treatmentShare;
  const get = (what: string, arm: string) => rows.find((r) => r.what === what && r.arm === arm)?.n ?? 0;
  const check = (what: string) => srm(get(what, 'control'), get(what, 'treatment'), share, cfg.analytics.srmPValue);
  return { expected_treatment_share: share, assignments: check('assignments'), eligible_users: check('eligible_users'), eligible_events: check('eligible_events') };
}

export async function recentAlerts(db: Queryable, since: Date): Promise<AlertRow[]> {
  const { rows } = await db.query<AlertRow & { fired_at: Date; resolved_at: Date | null }>(
    `SELECT id::int AS id, rule, key, severity, status, value, threshold, details, fired_at, resolved_at
       FROM alert_events WHERE status = 'firing' OR fired_at >= $1 ORDER BY (status = 'firing') DESC, fired_at DESC LIMIT 50`,
    [since.toISOString()],
  );
  return rows.map((r) => ({ ...r, fired_at: new Date(r.fired_at).toISOString(), resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null }));
}

/** Everything the dashboard and the analysis script need, for one window (P6.2–P6.5). */
export async function buildReport(db: Queryable, w: ReportWindow, cfg: SvsConfig): Promise<MetricsReport> {
  const p = params(w);
  const [fun, wv, card, elig, spw, d7, d30, opt, thumbs, exp, hl, alerts] = await Promise.all([
    funnel(db, w),
    wavl(db, w),
    db.query<{ intent: string; shown: number; started: number; tapped: number }>(Q_CARD_START, p),
    db.query<{ arm: string; num: number; den: number }>(Q_ELIGIBLE_START, p),
    db.query<{ arm: ArmOrNone; sessions: number; user_weeks: number }>(Q_SESSIONS_PER_WEEK, p),
    db.query<{ arm: string; num: number; den: number }>(Q_D7, p),
    db.query<{ arm: string; num: number; den: number }>(Q_D30, p),
    optOutRate(db, w),
    thumbsDown(db, w),
    experimentChecks(db, w, cfg),
    health(db, w, cfg),
    recentAlerts(db, w.from),
  ]);
  const learnerWeeks = wv.reduce((s, r) => s + r.learners, 0);
  const shown = card.rows.reduce((s, r) => s + r.shown, 0);
  const sessionsPerWeek = Object.fromEntries(ARMS.map((a) => [a, { sessions: 0, user_weeks: 0, value: null as number | null }])) as MetricsReport['metrics']['sessions_per_user_week'];
  for (const r of spw.rows) sessionsPerWeek[r.arm] = { sessions: r.sessions, user_weeks: r.user_weeks, value: r.user_weeks > 0 ? r.sessions / r.user_weeks : null };

  return {
    version: METRICS_VERSION,
    generated_at: new Date().toISOString(),
    window: { from: w.from.toISOString(), to: w.to.toISOString(), experiment_id: w.experimentId, include_test: w.includeTest },
    funnel: fun,
    metrics: {
      wavl: wv,
      card_start_rate: {
        ...proportion(
          card.rows.reduce((s, r) => s + r.started, 0),
          shown,
        ),
        by_intent: card.rows.map((r) => ({ intent: r.intent, num: r.started, den: r.shown, rate: r.shown > 0 ? r.started / r.shown : null })),
      },
      eligible_start_rate: armComparison(elig.rows),
      tap_rate: proportion(
        card.rows.reduce((s, r) => s + r.tapped, 0),
        shown,
      ),
      sessions_per_user_week: sessionsPerWeek,
      d7_voice_retention: armComparison(d7.rows),
      d30_retention: armComparison(d30.rows),
      opt_out_rate: opt,
      thumbs_down: thumbs,
      cost: await cost(db, w, cfg, learnerWeeks),
    },
    experiment: exp,
    health: hl,
    alerts,
  };
}

import type { SvsConfig } from '@svs/shared';
import type { Db, Queryable } from '../db';
import { cost, health, optOutRate, thumbsDown, wavl, type ReportWindow } from './report';

/**
 * P6.4 alert rules (architecture §12.4). Thresholds live in config (`analytics.alerts`, `analytics.groqLimits`,
 * `analytics.costBudgetPerWavlUsd`), so they change without a release. Each rule needs a minimum sample before it
 * can fire, so a quiet hour never pages anyone.
 *
 * State: one open row per (rule, key) in `alert_events`, resolved when the rule clears. New and resolved alerts are
 * logged and, when ALERT_WEBHOOK_URL is set, POSTed as `{text, alert}` (Slack-compatible). Payloads hold rule names
 * and numbers only, never content or user ids. A transaction-scoped advisory lock keeps multiple server instances
 * from evaluating at the same time.
 */
export type RuleStatus = 'ok' | 'firing' | 'insufficient_data' | 'not_configured';

export interface RuleResult {
  rule: string;
  key: string;
  status: RuleStatus;
  severity: 'warning' | 'critical';
  value: number | null;
  threshold: number | null;
  details: Record<string, number | string | null>;
}

export interface AlertDeps {
  db: Db;
  getConfig: () => SvsConfig;
  log?: { warn: (o: object, m: string) => void; error?: (o: object, m: string) => void };
  webhookUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DAY = 86_400_000;

export async function evaluateRules(c: Queryable, cfg: SvsConfig, now: Date): Promise<RuleResult[]> {
  const a = cfg.analytics.alerts;
  const out: RuleResult[] = [];
  const add = (r: Omit<RuleResult, 'key' | 'details'> & { key?: string; details?: RuleResult['details'] }) => out.push({ key: '', details: {}, ...r });
  const guard: ReportWindow = { from: new Date(now.getTime() - a.guardrailWindowDays * DAY), to: now, experimentId: null, includeTest: false };
  const short: ReportWindow = { ...guard, from: new Date(now.getTime() - a.healthWindowMinutes * 60_000) };
  const day: ReportWindow = { ...guard, from: new Date(now.getTime() - DAY) };

  // Guardrail: opt-out rate (PRD ≤ 5%). Warn at 80% of the limit so a trend is visible before the breach.
  const opt = await optOutRate(c, guard);
  if (opt.den < a.minShownUsers) add({ rule: 'opt_out_rate', status: 'insufficient_data', severity: 'critical', value: opt.rate, threshold: a.optOutRate, details: { users_shown: opt.den } });
  else {
    const rate = opt.rate ?? 0;
    const firing = rate > a.optOutRate * 0.8;
    add({ rule: 'opt_out_rate', status: firing ? 'firing' : 'ok', severity: rate > a.optOutRate ? 'critical' : 'warning', value: rate, threshold: a.optOutRate, details: { opted_out: opt.num, users_shown: opt.den } });
  }

  // Guardrail: thumbs-down on answers with a card vs control-eligible answers (significant rise).
  const td = await thumbsDown(c, { ...guard, experimentId: cfg.experiment.id });
  if (td.with_card.den < a.minFeedbackPerArm || td.control_eligible.den < a.minFeedbackPerArm)
    add({ rule: 'thumbs_down_delta', status: 'insufficient_data', severity: 'critical', value: td.diff, threshold: a.thumbsDownPValue, details: { with_card: td.with_card.den, control: td.control_eligible.den } });
  else {
    const firing = (td.diff ?? 0) > 0 && (td.p_value ?? 1) < a.thumbsDownPValue;
    add({
      rule: 'thumbs_down_delta',
      status: firing ? 'firing' : 'ok',
      severity: 'critical',
      value: td.diff,
      threshold: a.thumbsDownPValue,
      details: { p_value: td.p_value, with_card_rate: td.with_card.rate, control_rate: td.control_eligible.rate },
    });
  }

  // Groq health + classifier + voice start latency.
  const h = await health(c, short, cfg);
  const cl = h.classifier;
  if (cl.calls < a.minClassifierCalls) add({ rule: 'classifier_errors', status: 'insufficient_data', severity: 'warning', value: cl.error_rate, threshold: a.classifierErrorRate, details: { calls: cl.calls } });
  else
    add({ rule: 'classifier_errors', status: (cl.error_rate ?? 0) > a.classifierErrorRate ? 'firing' : 'ok', severity: 'warning', value: cl.error_rate, threshold: a.classifierErrorRate, details: { calls: cl.calls, errors: cl.errors } });

  const vs = (await health(c, day, cfg)).voice_start;
  if (vs.n < a.minVoiceSessions) add({ rule: 'voice_start_p95', status: 'insufficient_data', severity: 'warning', value: vs.p95_ms, threshold: a.voiceStartP95Ms, details: { sessions: vs.n } });
  else add({ rule: 'voice_start_p95', status: (vs.p95_ms ?? 0) > a.voiceStartP95Ms ? 'firing' : 'ok', severity: 'warning', value: vs.p95_ms, threshold: a.voiceStartP95Ms, details: { sessions: vs.n, p50_ms: vs.p50_ms } });

  for (const u of h.use_cases) {
    const enough = u.calls >= a.minGroqCalls;
    const rate = (rule: string, value: number | null, threshold: number, severity: RuleResult['severity']) =>
      add({ rule, key: u.use_case, status: !enough ? 'insufficient_data' : (value ?? 0) > threshold ? 'firing' : 'ok', severity, value, threshold, details: { calls: u.calls } });
    rate('groq_rate_limited', u.rate_limited_rate, a.groq429Rate, 'warning');
    rate('groq_server_errors', u.server_error_rate, a.groq5xxRate, 'critical');
    rate('groq_fallback', u.fallback_rate, a.groqFallbackRate, 'warning');
    // Streaming use cases are judged by time to first token, the rest by whole-call latency.
    const limit = a.latencyP95Ms[u.use_case as keyof typeof a.latencyP95Ms];
    if (limit) {
      const value = u.use_case === 'chat' || u.use_case === 'coach' ? u.ttft_p95_ms : u.p95_ms;
      add({ rule: 'groq_latency_p95', key: u.use_case, status: !enough ? 'insufficient_data' : (value ?? 0) > limit ? 'firing' : 'ok', severity: 'warning', value, threshold: limit, details: { calls: u.calls } });
    }
  }

  // Headroom against the org's per-model limits (tokens per minute, requests per day).
  const lim = cfg.analytics.groqLimits;
  for (const m of h.headroom) {
    const tpm = m.tpm_limit === null ? 0 : m.peak_tokens_per_minute / lim.tokensPerMinute;
    const rpd = m.requests_today / lim.requestsPerDay;
    const share = Math.max(tpm, rpd);
    add({
      rule: 'groq_headroom',
      key: m.model,
      status: share >= lim.warnShare ? 'firing' : 'ok',
      severity: share >= 1 ? 'critical' : 'warning',
      value: share,
      threshold: lim.warnShare,
      details: { peak_tokens_per_minute: m.peak_tokens_per_minute, requests_today: m.requests_today },
    });
  }

  // Cost per WAVL against the budget (not set until the capacity plan, Phase 7).
  const budget = cfg.analytics.costBudgetPerWavlUsd;
  const weeks = (await wavl(c, guard)).reduce((s, r) => s + r.learners, 0);
  const co = await cost(c, guard, cfg, weeks);
  if (budget === null) add({ rule: 'cost_per_wavl', status: 'not_configured', severity: 'warning', value: co.per_wavl_usd, threshold: null, details: { svs_usd: co.svs_usd } });
  else if (weeks === 0) add({ rule: 'cost_per_wavl', status: 'insufficient_data', severity: 'warning', value: null, threshold: budget, details: { svs_usd: co.svs_usd } });
  else add({ rule: 'cost_per_wavl', status: (co.per_wavl_usd ?? 0) > budget ? 'firing' : 'ok', severity: 'warning', value: co.per_wavl_usd, threshold: budget, details: { svs_usd: co.svs_usd, learner_weeks: weeks } });

  return out;
}

export class AlertEvaluator {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: AlertDeps) {}

  /** Evaluates every rule and updates alert state. Returns null when another instance holds the lock. */
  async run(): Promise<{ results: RuleResult[]; opened: RuleResult[]; resolved: string[] } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const now = this.deps.now?.() ?? new Date();
      const cfg = this.deps.getConfig();
      const outcome = await this.deps.db.tx(async (c) => {
        const lock = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('svs-alerts', 0)) AS ok");
        if (!lock.rows[0]?.ok) return null;
        const results = await evaluateRules(c, cfg, now);
        const opened: RuleResult[] = [];
        const resolved: string[] = [];
        for (const r of results) {
          if (r.status === 'firing') {
            const upd = await c.query(
              `UPDATE alert_events SET last_seen_at = $3, value = $4, threshold = $5, severity = $6, details = $7
                WHERE rule = $1 AND key = $2 AND status = 'firing'`,
              [r.rule, r.key, now.toISOString(), r.value, r.threshold, r.severity, JSON.stringify(r.details)],
            );
            if ((upd.rowCount ?? 0) === 0) {
              await c.query(
                `INSERT INTO alert_events (rule, key, severity, status, value, threshold, details, fired_at, last_seen_at)
                 VALUES ($1, $2, $3, 'firing', $4, $5, $6, $7, $7)`,
                [r.rule, r.key, r.severity, r.value, r.threshold, JSON.stringify(r.details), now.toISOString()],
              );
              opened.push(r);
            }
          } else if (r.status === 'ok') {
            const res = await c.query("UPDATE alert_events SET status = 'resolved', resolved_at = $3 WHERE rule = $1 AND key = $2 AND status = 'firing'", [
              r.rule,
              r.key,
              now.toISOString(),
            ]);
            if ((res.rowCount ?? 0) > 0) resolved.push(r.key ? `${r.rule}:${r.key}` : r.rule);
          }
          // insufficient_data / not_configured leave any open alert as it is.
        }
        return { results, opened, resolved };
      });
      if (outcome) await this.notify(outcome.opened, outcome.resolved);
      return outcome;
    } finally {
      this.running = false;
    }
  }

  private async notify(opened: RuleResult[], resolved: string[]) {
    for (const r of opened) {
      const name = r.key ? `${r.rule}:${r.key}` : r.rule;
      const text = `[SVS ${r.severity}] ${name} = ${fmt(r.value)} (threshold ${fmt(r.threshold)})`;
      (r.severity === 'critical' ? (this.deps.log?.error ?? this.deps.log?.warn) : this.deps.log?.warn)?.({ alert: name, value: r.value, threshold: r.threshold }, text);
      await this.post({ text, alert: { rule: r.rule, key: r.key, severity: r.severity, value: r.value, threshold: r.threshold, status: 'firing' } });
    }
    for (const name of resolved) {
      this.deps.log?.warn({ alert: name }, `[SVS resolved] ${name}`);
      await this.post({ text: `[SVS resolved] ${name}`, alert: { name, status: 'resolved' } });
    }
  }

  private async post(body: object) {
    if (!this.deps.webhookUrl) return;
    try {
      await (this.deps.fetchImpl ?? fetch)(this.deps.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      this.deps.log?.warn({ err: (err as Error).message }, 'alert webhook failed');
    }
  }

  start() {
    const ms = this.deps.getConfig().analytics.alerts.intervalMs;
    if (this.timer || ms <= 0) return;
    this.timer = setInterval(() => void this.run().catch((err: unknown) => this.deps.log?.warn({ err: (err as Error).message }, 'alert evaluation failed')), ms);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

const fmt = (v: number | null) => (v === null ? 'n/a' : Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(1));

import type { ExperimentDecision, MetricsReport, SvsConfig } from '@svs/shared';

/**
 * P6.7 PRD decision rules (context.md §4.15, architecture §11), applied in this order:
 *   invalid       the report isn't scoped to an experiment, or the split is broken (SRM)
 *   kill          opt-out rate > 5%, or thumbs-down on answers with a card rose significantly
 *   ship          eligible-user voice start rate ↑ AND D7 voice retention ↑ (both significant), guardrails hold
 *   iterate       start rate ↑ (learners tap and start) but D7 flat → fix the in-session experience
 *   inconclusive  no significant lift in the primary metric
 * "↑" = treatment − control > 0 with a two-sided p < alpha. Target checks (card start rate ≥ 15%, D7 +5 pp,
 * WAVL +25%) are reported for the ramp gate but don't change the decision.
 */
export interface DecisionResult {
  decision: ExperimentDecision;
  reasons: string[];
  checks: Array<{ name: string; pass: boolean | null; detail: string }>;
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const pp = (v: number | null) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)} pp`);
const pv = (v: number | null) => (v === null ? 'n/a' : v < 0.0001 ? '<0.0001' : v.toFixed(4));

export function decideExperiment(r: MetricsReport, cfg: SvsConfig, alpha = 0.05): DecisionResult {
  const m = r.metrics;
  const checks: DecisionResult['checks'] = [];
  const reasons: string[] = [];

  if (!r.experiment) return { decision: 'invalid', reasons: ['The report is not scoped to an experiment (experiment_id is null).'], checks };
  const srmBad = r.experiment.assignments.mismatch || r.experiment.eligible_users.mismatch;
  checks.push({
    name: 'Sample ratio (SRM)',
    pass: !srmBad,
    detail: `assignments p=${pv(r.experiment.assignments.p_value)}, eligible users p=${pv(r.experiment.eligible_users.p_value)} (alarm below ${cfg.analytics.srmPValue})`,
  });
  if (srmBad) return { decision: 'invalid', reasons: ['Sample-ratio mismatch: the observed split differs from the configured share. Find the cause before reading any result.'], checks };

  const optOut = m.opt_out_rate.rate;
  const optOutBreach = optOut !== null && optOut > cfg.analytics.alerts.optOutRate;
  checks.push({ name: 'Guardrail: opt-out rate ≤ 5%', pass: optOut === null ? null : !optOutBreach, detail: `${pct(optOut)} (${m.opt_out_rate.num}/${m.opt_out_rate.den} users shown a card)` });

  const td = m.thumbs_down;
  const tdBreach = (td.diff ?? 0) > 0 && (td.p_value ?? 1) < alpha;
  checks.push({
    name: 'Guardrail: no significant rise in thumbs-down',
    pass: td.p_value === null ? null : !tdBreach,
    detail: `with card ${pct(td.with_card.rate)} vs control-eligible ${pct(td.control_eligible.rate)} (${pp(td.diff)}, p=${pv(td.p_value)})`,
  });

  const s = m.eligible_start_rate;
  const startUp = (s.diff ?? 0) > 0 && (s.p_value ?? 1) < alpha;
  checks.push({
    name: 'Primary: eligible-user voice start rate ↑',
    pass: s.p_value === null ? null : startUp,
    detail: `treatment ${pct(s.treatment.rate)} vs control ${pct(s.control.rate)} (${pp(s.diff)}, 95% CI ${s.ci95 ? `${pp(s.ci95[0])} … ${pp(s.ci95[1])}` : 'n/a'}, p=${pv(s.p_value)})`,
  });

  const d7 = m.d7_voice_retention;
  const d7Up = (d7.diff ?? 0) > 0 && (d7.p_value ?? 1) < alpha;
  checks.push({
    name: 'Primary: D7 voice retention ↑',
    pass: d7.p_value === null ? null : d7Up,
    detail: `treatment ${pct(d7.treatment.rate)} vs control ${pct(d7.control.rate)} (${pp(d7.diff)}, p=${pv(d7.p_value)}; n=${d7.treatment.den}/${d7.control.den})`,
  });

  // Ramp-gate targets (informational).
  checks.push({ name: 'Target: card-level start rate ≥ 15%', pass: m.card_start_rate.rate === null ? null : m.card_start_rate.rate >= 0.15, detail: `${pct(m.card_start_rate.rate)} (${m.card_start_rate.num}/${m.card_start_rate.den})` });
  checks.push({ name: 'Target: D7 voice retention +5 pp', pass: d7.diff === null ? null : d7.diff >= 0.05, detail: pp(d7.diff) });
  const wavlBy = (arm: string) => m.wavl.filter((w) => w.arm === arm).reduce((t, w) => t + w.learners, 0);
  const wc = wavlBy('control');
  const wt = wavlBy('treatment');
  const share = r.experiment.expected_treatment_share;
  // Arms can differ in size, so compare WAVL per assigned user.
  const perUser = (v: number, n: number) => (n > 0 ? v / n : null);
  const wcu = perUser(wc, r.experiment.assignments.control);
  const wtu = perUser(wt, r.experiment.assignments.treatment);
  const lift = wcu && wtu !== null ? wtu / wcu - 1 : null;
  checks.push({ name: 'Target: WAVL +25% (per assigned user)', pass: lift === null ? null : lift >= 0.25, detail: `${lift === null ? 'n/a' : `${(lift * 100).toFixed(1)}%`} (learner-weeks ${wt} treatment / ${wc} control, split ${share})` });

  if (optOutBreach) reasons.push(`Opt-out rate ${pct(optOut)} is above the 5% guardrail.`);
  if (tdBreach) reasons.push(`Thumbs-down rose significantly on answers with a card (${pp(td.diff)}, p=${pv(td.p_value)}).`);
  if (reasons.length) return { decision: 'kill', reasons: [...reasons, 'Turn suggestions off with the kill switch and write up the learnings.'], checks };

  if (startUp && d7Up) return { decision: 'ship', reasons: ['Voice start rate and D7 voice retention both rose significantly, and the guardrails hold. Go to Phase 10 (ramp).'], checks };
  if (startUp)
    return {
      decision: 'iterate',
      reasons: ['Learners tap and start more, but D7 voice retention did not rise significantly. Improve the in-session experience (presets, coach prompts, summary/tip, streak), then re-test.'],
      checks,
    };
  if ((d7.diff ?? 0) < 0 && (d7.p_value ?? 1) < alpha) reasons.push('Warning: D7 voice retention fell significantly in treatment.');
  return { decision: 'inconclusive', reasons: [...reasons, 'No significant lift in the eligible-user voice start rate. Check power (sample size) before extending or stopping.'], checks };
}

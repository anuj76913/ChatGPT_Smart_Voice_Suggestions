import type { Arm } from './events';

/** Version of the metric definitions (architecture §12.3). Bump when any query's meaning changes. */
export const METRICS_VERSION = 'metrics-v1';

/** Card-level funnel (architecture §12.4). The unit is one eligible suggestion; control stops at "eligible". */
export const FUNNEL_STEPS = ['eligible', 'shown', 'tapped', 'permission_ok', 'started', 'completed_30s', 'returned_d7'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** `none` = not in this experiment (dogfood, or never reached the arm assignment). */
export type ArmOrNone = Arm | 'none';

export interface Proportion {
  num: number;
  den: number;
  /** null when the denominator is 0. */
  rate: number | null;
}

export interface ArmComparison {
  control: Proportion;
  treatment: Proportion;
  /** treatment − control, with a two-sided two-proportion z-test. null when either arm is empty. */
  diff: number | null;
  ci95: [number, number] | null;
  p_value: number | null;
}

export interface FunnelRow {
  arm: ArmOrNone;
  intent: string | null;
  language: string | null;
  steps: Record<FunnelStep, number>;
}

export interface SrmResult {
  control: number;
  treatment: number;
  expected_treatment_share: number;
  chi2: number | null;
  p_value: number | null;
  /** true when p < analytics.srmPValue (the split is broken; don't trust the results). */
  mismatch: boolean;
}

export interface UseCaseHealth {
  use_case: string;
  calls: number;
  error_rate: number | null;
  rate_limited_rate: number | null;
  server_error_rate: number | null;
  timeout_rate: number | null;
  fallback_rate: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  ttft_p95_ms: number | null;
  tokens: number;
}

export interface ModelHeadroom {
  model: string;
  peak_tokens_per_minute: number;
  requests_today: number;
  /** null for speech-to-text models (billed by audio time, not tokens). */
  tpm_limit: number | null;
  rpd_limit: number;
}

export interface CostReport {
  /** SVS spend: classifier, opening, coach, summary and speech-to-text. Chat is the existing product, shown separately. */
  svs_usd: number;
  chat_usd: number;
  by_use_case: Record<string, number>;
  by_arm: Record<ArmOrNone, number>;
  /** Sum of weekly WAVL counts in the window (learner-weeks). */
  wavl_learner_weeks: number;
  per_wavl_usd: number | null;
  budget_per_wavl_usd: number | null;
}

export interface AlertRow {
  id: number;
  rule: string;
  key: string;
  severity: 'warning' | 'critical';
  status: 'firing' | 'resolved';
  value: number | null;
  threshold: number | null;
  details: Record<string, unknown>;
  fired_at: string;
  resolved_at: string | null;
}

export interface MetricsReport {
  version: string;
  generated_at: string;
  /** experiment_id null = all traffic, including dogfood (no arm comparison). */
  window: { from: string; to: string; experiment_id: string | null; include_test: boolean };
  funnel: FunnelRow[];
  metrics: {
    /** Per ISO week (in the learner's time zone) and arm. */
    wavl: Array<{ week: string; arm: ArmOrNone; learners: number }>;
    /** Treatment only: sessions started from a card ÷ cards shown (PRD target ≥ 15%). */
    card_start_rate: Proportion & { by_intent: Array<{ intent: string; num: number; den: number; rate: number | null }> };
    /** Primary A/B metric: eligible users with ≥1 voice session after first eligibility ÷ eligible users. */
    eligible_start_rate: ArmComparison;
    /** Card taps ÷ cards shown (treatment), for the "taps ↑" rule. */
    tap_rate: Proportion;
    sessions_per_user_week: Record<ArmOrNone, { sessions: number; user_weeks: number; value: number | null }>;
    /** First-time voice users (first session in the window, matured 7 days) who start another on local days 1–7. */
    d7_voice_retention: ArmComparison;
    /** Proxy for the app-level pipeline: users whose day 30–36 window closed in the report window, active again on local days 30–36. */
    d30_retention: ArmComparison;
    /** Users who turned suggestions off after seeing a card ÷ users shown a card (guardrail ≤ 5%). */
    opt_out_rate: Proportion;
    /** Thumbs-down on answers that showed a card vs on control answers that were eligible for one. */
    thumbs_down: { with_card: Proportion; control_eligible: Proportion; diff: number | null; p_value: number | null };
    cost: CostReport;
  };
  /** null when the report isn't scoped to an experiment. */
  experiment: {
    expected_treatment_share: number;
    assignments: SrmResult;
    eligible_users: SrmResult;
    eligible_events: SrmResult;
  } | null;
  health: {
    use_cases: UseCaseHealth[];
    headroom: ModelHeadroom[];
    /** Session request → first audible audio, as measured by the client (NFR p90 < 2 s; alert on p95). */
    voice_start: { n: number; p50_ms: number | null; p95_ms: number | null };
    /** Classifier decisions after fallback that ended in an error (no card). */
    classifier: { calls: number; errors: number; error_rate: number | null };
  };
  alerts: AlertRow[];
}

/** PRD decision rules (context.md §4.15) applied by the analysis script (P6.7). */
export type ExperimentDecision = 'ship' | 'iterate' | 'kill' | 'inconclusive' | 'invalid';

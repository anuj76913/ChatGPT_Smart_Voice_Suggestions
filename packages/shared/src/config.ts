import type { CopyLanguage } from './copy';
import type { VoiceIntent } from './intents';
import tunedThresholds from './classifier-thresholds.json';

/** A kill-switch rule matches when every field it sets matches the request (architecture §10). */
export interface KillSwitchRule {
  region?: string;
  language?: string;
  cohort?: string;
}

export interface ModelPair {
  primary: string;
  /** `null` means the caller degrades without a second model (e.g. static opening template). */
  fallback: string | null;
}

export const LLM_USE_CASES = ['chat', 'classifier', 'coach', 'opening', 'summary'] as const;
export type LlmUseCase = (typeof LLM_USE_CASES)[number];
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Effective `svs.*` configuration (architecture §10). Runtime overrides are deep-merged onto the defaults. */
export interface SvsConfig {
  enabled: boolean;
  /** Cohorts that get suggestions even while `enabled` is false and regardless of rollout (Phase 8 dogfood). */
  dogfoodCohorts: string[];
  killSwitch: KillSwitchRule[];
  rolloutPercent: number;
  experiment: { id: string; treatmentShare: number };
  cap: { perConversation: number; perRollingWeek: number; rollingWindowHours: number };
  pause: { consecutiveDismissals: number; days: number };
  classifier: {
    timeoutMs: number;
    thresholds: Record<VoiceIntent, number>;
    precisionTarget: number;
    maxInputChars: number;
    recentTurns: number;
    /**
     * Query languages the classifier has been evaluated on. Cards are only shown for these (edge-case CL-06).
     * Add "hi" only after the eval set covers Devanagari Hindi.
     */
    languages: string[];
  };
  suggestion: { graceMs: number };
  voice: {
    startBudgetMs: number;
    openingLineBudgetMs: number;
    maxDurationS: number;
    warnBeforeEndS: number;
    noisyTurns: number;
    reconnectMs: number;
    contextTurns: number;
    endOfSpeechSilenceMs: number;
    wavlMinSessionS: number;
    /** How long the server keeps a disconnected session resumable before ending it with reason "network". */
    serverResumeWindowMs: number;
    /** Longest single spoken turn the client may record, and the largest audio clip the server accepts. */
    maxTurnSeconds: number;
    maxTurnAudioBytes: number;
    /** Whisper quality signals: a turn is low quality below this mean avg_logprob or above this no_speech_prob. */
    sttMinAvgLogprob: number;
    sttMaxNoSpeechProb: number;
    coachMaxTokens: number;
    /** Client silence handling (edge-case IS-06): show a nudge, then pause. */
    silenceNudgeMs: number;
    silencePauseMs: number;
    /** P7.4 abuse guard: spoken turns per session per rolling minute (each costs a Whisper + coach call). */
    maxTurnsPerMinute: number;
  };
  streak: { goalDays: number };
  /** Card copy languages that may be used. A card still needs its query language in classifier.languages. */
  copy: { languages: CopyLanguage[] };
  llm: {
    provider: 'groq';
    baseUrl: string;
    models: Record<LlmUseCase, ModelPair>;
    reasoningEffort: Record<LlmUseCase, ReasoningEffort>;
    /** Non-streaming use cases: whole-call budget. Streaming (chat, coach): time to first token. */
    timeoutsMs: {
      chat: number;
      classifier: number;
      opening: number;
      coachFirstToken: number;
      summary: number;
      /** Max gap between streamed chunks before the stream is abandoned. */
      streamIdle: number;
    };
    /** Per-use-case concurrency budgets so one use case can't starve another (architecture §6.7.2). */
    concurrency: Record<LlmUseCase, number>;
    /** Retries per model, only within the time budget (architecture §6.7.3). */
    maxRetries: number;
  };
  stt: { provider: 'groq'; model: string; fallbackModel: string };
  tts: { provider: 'browser'; voices: string[] };
  /** Phase 6: metrics, cost and alerting (architecture §12.3–12.4). */
  analytics: AnalyticsConfig;
  /** Phase 7 (P7.3): how long finalized voice transcripts are kept. Must match the Voice Mode policy (Legal). */
  privacy: { voiceTranscriptRetentionDays: number; feedbackRetentionDays: number; purgeIntervalMs: number };
  /** Phase 10 ramp (no A/B in the prototype): guardrail window and minimum time between rollout steps. */
  ramp: { experimentId: string; minHoursPerStep: number; windowDays: number };
  /** Phase 11 v2 bets, each behind its own flag (off by default). */
  v2: {
    /** Voice Preview Mode: a ~30 s guided demo from the card, no mic needed. */
    previewMode: { enabled: boolean };
    /** Whisper / low-volume mode for hostels and libraries. */
    quietMode: { enabled: boolean };
  };
}

/** Use cases whose latency is alerted on: streaming ones by time to first token, the rest by whole-call latency. */
export const LATENCY_USE_CASES = ['chat', 'classifier', 'coach', 'opening', 'summary', 'stt'] as const;
export type LatencyUseCase = (typeof LATENCY_USE_CASES)[number];

export interface AnalyticsConfig {
  /** Groq list prices in USD, used for cost per WAVL. */
  pricing: {
    models: Record<string, { inputPerM: number; outputPerM: number }>;
    sttPerHour: Record<string, number>;
    /** Groq bills each transcription for at least this many seconds. */
    sttMinBilledS: number;
  };
  /** SVS spend per WAVL that triggers the cost alert. null = not set yet (the alert reports "not configured"). */
  costBudgetPerWavlUsd: number | null;
  /** Org limits per model (console.groq.com/docs/rate-limits) for the headroom alert and the capacity plan. */
  groqLimits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
    requestsPerDay: number;
    tokensPerDay: number;
    /** Whisper: requests per minute / per day, audio seconds per hour. */
    sttRequestsPerMinute: number;
    sttRequestsPerDay: number;
    audioSecondsPerHour: number;
    warnShare: number;
  };
  /** SRM alarm threshold for the chi-square test (a common choice is p < 0.001). */
  srmPValue: number;
  alerts: {
    /** How often the server evaluates alert rules. 0 disables the scheduler. */
    intervalMs: number;
    /** Optional rule windows. Product guardrails use 7 days; Groq health uses a short window. */
    guardrailWindowDays: number;
    healthWindowMinutes: number;
    optOutRate: number;
    minShownUsers: number;
    thumbsDownPValue: number;
    minFeedbackPerArm: number;
    classifierErrorRate: number;
    minClassifierCalls: number;
    voiceStartP95Ms: number;
    minVoiceSessions: number;
    groq429Rate: number;
    groq5xxRate: number;
    groqFallbackRate: number;
    minGroqCalls: number;
    latencyP95Ms: Record<LatencyUseCase, number>;
  };
}

/** Recursive partial used for runtime overrides. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Defaults. PRD values are fixed requirements; values marked "proposed" come from
 * docs/decisions.md ADR-008 and can be overridden at runtime by the config service (S7).
 */
/**
 * Team-demo runtime overrides ("show everything"): applied by `npm run demo:setup` locally, or on first start of a
 * deployed server with APPLY_DEMO_CONFIG=true. Suggestions on for everyone, cards in all six eval languages,
 * relaxed caps so a presenter can repeat flows, and the in-scope v2 bets (voice preview, quiet mode).
 */
export const DEMO_CONFIG: DeepPartial<SvsConfig> = {
  enabled: true,
  rolloutPercent: 100,
  killSwitch: [],
  dogfoodCohorts: [],
  experiment: { id: 'svs_demo', treatmentShare: 1 },
  cap: { perConversation: 1, perRollingWeek: 20, rollingWindowHours: 168 }, // 20 = the validated maximum
  pause: { consecutiveDismissals: 20, days: 1 },
  classifier: { languages: ['en', 'hinglish', 'hi', 'bn', 'mr', 'te'] },
  v2: {
    previewMode: { enabled: true },
    quietMode: { enabled: true },
  },
};

export const DEFAULT_SVS_CONFIG: SvsConfig = {
  enabled: false,
  dogfoodCohorts: [],
  killSwitch: [],
  rolloutPercent: 0,
  experiment: { id: 'svs_v1', treatmentShare: 0.5 },

  // FR-5 (PRD): 1 per conversation, 3 per user per rolling week; pause 14 days after 3 dismissals in a row.
  cap: { perConversation: 1, perRollingWeek: 3, rollingWindowHours: 168 },
  pause: { consecutiveDismissals: 3, days: 14 },

  classifier: {
    timeoutMs: 2000, // decided 2026-11-16 (ADR-008): 1.5s timed out 14% of calls on the Groq free tier
    // Tuned by the Phase 2 threshold sweep (implementation-plan P2.6); see classifier-thresholds.json.
    thresholds: tunedThresholds.thresholds as Record<VoiceIntent, number>,
    precisionTarget: 0.85, // FR-1 (PRD)
    maxInputChars: 2000, // proposed (edge-case CL-11)
    recentTurns: 2, // proposed
    languages: ['en', 'hinglish'], // the Phase 2 eval set covers English + Hinglish only
  },

  suggestion: { graceMs: 500 }, // proposed

  voice: {
    startBudgetMs: 2000, // NFR (PRD)
    openingLineBudgetMs: 600, // proposed
    maxDurationS: 600, // proposed
    warnBeforeEndS: 60, // proposed
    noisyTurns: 2, // proposed
    reconnectMs: 5000, // proposed
    contextTurns: 6, // proposed
    // 1.8 s: 1.2 s cut learners off mid-answer (thinking pauses), 2.5 s felt slow after every answer. Silence is
    // measured against the learner's own speech level (web end-of-turn.ts), so room noise can't stretch it.
    // "Done speaking" still ends a turn at once. Tunable live: npm run ops:config.
    endOfSpeechSilenceMs: 1800,
    wavlMinSessionS: 30, // North Star definition (PRD)
    serverResumeWindowMs: 60000, // proposed
    maxTurnSeconds: 90, // proposed (edge-case IS-10)
    maxTurnAudioBytes: 4_000_000, // ~90 s of Opus with headroom
    sttMinAvgLogprob: -1.0, // proposed; tune with real audio
    sttMaxNoSpeechProb: 0.6, // proposed
    coachMaxTokens: 400,
    silenceNudgeMs: 10000, // proposed (edge-case IS-06)
    silencePauseMs: 60000, // proposed
    maxTurnsPerMinute: 15, // proposed: a real answer + spoken reply takes well over 4 s
  },

  streak: { goalDays: 3 }, // proposed

  // FR-11: English + Hindi (Phase 5) + the top 3 regional languages (Phase 10). Copy is ready (drafts, COPY_STATUS);
  // cards in a language are gated by classifier.languages, which only lists languages the classifier was evaluated on.
  copy: { languages: ['en', 'hi', 'bn', 'mr', 'te'] },

  llm: {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Only Groq *production* models available to the project's key (verified with `npm run groq:check`).
    // The Llama models are Enterprise-tier on Groq and not available to this key (decisions.md ADR-004).
    models: {
      chat: { primary: 'openai/gpt-oss-120b', fallback: 'openai/gpt-oss-20b' },
      classifier: { primary: 'openai/gpt-oss-20b', fallback: 'openai/gpt-oss-120b' },
      coach: { primary: 'openai/gpt-oss-120b', fallback: 'openai/gpt-oss-20b' },
      opening: { primary: 'openai/gpt-oss-20b', fallback: null },
      summary: { primary: 'openai/gpt-oss-120b', fallback: 'openai/gpt-oss-20b' },
    },
    // gpt-oss models reason before answering; keep effort low where latency matters.
    reasoningEffort: { chat: 'low', classifier: 'low', coach: 'low', opening: 'low', summary: 'medium' },
    timeoutsMs: { chat: 15000, classifier: 2000, opening: 600, coachFirstToken: 1000, summary: 8000, streamIdle: 20000 },
    concurrency: { chat: 50, classifier: 20, coach: 30, opening: 20, summary: 10 },
    maxRetries: 1,
  },

  stt: { provider: 'groq', model: 'whisper-large-v3-turbo', fallbackModel: 'whisper-large-v3' },
  tts: { provider: 'browser', voices: ['en-IN', 'hi-IN'] },

  analytics: {
    // Groq on-demand list prices (console.groq.com/docs/models, checked 2026-11-17). Update when Groq changes them.
    pricing: {
      models: {
        'openai/gpt-oss-120b': { inputPerM: 0.15, outputPerM: 0.6 },
        'openai/gpt-oss-20b': { inputPerM: 0.075, outputPerM: 0.3 },
      },
      sttPerHour: { 'whisper-large-v3-turbo': 0.04, 'whisper-large-v3': 0.111 },
      sttMinBilledS: 10, // console.groq.com/docs/speech-to-text
    },
    // Proposed in the Phase 7 capacity plan (≈$0.011 per WAVL estimated at A/B scale, ~4–5× headroom).
    // Not a PRD number: the product owner confirms it before the A/B test (decisions.md ADR-015).
    costBudgetPerWavlUsd: 0.05,
    // Groq's published base limits per model (checked 2026-11-17); the current key hits exactly these.
    groqLimits: {
      requestsPerMinute: 30,
      tokensPerMinute: 8000,
      requestsPerDay: 1000,
      tokensPerDay: 200_000,
      sttRequestsPerMinute: 20,
      sttRequestsPerDay: 2000,
      audioSecondsPerHour: 7200,
      warnShare: 0.8,
    },
    srmPValue: 0.001,
    alerts: {
      intervalMs: 300_000,
      guardrailWindowDays: 7,
      healthWindowMinutes: 15,
      optOutRate: 0.05, // PRD guardrail
      minShownUsers: 50,
      thumbsDownPValue: 0.05, // PRD: "no significant rise"
      minFeedbackPerArm: 100,
      classifierErrorRate: 0.05,
      minClassifierCalls: 20,
      voiceStartP95Ms: 2000, // NFR (PRD); measured server-side from the client's start_latency_ms
      minVoiceSessions: 20,
      groq429Rate: 0.05,
      groq5xxRate: 0.02,
      groqFallbackRate: 0.1,
      minGroqCalls: 20,
      latencyP95Ms: { chat: 2000, classifier: 2000, coach: 1500, opening: 600, summary: 8000, stt: 1500 },
    },
  },

  // Proposed until Legal confirms the Voice Mode policy (decisions.md ADR-015). Audio is never stored at all.
  privacy: { voiceTranscriptRetentionDays: 30, feedbackRetentionDays: 90, purgeIntervalMs: 6 * 3_600_000 },

  // Proposed: hold each step 3 days so the 7-day guardrails see it; everyone in the rollout is treatment (no A/B).
  ramp: { experimentId: 'svs_ramp', minHoursPerStep: 72, windowDays: 7 },

  // Phase 11 (PRD launch phase 4): each v2 bet ships behind its own flag, off by default.
  v2: {
    previewMode: { enabled: false },
    quietMode: { enabled: false },
  },
};

/** Every Groq model ID the config refers to (LLM + STT), de-duplicated. Used by `npm run groq:check`. */
export function configuredGroqModels(config: SvsConfig = DEFAULT_SVS_CONFIG): string[] {
  const ids = new Set<string>();
  for (const pair of Object.values(config.llm.models)) {
    ids.add(pair.primary);
    if (pair.fallback) ids.add(pair.fallback);
  }
  ids.add(config.stt.model);
  ids.add(config.stt.fallbackModel);
  return [...ids].sort();
}

/** Deep-merges overrides onto a base config. Arrays and primitives replace; objects merge. Pure. */
export function mergeConfig(base: SvsConfig, overrides: DeepPartial<SvsConfig>): SvsConfig {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (Array.isArray(b) || b === null || typeof b !== 'object') return b;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return b;
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v);
    return out;
  };
  return merge(base, overrides) as SvsConfig;
}

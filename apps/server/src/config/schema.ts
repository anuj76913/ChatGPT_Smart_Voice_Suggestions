import { z } from 'zod';
import { CLASSIFIER_LANGUAGES, COPY_LANGUAGES, LATENCY_USE_CASES, LLM_USE_CASES, VOICE_INTENTS, type CopyLanguage, type SvsConfig } from '@svs/shared';

/**
 * Validation for the *effective* config (defaults + overrides). Ranges stop dangerous pushes such as
 * threshold 0 (cards everywhere) or rollout 150% (edge-case CF-04). Every override is validated after merging.
 */
const ms = (min: number, max: number) => z.number().int().min(min).max(max);
const modelId = z.string().trim().min(1).max(100);
const useCaseRecord = <T extends z.ZodType>(schema: T) =>
  z.object(Object.fromEntries(LLM_USE_CASES.map((k) => [k, schema])) as Record<(typeof LLM_USE_CASES)[number], T>);

const KillSwitchRuleSchema = z
  .object({ region: z.string().min(1).optional(), language: z.string().min(1).optional(), cohort: z.string().min(1).optional() })
  .strict()
  .refine((r) => r.region || r.language || r.cohort, 'a kill-switch rule must set at least one of region, language, cohort');

export const SvsConfigSchema = z
  .object({
    enabled: z.boolean(),
    dogfoodCohorts: z.array(z.string().min(1)).max(50),
    killSwitch: z.array(KillSwitchRuleSchema).max(100),
    rolloutPercent: z.number().min(0).max(100),
    experiment: z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), treatmentShare: z.number().min(0).max(1) }).strict(),
    cap: z.object({ perConversation: z.number().int().min(0).max(5), perRollingWeek: z.number().int().min(0).max(20), rollingWindowHours: z.number().int().min(1).max(24 * 30) }).strict(),
    pause: z.object({ consecutiveDismissals: z.number().int().min(1).max(20), days: z.number().int().min(1).max(365) }).strict(),
    classifier: z
      .object({
        timeoutMs: ms(100, 10000),
        thresholds: z.object(Object.fromEntries(VOICE_INTENTS.map((i) => [i, z.number().min(0.5).max(1)]))).strict(),
        precisionTarget: z.number().min(0.5).max(1),
        maxInputChars: z.number().int().min(100).max(20000),
        recentTurns: z.number().int().min(0).max(10),
        languages: z.array(z.enum(CLASSIFIER_LANGUAGES)).min(1).max(CLASSIFIER_LANGUAGES.length),
      })
      .strict(),
    suggestion: z.object({ graceMs: ms(0, 5000) }).strict(),
    voice: z
      .object({
        startBudgetMs: ms(500, 10000),
        openingLineBudgetMs: ms(100, 5000),
        maxDurationS: z.number().int().min(60).max(3600),
        warnBeforeEndS: z.number().int().min(0).max(600),
        noisyTurns: z.number().int().min(1).max(10),
        reconnectMs: ms(0, 60000),
        contextTurns: z.number().int().min(0).max(30),
        endOfSpeechSilenceMs: ms(300, 5000),
        wavlMinSessionS: z.number().int().min(1).max(600),
        serverResumeWindowMs: ms(5000, 600000),
        maxTurnSeconds: z.number().int().min(10).max(300),
        maxTurnAudioBytes: z.number().int().min(100_000).max(25_000_000),
        sttMinAvgLogprob: z.number().min(-5).max(0),
        sttMaxNoSpeechProb: z.number().min(0).max(1),
        coachMaxTokens: z.number().int().min(50).max(2000),
        silenceNudgeMs: ms(3000, 120000),
        silencePauseMs: ms(10000, 600000),
        maxTurnsPerMinute: z.number().int().min(2).max(120),
      })
      .strict(),
    streak: z.object({ goalDays: z.number().int().min(1).max(30) }).strict(),
    copy: z.object({ languages: z.array(z.enum(COPY_LANGUAGES as [CopyLanguage, ...CopyLanguage[]])).min(1).max(COPY_LANGUAGES.length) }).strict(),
    llm: z
      .object({
        provider: z.literal('groq'),
        baseUrl: z.string().url(),
        models: useCaseRecord(z.object({ primary: modelId, fallback: modelId.nullable() }).strict()),
        reasoningEffort: useCaseRecord(z.enum(['low', 'medium', 'high'])),
        timeoutsMs: z
          .object({
            chat: ms(1000, 120000),
            classifier: ms(100, 10000),
            opening: ms(100, 10000),
            coachFirstToken: ms(200, 30000),
            summary: ms(500, 60000),
            streamIdle: ms(1000, 120000),
          })
          .strict(),
        concurrency: useCaseRecord(z.number().int().min(1).max(1000)),
        maxRetries: z.number().int().min(0).max(3),
      })
      .strict(),
    stt: z.object({ provider: z.literal('groq'), model: modelId, fallbackModel: modelId }).strict(),
    tts: z.object({ provider: z.literal('browser'), voices: z.array(z.string().min(2)).min(1) }).strict(),
    analytics: z
      .object({
        pricing: z
          .object({
            models: z.record(modelId, z.object({ inputPerM: z.number().min(0).max(1000), outputPerM: z.number().min(0).max(1000) }).strict()),
            sttPerHour: z.record(modelId, z.number().min(0).max(1000)),
            sttMinBilledS: z.number().min(0).max(600),
          })
          .strict(),
        costBudgetPerWavlUsd: z.number().positive().max(1000).nullable(),
        groqLimits: z
          .object({
            requestsPerMinute: z.number().int().min(1),
            tokensPerMinute: z.number().int().min(1),
            requestsPerDay: z.number().int().min(1),
            tokensPerDay: z.number().int().min(1),
            sttRequestsPerMinute: z.number().int().min(1),
            sttRequestsPerDay: z.number().int().min(1),
            audioSecondsPerHour: z.number().int().min(1),
            warnShare: z.number().min(0.1).max(1),
          })
          .strict(),
        srmPValue: z.number().gt(0).max(0.1),
        alerts: z
          .object({
            intervalMs: z.number().int().min(0).max(24 * 3600_000),
            guardrailWindowDays: z.number().int().min(1).max(60),
            healthWindowMinutes: z.number().int().min(1).max(24 * 60),
            optOutRate: z.number().gt(0).max(1),
            minShownUsers: z.number().int().min(1),
            thumbsDownPValue: z.number().gt(0).max(0.5),
            minFeedbackPerArm: z.number().int().min(1),
            classifierErrorRate: z.number().gt(0).max(1),
            minClassifierCalls: z.number().int().min(1),
            voiceStartP95Ms: ms(100, 60000),
            minVoiceSessions: z.number().int().min(1),
            groq429Rate: z.number().gt(0).max(1),
            groq5xxRate: z.number().gt(0).max(1),
            groqFallbackRate: z.number().gt(0).max(1),
            minGroqCalls: z.number().int().min(1),
            latencyP95Ms: z.object(Object.fromEntries(LATENCY_USE_CASES.map((k) => [k, ms(50, 120000)]))).strict(),
          })
          .strict(),
      })
      .strict(),
    v2: z
      .object({
        previewMode: z.object({ enabled: z.boolean() }).strict(),
        quietMode: z.object({ enabled: z.boolean() }).strict(),
      })
      .strict(),
    ramp: z.object({ experimentId: z.string().regex(/^[a-z0-9_]{1,40}$/), minHoursPerStep: z.number().int().min(0).max(24 * 60), windowDays: z.number().int().min(1).max(60) }).strict(),
    privacy: z.object({ voiceTranscriptRetentionDays: z.number().int().min(1).max(3650), feedbackRetentionDays: z.number().int().min(1).max(3650), purgeIntervalMs: z.number().int().min(0).max(7 * 86_400_000) }).strict(),
  })
  .strict();

export function validateConfig(cfg: SvsConfig): { ok: true } | { ok: false; issues: string[] } {
  const r = SvsConfigSchema.safeParse(cfg);
  return r.success ? { ok: true } : { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

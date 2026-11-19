import type { Db } from '../db';
import type { UsageRecord } from './gateway';

/** Writes one llm_usage row per Groq Whisper call (use_case "stt"). Audio size only, never audio. */
export function sttUsageRecorder(db: Db | null, log?: { warn: (obj: object, msg: string) => void }) {
  return (u: { model: string; status: 'ok' | 'error'; errorKind?: string; latencyMs: number; audioBytes: number; audioSeconds?: number | null; userId?: string; voiceSessionId?: string }) => {
    if (!db) return;
    db.query(
      `INSERT INTO llm_usage (use_case, model, status, error_kind, latency_ms, user_id, voice_session_id, audio_seconds)
       VALUES ('stt', $1, $2, $3, $4, $5, $6, $7)`,
      [u.model, u.status, u.errorKind ?? null, u.latencyMs, u.userId ?? null, u.voiceSessionId ?? null, u.audioSeconds ?? null],
    ).catch((err: unknown) => log?.warn({ err: (err as Error).message }, 'failed to record stt usage'));
  };
}

/** Writes one llm_usage row per Groq call (fire-and-forget; never content). */
export function usageRecorder(db: Db | null, log?: { warn: (obj: object, msg: string) => void }) {
  return (u: UsageRecord) => {
    if (!db) return;
    db.query(
      `INSERT INTO llm_usage (use_case, model, status, error_kind, fallback_used, prompt_tokens, completion_tokens,
         total_tokens, latency_ms, ttft_ms, user_id, conversation_id, voice_session_id, arm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        u.useCase,
        u.model,
        u.status,
        u.errorKind ?? null,
        u.fallbackUsed,
        u.promptTokens,
        u.completionTokens,
        u.totalTokens,
        u.latencyMs,
        u.ttftMs,
        u.ctx.userId ?? null,
        u.ctx.conversationId ?? null,
        u.ctx.voiceSessionId ?? null,
        u.ctx.arm ?? null,
      ],
    ).catch((err: unknown) => log?.warn({ err: (err as Error).message }, 'failed to record llm usage'));
  };
}

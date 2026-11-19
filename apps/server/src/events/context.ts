import { EVENT_CATALOGUE, type ClassifierLanguage, type ClientEventInput, type IntentLabel } from '@svs/shared';
import { detectLanguage } from '../classifier/language';
import type { Queryable } from '../db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ContextResult = { ok: true; intent: IntentLabel | null; language: ClassifierLanguage | null } | { ok: false; reason: string };

/**
 * P6.1: tag a client event with intent and language from the record it refers to, never from the client alone
 * (edge-case EX-05). The record must belong to the same user, so one user can't add events to another's funnel.
 *   suggestion_id    → the suggestion's classified intent + query language
 *   voice_session_id → the session's intent + dominant (else opening) language
 *   message_id       → the answer's suggestion or decision row; else the language of the question it answered
 * Events with no reference keep the client's tags. Events whose spec requires a tag that can't be resolved are rejected.
 */
export async function resolveEventContext(db: Queryable, userId: string, e: ClientEventInput): Promise<ContextResult> {
  const props = e.props ?? {};
  let intent: IntentLabel | null = e.intent_type ?? null;
  let language: ClassifierLanguage | null = e.language ?? null;

  const suggestionId = typeof props.suggestion_id === 'string' ? props.suggestion_id : null;
  const sessionId = typeof props.voice_session_id === 'string' ? props.voice_session_id : null;
  const messageId = typeof props.message_id === 'string' ? props.message_id : null;

  if (sessionId) {
    if (!UUID.test(sessionId)) return { ok: false, reason: 'props.voice_session_id: unknown voice session' };
    const r = await db.query<{ intent: IntentLabel | null; language: ClassifierLanguage | null }>(
      'SELECT intent, COALESCE(dominant_language, language) AS language FROM voice_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId],
    );
    if (!r.rows[0]) return { ok: false, reason: 'props.voice_session_id: unknown voice session' };
    intent = r.rows[0].intent ?? intent;
    language = r.rows[0].language ?? language;
  } else if (suggestionId) {
    const r = await db.query<{ intent: IntentLabel; language: ClassifierLanguage }>('SELECT intent, language FROM suggestions WHERE id = $1 AND user_id = $2', [
      suggestionId,
      userId,
    ]);
    if (!r.rows[0]) return { ok: false, reason: 'props.suggestion_id: unknown suggestion' };
    intent = r.rows[0].intent;
    language = r.rows[0].language;
  } else if (messageId) {
    if (!UUID.test(messageId)) return { ok: false, reason: 'props.message_id: unknown message' };
    const r = await db.query<{ s_intent: IntentLabel | null; s_language: ClassifierLanguage | null; d_intent: IntentLabel | null; d_language: ClassifierLanguage | null; question: string | null }>(
      `SELECT s.intent AS s_intent, s.language AS s_language, d.intent AS d_intent, d.language AS d_language, q.content AS question
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.user_id = $2
         LEFT JOIN suggestions s ON s.message_id = m.id
         LEFT JOIN LATERAL (SELECT intent, language FROM suggestion_decisions WHERE message_id = m.id ORDER BY at DESC LIMIT 1) d ON true
         LEFT JOIN messages q ON q.id = m.reply_to
        WHERE m.id = $1`,
      [messageId, userId],
    );
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'props.message_id: unknown message' };
    intent = row.s_intent ?? row.d_intent ?? null;
    // The language tag is derived here; the question text itself never leaves this function.
    language = row.s_language ?? row.d_language ?? (row.question ? detectLanguage(row.question) : null);
  }

  const spec = EVENT_CATALOGUE[e.event];
  if (spec.intent === 'required' && !intent) return { ok: false, reason: 'intent_type: required for this event' };
  if (spec.language === 'required' && !language) return { ok: false, reason: 'language: required for this event' };
  return { ok: true, intent, language };
}

import { suggestionCard, VOICE_RECAP_MODEL, type ChatMessage, type ConversationSummary, type VoiceIntent } from '@svs/shared';
import type { Db } from '../db';
import { HISTORY_MAX_MESSAGES } from './prompts';

export type SendPlan =
  | { mode: 'new' | 'regenerate'; userMessageId: string; assistantMessageId: string }
  | { mode: 'replay'; userMessageId: string; assistantMessageId: string; content: string; ttftMs: number | null }
  | { mode: 'in_progress'; userMessageId: string };

/** S2 persistence. All queries are scoped by the owning user. */
export class ChatRepo {
  constructor(private readonly db: Db) {}

  async createConversation(userId: string): Promise<ConversationSummary> {
    const { rows } = await this.db.query<ConversationSummary>(
      'INSERT INTO conversations (user_id) VALUES ($1) RETURNING id, title, updated_at',
      [userId],
    );
    return rows[0]!;
  }

  async listConversations(userId: string, limit = 50): Promise<ConversationSummary[]> {
    const { rows } = await this.db.query<ConversationSummary>(
      'SELECT id, title, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
      [userId, limit],
    );
    return rows;
  }

  async getConversation(id: string, userId: string): Promise<{ id: string; title: string | null } | null> {
    const { rows } = await this.db.query<{ id: string; title: string | null }>(
      'SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Messages in order. Assistant messages carry their suggestion card while it is still visible
   * (treatment, shown or tapped); dismissed / opted-out cards stay hidden (edge-case UI-07).
   */
  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const { rows } = await this.db.query<ChatMessage & { s_id: string | null; s_intent: VoiceIntent | null; s_status: 'shown' | 'tapped' | null; s_language: string | null; model: string | null }>(
      `SELECT m.id, m.role, m.content, m.status, m.created_at, m.model, s.id AS s_id, s.intent AS s_intent, s.status AS s_status, s.language AS s_language
       FROM messages m
       LEFT JOIN suggestions s ON s.message_id = m.id AND s.arm = 'treatment' AND s.status IN ('shown', 'tapped')
       WHERE m.conversation_id = $1 AND NOT (m.role = 'assistant' AND m.status = 'error' AND m.content = '')
       ORDER BY m.seq`,
      [conversationId],
    );
    return rows.map(({ s_id, s_intent, s_status, s_language, model, ...m }) => ({
      ...m,
      ...(model === VOICE_RECAP_MODEL ? { kind: 'voice_recap' as const } : {}),
      suggestion: s_id && s_intent && s_status ? { ...suggestionCard(s_id, s_intent, s_language ?? 'en'), status: s_status } : null,
    }));
  }

  /**
   * Idempotent send (P1.4). In one transaction: insert the user message, or, if this client_msg_id was already used,
   * lock it and decide: replay a finished reply, refuse while one is streaming, or regenerate after an error/abort.
   */
  async planSend(conversationId: string, text: string, clientMsgId: string): Promise<SendPlan> {
    return this.db.tx(async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, role, content, client_msg_id) VALUES ($1, 'user', $2, $3)
         ON CONFLICT (conversation_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING RETURNING id`,
        [conversationId, text, clientMsgId],
      );
      let userMessageId = ins.rows[0]?.id;
      let mode: 'new' | 'regenerate' = 'new';
      if (!userMessageId) {
        const existing = await c.query<{ id: string }>(
          'SELECT id FROM messages WHERE conversation_id = $1 AND client_msg_id = $2 FOR UPDATE',
          [conversationId, clientMsgId],
        );
        userMessageId = existing.rows[0]!.id;
        const prev = await c.query<{ id: string; status: string; content: string; ttft_ms: number | null }>(
          'SELECT id, status, content, ttft_ms FROM messages WHERE reply_to = $1 ORDER BY seq DESC LIMIT 1',
          [userMessageId],
        );
        const p = prev.rows[0];
        if (p?.status === 'complete') return { mode: 'replay', userMessageId, assistantMessageId: p.id, content: p.content, ttftMs: p.ttft_ms };
        if (p?.status === 'streaming') return { mode: 'in_progress', userMessageId };
        mode = 'regenerate';
      } else {
        await c.query(
          `UPDATE conversations SET title = COALESCE(title, left(regexp_replace($2, '\\s+', ' ', 'g'), 60)), updated_at = now() WHERE id = $1`,
          [conversationId, text],
        );
      }
      const a = await c.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, role, content, reply_to, status) VALUES ($1, 'assistant', '', $2, 'streaming') RETURNING id`,
        [conversationId, userMessageId],
      );
      return { mode, userMessageId, assistantMessageId: a.rows[0]!.id };
    });
  }

  /** Recent finished turns for the model, oldest first. Errored/aborted/streaming replies are left out. */
  async history(conversationId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const { rows } = await this.db.query<{ role: 'user' | 'assistant'; content: string }>(
      `SELECT role, content FROM messages
       WHERE conversation_id = $1 AND status = 'complete' AND content <> ''
       ORDER BY seq DESC LIMIT $2`,
      [conversationId, HISTORY_MAX_MESSAGES],
    );
    return rows.reverse();
  }

  async finishAssistant(
    id: string,
    fields: { content: string; status: 'complete' | 'aborted' | 'error'; model: string | null; ttftMs: number | null; latencyMs: number },
  ) {
    await this.db.query(
      'UPDATE messages SET content = $2, status = $3, model = $4, ttft_ms = $5, latency_ms = $6 WHERE id = $1',
      [id, fields.content, fields.status, fields.model, fields.ttftMs, fields.latencyMs],
    );
    await this.db.query('UPDATE conversations SET updated_at = now() WHERE id = (SELECT conversation_id FROM messages WHERE id = $1)', [id]);
  }
}

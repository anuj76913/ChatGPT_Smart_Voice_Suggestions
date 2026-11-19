import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MAX_MESSAGE_CHARS, sseEvent, type AnswerErrorCode, type ChatStreamEvent } from '@svs/shared';
import type { Db } from '../db';
import type { LlmGateway } from '../llm/gateway';
import { LlmError } from '../llm/errors';
import type { RateLimiter } from '../rate-limit';
import { buildChatMessages, CHAT_PROMPT_VERSION } from './prompts';
import { ChatRepo } from './repo';
import type { DecideInput, Decision, SuggestionEngine } from '../suggestions/engine';

const IdParams = z.object({ id: z.uuid() });
const SendBody = z.object({
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  client_msg_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

const HEARTBEAT_MS = 15000;

function openSse(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return {
    send: (ev: ChatStreamEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(sseEvent(ev));
    },
    ping: () => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    },
    end: () => {
      if (!res.writableEnded) res.end();
    },
    onClientGone: (fn: () => void) => res.on('close', fn),
  };
}

/**
 * S1/S2 chat routes (architecture §9.1). The answer streams as SSE:
 *   message.accepted → answer.delta* → answer.complete | answer.error → stream.end
 * A `suggestion` event (Phase 3) may follow answer.complete, before stream.end.
 */
export function registerChatRoutes(
  app: FastifyInstance,
  deps: { db: Db | null; gateway: LlmGateway | null; limiter: RateLimiter; suggestions: SuggestionEngine | null; graceMs: () => number },
) {
  const repo = () => (deps.db ? new ChatRepo(deps.db) : null);

  app.post('/v1/conversations', { preHandler: app.authenticate }, async (req, reply) => {
    const r = repo();
    if (!r) return reply.code(503).send({ error: 'database_unavailable' });
    return reply.code(201).send(await r.createConversation(req.user!.id));
  });

  app.get('/v1/conversations', { preHandler: app.authenticate }, async (req, reply) => {
    const r = repo();
    if (!r) return reply.code(503).send({ error: 'database_unavailable' });
    return { conversations: await r.listConversations(req.user!.id) };
  });

  app.get('/v1/conversations/:id/messages', { preHandler: app.authenticate }, async (req, reply) => {
    const r = repo();
    if (!r) return reply.code(503).send({ error: 'database_unavailable' });
    const p = IdParams.safeParse(req.params);
    if (!p.success || !(await r.getConversation(p.data.id, req.user!.id))) return reply.code(404).send({ error: 'not_found' });
    return { messages: await r.listMessages(p.data.id) };
  });

  app.post('/v1/conversations/:id/messages', { preHandler: app.authenticate }, async (req, reply) => {
    const r = repo();
    if (!r) return reply.code(503).send({ error: 'database_unavailable' });
    if (!deps.gateway) return reply.code(503).send({ error: 'llm_unavailable' });
    const user = req.user!;
    const limited = deps.limiter.take(`chat:${user.id}`);
    if (!limited.ok) return reply.code(429).header('retry-after', limited.retryAfterS).send({ error: 'rate_limited' });
    const p = IdParams.safeParse(req.params);
    if (!p.success || !(await r.getConversation(p.data.id, user.id))) return reply.code(404).send({ error: 'not_found' });
    const body = SendBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues.map((i) => i.message) });

    const plan = await r.planSend(p.data.id, body.data.text, body.data.client_msg_id);
    const sse = openSse(reply);
    sse.send({ type: 'message.accepted', user_message_id: plan.userMessageId, replay: plan.mode === 'replay' });

    if (plan.mode === 'replay') {
      sse.send({ type: 'answer.delta', message_id: plan.assistantMessageId, text: plan.content });
      sse.send({ type: 'answer.complete', message_id: plan.assistantMessageId, ttft_ms: plan.ttftMs });
      sse.send({ type: 'stream.end' });
      return sse.end();
    }
    if (plan.mode === 'in_progress') {
      sse.send({ type: 'answer.error', message_id: null, code: 'in_progress', retryable: true });
      sse.send({ type: 'stream.end' });
      return sse.end();
    }

    const start = Date.now();
    const abort = new AbortController();
    let finished = false;
    sse.onClientGone(() => {
      if (!finished) abort.abort();
    });
    const heartbeat = setInterval(sse.ping, HEARTBEAT_MS);
    let text = '';
    let model: string | null = null;
    let ttftMs: number | null = null;
    let answered = false;
    let decisionInput: DecideInput | null = null;
    let decision: Promise<Decision> | null = null;
    try {
      const history = await r.history(p.data.id);
      // S4 runs in parallel with the answer and never blocks it (architecture §5.1, D1). decide() never rejects.
      if (deps.suggestions) {
        decisionInput = {
          user,
          conversationId: p.data.id,
          messageId: plan.assistantMessageId,
          query: body.data.text,
          recentTurns: history.slice(0, -1).slice(-2).map((m) => ({ role: m.role, text: m.content })),
        };
        decision = deps.suggestions.decide(decisionInput);
      }
      const messages = buildChatMessages(history);
      for await (const chunk of deps.gateway.stream('chat', { messages, maxTokens: 2048 }, { userId: user.id, conversationId: p.data.id }, abort.signal)) {
        if (chunk.type === 'delta') {
          text += chunk.text;
          sse.send({ type: 'answer.delta', message_id: plan.assistantMessageId, text: chunk.text });
        } else {
          model = chunk.model;
          ttftMs = chunk.ttftMs;
        }
      }
      await r.finishAssistant(plan.assistantMessageId, { content: text, status: 'complete', model, ttftMs, latencyMs: Date.now() - start });
      req.log.info({ messageId: plan.assistantMessageId, model, ttftMs, promptVersion: CHAT_PROMPT_VERSION }, 'chat answer complete');
      sse.send({ type: 'answer.complete', message_id: plan.assistantMessageId, ttft_ms: ttftMs });
      answered = true;
    } catch (err) {
      const aborted = abort.signal.aborted;
      await r
        .finishAssistant(plan.assistantMessageId, { content: text, status: aborted ? 'aborted' : 'error', model, ttftMs, latencyMs: Date.now() - start })
        .catch(() => {});
      if (!aborted) {
        const kind = err instanceof LlmError ? err.kind : 'internal';
        const code: AnswerErrorCode = kind === 'rate_limited' || kind === 'busy' ? 'rate_limited' : kind === 'internal' ? 'internal' : 'llm_unavailable';
        req.log.warn({ kind, partial: err instanceof LlmError ? err.details.partial : undefined }, 'chat answer failed');
        sse.send({ type: 'answer.error', message_id: plan.assistantMessageId, code, retryable: true });
      }
    } finally {
      if (decision && decisionInput && deps.suggestions) {
        await deliverSuggestion(deps.suggestions, decisionInput, decision, answered && !abort.signal.aborted, deps.graceMs(), sse.send);
      }
      finished = true;
      clearInterval(heartbeat);
      sse.send({ type: 'stream.end' });
      sse.end();
    }
  });
}

/**
 * P3.4: the card is sent only after answer.complete and only if the decision is ready within the grace window.
 * Late or failed answers never produce a card or an impression; a late eligible decision is kept as `late` for analysis.
 */
async function deliverSuggestion(
  engine: SuggestionEngine,
  input: DecideInput,
  pending: Promise<Decision>,
  answered: boolean,
  graceMs: number,
  send: (e: ChatStreamEvent) => void,
) {
  if (!answered) {
    void pending.then((d) => engine.recordOutcome(input, 'answer_failed', d));
    return;
  }
  const LATE = Symbol('late');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([pending, new Promise<typeof LATE>((resolve) => (timer = setTimeout(() => resolve(LATE), graceMs)))]);
  clearTimeout(timer);
  if (raced === LATE) {
    void pending.then(async (d) => {
      if (d.eligible) await engine.recordLate(input, d);
      engine.recordOutcome(input, d.eligible ? 'late' : d.reason, d);
    });
    return;
  }
  const d = raced;
  if (!d.eligible) return engine.recordOutcome(input, d.reason, d);
  const { send: show, outcome } = await engine.commit(input, d);
  engine.recordOutcome(input, outcome, d);
  if (show) send({ type: 'suggestion', message_id: input.messageId, ...d.card });
}

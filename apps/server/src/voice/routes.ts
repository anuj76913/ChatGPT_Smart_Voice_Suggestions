import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VoiceSummaries } from './summary';
import { z } from 'zod';
import { ENTRY_POINTS, VOICE_INTENTS } from '@svs/shared';
import type { RateLimiter } from '../rate-limit';
import { VoiceError, type VoiceOrchestrator } from './orchestrator';
import { streamTokenUser, verifyStreamToken } from './token';

const CreateBody = z
  .object({
    intent: z.enum(VOICE_INTENTS),
    entry_point: z.enum(ENTRY_POINTS),
    conversation_id: z.uuid().optional(),
    suggestion_id: z.string().regex(/^sg_[0-9a-f-]{36}$/).optional(),
    next_activity_index: z.number().int().min(0).max(10).optional(),
  })
  .strict();
const IdParams = z.object({ id: z.uuid() });
const EndBody = z.object({ reason: z.enum(['user', 'idle']).optional() }).strict();

/**
 * Voice session API (architecture §9.3, implementation-plan P4.4 / P4.9):
 *   POST /v1/voice/sessions                         create (preset + chat context + opening line)
 *   GET  /v1/voice/sessions/:id/stream?token=…      WebSocket turn loop (cookie AND short-lived token)
 *   POST /v1/voice/sessions/:id/end                 end → stats
 *   POST /v1/voice/sessions/:id/continue-in-text    end + recap appended to the conversation
 *   GET  /v1/voice/sessions/:id/summary             Phase 5: duration, questions, tip, streak, next activity
 *   POST /v1/voice/sessions/:id/recap               Phase 5: "Back to Chat" appends a short recap (idempotent)
 */
export function registerVoiceRoutes(
  app: FastifyInstance,
  deps: {
    voice: VoiceOrchestrator | null;
    summaries: VoiceSummaries | null;
    secret: string;
    limiter: RateLimiter;
    /** Split hosting: the stream token alone identifies the user (env VOICE_WS_TOKEN_ONLY). */
    wsTokenOnly?: boolean;
  },
) {
  const unavailable = { error: 'voice_unavailable' };

  const summaryRoute = (handler: (id: string, userId: string) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.summaries) return reply.code(503).send(unavailable);
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await handler(p.data.id, req.user!.id);
    } catch (err) {
      if (err instanceof VoiceError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  };
  app.get('/v1/voice/sessions/:id/summary', { preHandler: app.authenticate }, summaryRoute((id, uid) => deps.summaries!.get(id, uid)));
  app.post('/v1/voice/sessions/:id/recap', { preHandler: app.authenticate }, summaryRoute((id, uid) => deps.summaries!.recap(id, uid)));

  app.post('/v1/voice/sessions', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.voice) return reply.code(503).send(unavailable);
    if (!deps.limiter.take(`voice:${req.user!.id}`).ok) return reply.code(429).send({ error: 'rate_limited' });
    const body = CreateBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues.map((i) => i.message) });
    try {
      return reply.code(201).send(await deps.voice.create(req.user!, body.data));
    } catch (err) {
      if (err instanceof VoiceError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  });

  app.post('/v1/voice/sessions/:id/end', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.voice) return reply.code(503).send(unavailable);
    const p = IdParams.safeParse(req.params);
    const b = EndBody.safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await deps.voice.end(p.data.id, b.data.reason ?? 'user', req.user!.id);
    } catch (err) {
      if (err instanceof VoiceError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  });

  app.post('/v1/voice/sessions/:id/continue-in-text', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.voice) return reply.code(503).send(unavailable);
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await deps.voice.continueInText(p.data.id, req.user!.id);
    } catch (err) {
      if (err instanceof VoiceError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  });

  app.get('/v1/voice/sessions/:id/stream', { websocket: true, ...(deps.wsTokenOnly ? {} : { preHandler: app.authenticate }) }, (socket, req) => {
    const p = IdParams.safeParse(req.params);
    const q = req.query as { token?: string; last_turn_id?: string };
    const userId = !p.success ? null : deps.wsTokenOnly ? streamTokenUser(deps.secret, q.token, p.data.id) : req.user!.id;
    if (!deps.voice || !p.success || !userId || !verifyStreamToken(deps.secret, q.token, p.data.id, userId) || !deps.voice.owns(p.data.id, userId)) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const user = { id: userId };
    const sessionId = p.data.id;
    const voice = deps.voice;
    voice.attach(sessionId, user.id, socket, q.last_turn_id ?? null);
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      void voice.onMessage(sessionId, isBinary ? buf : buf.toString('utf8'), isBinary).catch((err: unknown) => req.log.warn({ err: (err as Error).message }, 'voice message failed'));
    });
    socket.on('close', () => voice.detach(sessionId, socket));
  });
}

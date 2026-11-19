import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConfigService } from '../config/service';
import type { Db } from '../db';
import type { RateLimiter } from '../rate-limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ConsentBody = z.object({ granted: z.boolean() }).strict();
const FeedbackBody = z
  .object({
    kind: z.enum(['bug', 'idea', 'other']),
    text: z.string().trim().min(1).max(1000),
    screen: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
    voice_session_id: z.string().regex(UUID).optional(),
    message_id: z.string().regex(UUID).optional(),
  })
  .strict();
const TriageBody = z.object({ status: z.enum(['open', 'triaged', 'closed']), triage: z.string().trim().max(500).optional() }).strict();

/**
 * Phase 8 dogfood APIs:
 *   POST /v1/me/research-consent   P8.2: a participant allows (or declines) review of their queries for labelling
 *   POST /v1/feedback              P8.3: "Report a problem" (dogfood cohort and admins only)
 *   GET  /v1/admin/feedback        P8.3: triage list · PATCH /v1/admin/feedback/:id  set status / triage note
 */
export function registerDogfoodRoutes(app: FastifyInstance, deps: { db: Db | null; config: ConfigService; limiter: RateLimiter }) {
  const isDogfood = (req: FastifyRequest) => !!req.user?.cohort && deps.config.get().dogfoodCohorts.includes(req.user.cohort);

  app.post('/v1/me/research-consent', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    const body = ConsentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const value = body.data.granted ? 'granted' : 'declined';
    await deps.db.query('UPDATE users SET research_consent = $2, research_consent_at = now() WHERE id = $1', [req.user!.id, value]);
    return { research_consent: value };
  });

  app.post('/v1/feedback', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    if (!isDogfood(req) && !req.user!.is_admin) return reply.code(403).send({ error: 'dogfood_only' });
    if (!deps.limiter.take(`feedback:${req.user!.id}`).ok) return reply.code(429).send({ error: 'rate_limited' });
    const body = FeedbackBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const b = body.data;
    // Keep references only if they belong to this user (no pointing at other people's sessions).
    const own = async (sql: string, id?: string) => (id ? ((await deps.db!.query(sql, [id, req.user!.id])).rowCount ? id : null) : null);
    const vs = await own('SELECT 1 FROM voice_sessions WHERE id = $1 AND user_id = $2', b.voice_session_id);
    const msg = await own('SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 AND c.user_id = $2', b.message_id);
    const r = await deps.db.query<{ id: string }>(
      `INSERT INTO feedback_reports (user_id, kind, text, screen, voice_session_id, message_id, app_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
      [req.user!.id, b.kind, b.text, b.screen ?? null, vs, msg, String(req.headers['x-app-version'] ?? '').slice(0, 32) || null],
    );
    return reply.code(201).send({ id: r.rows[0]!.id });
  });

  app.get('/v1/admin/feedback', { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.user!.is_admin) return reply.code(403).send({ error: 'forbidden' });
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    const status = (req.query as { status?: string }).status;
    const { rows } = await deps.db.query(
      `SELECT f.id::text, f.created_at, f.kind, f.text, f.screen, f.voice_session_id, f.message_id, f.app_version, f.status, f.triage, u.handle
         FROM feedback_reports f JOIN users u ON u.id = f.user_id
        WHERE ($1::text IS NULL OR f.status = $1) ORDER BY f.created_at DESC LIMIT 200`,
      [status && ['open', 'triaged', 'closed'].includes(status) ? status : null],
    );
    return { reports: rows };
  });

  app.patch('/v1/admin/feedback/:id', { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.user!.is_admin) return reply.code(403).send({ error: 'forbidden' });
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    const id = (req.params as { id: string }).id;
    const body = TriageBody.safeParse(req.body);
    if (!/^\d{1,18}$/.test(id) || !body.success) return reply.code(400).send({ error: 'invalid_body' });
    const r = await deps.db.query('UPDATE feedback_reports SET status = $2, triage = COALESCE($3, triage) WHERE id = $1', [id, body.data.status, body.data.triage ?? null]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}

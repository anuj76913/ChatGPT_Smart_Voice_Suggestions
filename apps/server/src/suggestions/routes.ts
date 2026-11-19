import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { VoicePreferences } from '@svs/shared';
import type { ConfigService } from '../config/service';
import type { Db } from '../db';
import type { RateLimiter } from '../rate-limit';

const IdParams = z.object({ id: z.string().regex(/^sg_[0-9a-f-]{36}$/) });
const PrefsBody = z
  .object({
    suggestions_enabled: z.boolean().optional(),
    voice_speed: z.enum(['slow', 'normal', 'fast']).optional(),
    voice_quiet: z.boolean().optional(),
    voice_accent: z.enum(['en-IN', 'hi-IN']).optional(),
    /** When opting out from a card, the card it came from (marked opted_out). */
    suggestion_id: z.string().regex(/^sg_[0-9a-f-]{36}$/).optional(),
  })
  .strict();

const PREFS_SQL =
  "SELECT suggestions_enabled, CASE WHEN paused_until > now() THEN paused_until END AS paused_until, voice_speed, voice_accent, (privacy_notice_seen_at IS NOT NULL) AS privacy_notice_seen, quiet_mode AS voice_quiet FROM voice_prefs WHERE user_id = $1";

/**
 * Card actions and voice preferences (FR-4, FR-5; architecture §9.2). All scoped to the signed-in user (SEC-04).
 * - dismiss: counts once per card (SEC-03); 3 in a row → 14-day pause, counter reset
 * - tap: resets the consecutive-dismissal counter
 * - opt-out / opt-in: immediate; opting back in also clears an active pause (ADR-008)
 */
export function registerSuggestionRoutes(app: FastifyInstance, deps: { db: Db | null; config: ConfigService; limiter: RateLimiter }) {
  const guard = (userId: string) => deps.limiter.take(`sg:${userId}`);

  app.post('/v1/suggestions/:id/dismiss', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    if (!guard(req.user!.id).ok) return reply.code(429).send({ error: 'rate_limited' });
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const cfg = deps.config.get();
    const out = await deps.db.tx(async (c) => {
      const owned = await c.query<{ status: string }>('SELECT status FROM suggestions WHERE id = $1 AND user_id = $2 FOR UPDATE', [p.data.id, req.user!.id]);
      if (!owned.rows[0]) return null;
      if (owned.rows[0].status !== 'shown') return { counted: false };
      await c.query("UPDATE suggestions SET status = 'dismissed' WHERE id = $1", [p.data.id]);
      const r = await c.query<{ n: number }>(
        `INSERT INTO voice_prefs (user_id, consecutive_dismissals) VALUES ($1, 1)
         ON CONFLICT (user_id) DO UPDATE SET consecutive_dismissals = voice_prefs.consecutive_dismissals + 1, updated_at = now()
         RETURNING consecutive_dismissals AS n`,
        [req.user!.id],
      );
      const n = r.rows[0]!.n;
      if (n >= cfg.pause.consecutiveDismissals) {
        await c.query("UPDATE voice_prefs SET consecutive_dismissals = 0, paused_until = now() + make_interval(days => $2), updated_at = now() WHERE user_id = $1", [
          req.user!.id,
          cfg.pause.days,
        ]);
        return { counted: true, consecutive_dismissals: n, paused: true };
      }
      return { counted: true, consecutive_dismissals: n, paused: false };
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return out;
  });

  app.post('/v1/suggestions/:id/tap', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    if (!guard(req.user!.id).ok) return reply.code(429).send({ error: 'rate_limited' });
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const out = await deps.db.tx(async (c) => {
      const owned = await c.query<{ status: string; intent: string }>('SELECT status, intent FROM suggestions WHERE id = $1 AND user_id = $2 FOR UPDATE', [p.data.id, req.user!.id]);
      if (!owned.rows[0]) return null;
      if (owned.rows[0].status === 'shown') await c.query("UPDATE suggestions SET status = 'tapped' WHERE id = $1", [p.data.id]);
      await c.query('UPDATE voice_prefs SET consecutive_dismissals = 0, updated_at = now() WHERE user_id = $1', [req.user!.id]);
      return { tapped: true, intent: owned.rows[0].intent };
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return out;
  });

  app.get('/v1/me/voice-preferences', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    await deps.db.query('INSERT INTO voice_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user!.id]);
    return (await deps.db.query<VoicePreferences>(PREFS_SQL, [req.user!.id])).rows[0];
  });

  // FR-6: the first-use privacy notice was shown and accepted (once per account, edge-case PM-04).
  app.post('/v1/me/privacy-notice-ack', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    await deps.db.query(
      `INSERT INTO voice_prefs (user_id, privacy_notice_seen_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET privacy_notice_seen_at = COALESCE(voice_prefs.privacy_notice_seen_at, now()), updated_at = now()`,
      [req.user!.id],
    );
    return { privacy_notice_seen: true };
  });

  app.put('/v1/me/voice-preferences', { preHandler: app.authenticate }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    if (!guard(req.user!.id).ok) return reply.code(429).send({ error: 'rate_limited' });
    const b = PrefsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid_body', issues: b.error.issues.map((i) => i.message) });
    const { suggestions_enabled, voice_speed, voice_accent, voice_quiet, suggestion_id } = b.data;
    const userId = req.user!.id;
    await deps.db.tx(async (c) => {
      await c.query('INSERT INTO voice_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
      if (suggestions_enabled === false) {
        await c.query('UPDATE voice_prefs SET suggestions_enabled = false, updated_at = now() WHERE user_id = $1', [userId]);
        if (suggestion_id) await c.query("UPDATE suggestions SET status = 'opted_out' WHERE id = $1 AND user_id = $2 AND status = 'shown'", [suggestion_id, userId]);
      } else if (suggestions_enabled === true) {
        // An explicit opt-in overrides an active pause and the dismissal streak (decisions.md ADR-008, edge-case ST-02).
        await c.query('UPDATE voice_prefs SET suggestions_enabled = true, paused_until = NULL, consecutive_dismissals = 0, updated_at = now() WHERE user_id = $1', [userId]);
      }
      if (voice_speed) await c.query('UPDATE voice_prefs SET voice_speed = $2, updated_at = now() WHERE user_id = $1', [userId, voice_speed]);
      if (typeof voice_quiet === 'boolean') await c.query('UPDATE voice_prefs SET quiet_mode = $2, updated_at = now() WHERE user_id = $1', [userId, voice_quiet]);
      if (voice_accent) await c.query('UPDATE voice_prefs SET voice_accent = $2, updated_at = now() WHERE user_id = $1', [userId, voice_accent]);
    });
    return (await deps.db.query<VoicePreferences>(PREFS_SQL, [userId])).rows[0];
  });
}

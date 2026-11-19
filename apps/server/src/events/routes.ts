import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_EVENTS_PER_BATCH } from '@svs/shared';
import type { Db } from '../db';
import type { ConfigService } from '../config/service';
import type { RateLimiter } from '../rate-limit';
import { resolveEventContext } from './context';
import { EventStore } from './store';
import { validateClientEvent } from './validate';

const Batch = z.object({ events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH) });

/** POST /v1/events: batched client events (C7 → S12). Each event is validated on its own. */
export function registerEventRoutes(app: FastifyInstance, deps: { db: Db | null; config: ConfigService; limiter: RateLimiter }) {
  app.post('/v1/events', { preHandler: app.authenticate, bodyLimit: 256 * 1024 }, async (req, reply) => {
    if (!deps.db) return reply.code(503).send({ error: 'database_unavailable' });
    const limited = deps.limiter.take(`events:${req.user!.id}`);
    if (!limited.ok) return reply.code(429).header('retry-after', limited.retryAfterS).send({ error: 'rate_limited' });
    const parsed = Batch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues.map((i) => i.message) });

    const store = new EventStore(deps.db);
    const enrichment = await store.enrichment(req.user!, deps.config.get().experiment.id);
    let accepted = 0;
    let duplicates = 0;
    const rejected: Array<{ index: number; event_id: string | null; reason: string }> = [];
    for (const [index, raw] of parsed.data.events.entries()) {
      const v = validateClientEvent(raw);
      if (!v.ok) {
        const id = (raw as { event_id?: unknown })?.event_id;
        rejected.push({ index, event_id: typeof id === 'string' ? id : null, reason: v.reason });
        continue;
      }
      // Intent and language come from the referenced suggestion / session / message (P6.1, EX-05).
      const ctx = await resolveEventContext(deps.db, req.user!.id, v.event);
      if (!ctx.ok) {
        rejected.push({ index, event_id: v.event.event_id, reason: ctx.reason });
        continue;
      }
      if (await store.insertClient({ ...v.event, intent_type: ctx.intent, language: ctx.language }, enrichment)) accepted++;
      else duplicates++;
    }
    return { accepted, duplicates, rejected };
  });
}

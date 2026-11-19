import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cardIntent, MAX_MESSAGE_CHARS } from '@svs/shared';
import type { ConfigService } from '../config/service';
import type { Classifier } from './classifier';
import { prefilter } from './prefilter';

const Body = z.object({
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  recent_turns: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(MAX_MESSAGE_CHARS) })).max(10).optional(),
});

/**
 * Admin-only classifier probe: shows what S3 decides for a message and whether a card would show at the
 * current thresholds. For manual testing and threshold debugging; the chat path calls the classifier itself (Phase 3).
 */
export function registerClassifierRoutes(app: FastifyInstance, deps: { classifier: Classifier | null; config: ConfigService }) {
  app.post('/v1/admin/classify', { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.user!.is_admin) return reply.code(403).send({ error: 'forbidden' });
    if (!deps.classifier) return reply.code(503).send({ error: 'llm_unavailable' });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues.map((i) => i.message) });
    const result = await deps.classifier.classify({ query: body.data.text, recentTurns: body.data.recent_turns }, { userId: req.user!.id });
    const thresholds = deps.config.get().classifier.thresholds;
    return { result, prefilter: prefilter(body.data.text), card: cardIntent(result, thresholds), thresholds };
  });
}

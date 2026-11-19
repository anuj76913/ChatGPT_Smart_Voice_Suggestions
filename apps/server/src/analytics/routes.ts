import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConfigService } from '../config/service';
import type { Db } from '../db';
import type { RateLimiter } from '../rate-limit';
import type { AlertEvaluator } from './alerts';
import { decideExperiment } from './decision';
import { buildReport } from './report';

const Query = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    /** An experiment id, or "all" for all traffic (dogfood included). Defaults to the configured experiment. */
    experiment_id: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
    include_test: z.enum(['true', 'false']).optional(),
  })
  .strict();

/** P6.3 admin analytics API: the dashboard's data, the PRD decision, and on-demand alert evaluation. Admins only. */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: { db: Db | null; config: ConfigService; alerts: AlertEvaluator | null; limiter: RateLimiter }) {
  const guard = (req: { user?: { id: string; is_admin: boolean } | null }) => {
    if (!req.user?.is_admin) return { code: 403, error: 'forbidden' } as const;
    if (!deps.db) return { code: 503, error: 'database_unavailable' } as const;
    if (!deps.limiter.take(`analytics:${req.user.id}`).ok) return { code: 429, error: 'rate_limited' } as const;
    return null;
  };

  const window = (q: z.infer<typeof Query>) => {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 28 * 86_400_000);
    const exp = q.experiment_id ?? deps.config.get().experiment.id;
    return { from, to, experimentId: exp === 'all' ? null : exp, includeTest: q.include_test === 'true' };
  };

  app.get('/v1/admin/analytics/report', { preHandler: app.authenticate }, async (req, reply) => {
    const no = guard(req);
    if (no) return reply.code(no.code).send({ error: no.error });
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const w = window(q.data);
    if (!(w.from < w.to) || w.to.getTime() - w.from.getTime() > 366 * 86_400_000) return reply.code(400).send({ error: 'invalid_window' });
    const cfg = deps.config.get();
    const report = await buildReport(deps.db!, w, cfg);
    return { report, decision: report.experiment ? decideExperiment(report, cfg) : null };
  });

  app.post('/v1/admin/analytics/alerts/evaluate', { preHandler: app.authenticate }, async (req, reply) => {
    const no = guard(req);
    if (no) return reply.code(no.code).send({ error: no.error });
    if (!deps.alerts) return reply.code(503).send({ error: 'alerts_unavailable' });
    const r = await deps.alerts.run();
    if (!r) return reply.code(409).send({ error: 'evaluation_in_progress' });
    return { results: r.results, opened: r.opened.map((o) => (o.key ? `${o.rule}:${o.key}` : o.rule)), resolved: r.resolved };
  });
}

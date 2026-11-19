import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_MESSAGE_CHARS, type ClientConfig } from '@svs/shared';
import { ConfigValidationError, type ConfigService } from './service';
import { evaluateSuggestionGate } from './gate';

const OverridesBody = z.object({
  overrides: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(3).max(500),
});

/** Client config (C8 cache, P1.9) and the admin API for runtime config (S7, P1.6). */
export function registerConfigRoutes(app: FastifyInstance, deps: { config: ConfigService }) {
  const { config } = deps;

  // Client-safe values only. Short TTL; never authoritative for the kill switch (the server re-checks).
  app.get('/v1/config/client', { preHandler: app.authenticate }, async (): Promise<ClientConfig> => {
    const cfg = config.get();
    return {
      ttl_seconds: 60,
      copy_languages: cfg.copy.languages,
      max_message_chars: MAX_MESSAGE_CHARS,
      features: { preview_mode: cfg.v2.previewMode.enabled, quiet_mode: cfg.v2.quietMode.enabled },
    };
  });

  app.get('/v1/admin/config', { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.user!.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const u = req.user!;
    return {
      version: config.getVersion(),
      fresh: config.isFresh(),
      overrides: config.getOverrides(),
      effective: config.get(),
      // Shows how the gate treats the calling admin, to sanity-check kill-switch / rollout changes.
      gate_for_me: evaluateSuggestionGate(config.get(), { userId: u.id, region: u.region, language: u.primary_language, cohort: u.cohort }, { fresh: config.isFresh() }),
      audit: await config.audit(20),
    };
  });

  app.put('/v1/admin/config/overrides', { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.user!.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const parsed = OverridesBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues.map((i) => i.message) });
    try {
      const out = await config.setOverrides(parsed.data.overrides as never, req.user!.handle, parsed.data.reason);
      return { version: out.version, effective: out.effective };
    } catch (err) {
      if (err instanceof ConfigValidationError) return reply.code(400).send({ error: 'invalid_config', issues: err.issues });
      throw err;
    }
  });
}

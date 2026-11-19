import type { FastifyError, FastifyInstance } from 'fastify';
import type { Env } from './env';

/**
 * P7.4 HTTP hardening, applied to every route:
 *  - route inventory (for the "auth on every endpoint" test)
 *  - Origin check on state-changing requests and WebSocket upgrades (defence in depth on top of SameSite=Lax)
 *  - security headers on every response (no caching of API data, no sniffing, no framing, HSTS outside local/test)
 *  - errors never leak internals: 5xx → {error:"internal_error"}, 4xx → a short code; details only in the server log
 */
export interface RouteInfo {
  method: string;
  url: string;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerSecurity(app: FastifyInstance, env: Env) {
  const routes: RouteInfo[] = [];
  app.decorate('routeInventory', routes);
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push({ method: m, url: r.url });
  });

  const allowed = new Set([new URL(env.WEB_ORIGIN).origin]);
  app.addHook('onRequest', async (req, reply) => {
    const isUpgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    if (!UNSAFE.has(req.method) && !isUpgrade) return;
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients (curl, server-to-server, tests) send none
    // Same-origin requests (also through the dev proxy, which keeps the Host header) are always fine.
    const self = `${req.protocol}://${req.headers.host ?? ''}`;
    if (origin === self || allowed.has(origin)) return;
    req.log.warn({ origin }, 'blocked cross-origin request');
    return reply.code(403).send({ error: 'forbidden_origin' });
  });

  const hsts = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    if (req.url.startsWith('/v1/')) reply.header('cache-control', 'no-store');
    if (hsts) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err: { message: err.message, code: err.code } }, 'request failed');
      return reply.code(status).send({ error: 'internal_error' });
    }
    // Client errors (bad JSON, body too large, wrong content type…): a stable code, never the parser's message.
    const code = (err.code ?? 'bad_request').toLowerCase().replace(/^fst_err_/, '').replace(/[^a-z0-9_]/g, '_').slice(0, 40);
    return reply.code(status).send({ error: code });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every registered route (method + URL pattern), for the P7.4 auth audit. */
    routeInventory: RouteInfo[];
  }
}

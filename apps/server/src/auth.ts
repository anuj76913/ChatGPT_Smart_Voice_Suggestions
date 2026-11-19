import type {} from '@fastify/cookie'; // cookie request/reply typings used below
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Me } from '@svs/shared';
import type { Db } from './db';
import type { Env } from './env';
import type { RateLimiter } from './rate-limit';

/**
 * Dev login (decisions.md ADR-010, MVP default): a user picks a handle and gets a signed, httpOnly session
 * cookie holding their user id and a session epoch. No password. Disabled in production unless ALLOW_DEV_LOGIN=true.
 * Logout bumps the epoch, which revokes every earlier cookie for that user (P7.4).
 * Replace with real sign-in later without touching the routes: only `authenticate` reads the cookie.
 */
export const SESSION_COOKIE = 'svs_session';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

export interface AuthUser {
  id: string;
  handle: string;
  display_name: string;
  region: string;
  tier: string | null;
  primary_language: string | null;
  cohort: string | null;
  timezone: string;
  research_consent: 'granted' | 'declined' | null;
  is_admin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const LoginBody = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{2,32}$/, '2–32 characters: letters, digits, dot, dash or underscore'),
  display_name: z.string().trim().min(1).max(60).optional(),
});

export const toMe = (u: AuthUser, dogfoodCohorts: string[] = []): Me => ({
  id: u.id,
  handle: u.handle,
  display_name: u.display_name,
  is_admin: u.is_admin,
  cohort: u.cohort,
  is_dogfood: !!u.cohort && dogfoodCohorts.includes(u.cohort),
  research_consent: u.research_consent,
});

export function registerAuth(app: FastifyInstance, deps: { env: Env; db: Db | null; loginLimiter: RateLimiter; dogfoodCohorts?: () => string[] }) {
  const { env, db } = deps;

  const loadUser = async (id: string, epoch?: number): Promise<AuthUser | null> => {
    if (!db) return null;
    const { rows } = await db.query<Omit<AuthUser, 'is_admin'> & { session_epoch: number }>(
      'SELECT id, handle, display_name, region, tier, primary_language, cohort, timezone, research_consent, session_epoch FROM users WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row || (epoch !== undefined && row.session_epoch !== epoch)) return null;
    const { session_epoch: _epoch, ...u } = row;
    return { ...u, is_admin: env.adminHandles.has(u.handle) };
  };

  /** Cookie value "<uuid>.<epoch>" → parts, or null. */
  const parseSession = (req: FastifyRequest): { id: string; epoch: number } | null => {
    const raw = req.cookies[SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    const m = unsigned?.valid && unsigned.value ? /^([0-9a-f-]{36})\.(\d{1,9})$/.exec(unsigned.value) : null;
    return m ? { id: m[1]!, epoch: Number(m[2]) } : null;
  };

  /** preHandler: 401 unless a valid signed session cookie names an existing user. */
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const s = parseSession(req);
    const user = s ? await loadUser(s.id, s.epoch) : null;
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    req.user = user;
  });

  app.post('/v1/auth/dev-login', async (req, reply) => {
    if (!env.allowDevLogin) return reply.code(404).send({ error: 'not_found' });
    if (!db) return reply.code(503).send({ error: 'database_unavailable' });
    const limited = deps.loginLimiter.take(req.ip);
    if (!limited.ok) return reply.code(429).header('retry-after', limited.retryAfterS).send({ error: 'rate_limited' });
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const { handle, display_name } = parsed.data;
    const cohort = env.APP_ENV === 'production' ? null : env.APP_ENV; // local/test/staging users are tagged by env
    const { rows } = await db.query<{ id: string; session_epoch: number }>(
      `INSERT INTO users (handle, display_name, cohort, is_test)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (handle) DO UPDATE SET display_name = COALESCE($5, users.display_name)
       RETURNING id, session_epoch`,
      [handle, display_name ?? handle, cohort, env.APP_ENV === 'test', display_name ?? null],
    );
    const id = rows[0]!.id;
    const epoch = rows[0]!.session_epoch;
    await db.query('INSERT INTO voice_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    reply.setCookie(SESSION_COOKIE, `${id}.${epoch}`, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: env.APP_ENV === 'staging' || env.APP_ENV === 'production',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    const user = await loadUser(id);
    return toMe(user!, deps.dogfoodCohorts?.());
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    // Revoke server-side too: a copied cookie stops working once the user logs out (P7.4).
    const s = parseSession(req);
    if (s && db) await db.query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1 AND session_epoch = $2', [s.id, s.epoch]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/v1/me', { preHandler: app.authenticate }, async (req) => toMe(req.user!, deps.dogfoodCohorts?.()));
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

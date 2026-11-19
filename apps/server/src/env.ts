import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load the repo-root .env (apps/server/{src,dist}/ → ../../../.env). Real environment variables win.
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret-change-me-0000';

const boolish = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const EnvSchema = z
  .object({
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    PORT: z.coerce.number().int().positive().default(8787),
    HOST: z.string().default('127.0.0.1'),
    DATABASE_URL: z.string().url().optional(),
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    /**
     * Web origin(s) allowed to make state-changing requests and open the voice WebSocket, comma-separated
     * (e.g. the Vercel production URL plus a preview URL). Same-origin requests are always allowed.
     */
    WEB_ORIGIN: z
      .string()
      .default('http://localhost:5173')
      .refine((v) => v.split(',').every((o) => z.string().url().safeParse(o.trim()).success), 'must be one or more comma-separated URLs'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Signs the session cookie. Required outside local/test. */
    SESSION_SECRET: z.string().min(32).optional(),
    /** Comma-separated user handles allowed to change runtime config (S7 admin API). */
    ADMIN_USERS: z.string().default(''),
    /** Dev login (decisions.md ADR-010). Defaults on for local/test/staging, off for production. */
    ALLOW_DEV_LOGIN: boolish,
    /** How often the config service reloads overrides from the database (≤1 min target). */
    CONFIG_RELOAD_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    /** Run pending SQL migrations on startup. Defaults on for local/test. */
    MIGRATE_ON_START: boolish,
    /**
     * Split hosting (web on Vercel, API on Railway): the browser opens the voice WebSocket straight to the API host,
     * where it has no session cookie. When true, the short-lived signed stream token alone identifies the user
     * (it is only issued to the signed-in owner of the session, is bound to it, and expires in 5 minutes).
     * Off by default: same-origin deployments keep requiring cookie AND token.
     */
    VOICE_WS_TOKEN_ONLY: boolish,
    /** Apply the team-demo config (packages/shared DEMO_CONFIG) on start when no overrides exist yet. */
    APPLY_DEMO_CONFIG: boolish,
    /** Optional Slack-compatible webhook for analytics alerts (P6.4). Payloads carry rule names and numbers only. */
    ALERT_WEBHOOK_URL: z.string().url().optional(),
  })
  .transform((e) => ({
    ...e,
    SESSION_SECRET: e.SESSION_SECRET ?? DEV_SESSION_SECRET,
    sessionSecretIsDefault: e.SESSION_SECRET === undefined,
    webOrigins: e.WEB_ORIGIN.split(',').map((o) => new URL(o.trim()).origin),
    voiceWsTokenOnly: e.VOICE_WS_TOKEN_ONLY ?? false,
    applyDemoConfig: e.APPLY_DEMO_CONFIG ?? false,
    adminHandles: new Set(
      e.ADMIN_USERS.split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
    allowDevLogin: e.ALLOW_DEV_LOGIN ?? e.APP_ENV !== 'production',
    migrateOnStart: e.MIGRATE_ON_START ?? (e.APP_ENV === 'local' || e.APP_ENV === 'test'),
  }))
  .superRefine((e, ctx) => {
    if ((e.APP_ENV === 'staging' || e.APP_ENV === 'production') && e.sessionSecretIsDefault) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'must be set (≥32 chars) in staging/production' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

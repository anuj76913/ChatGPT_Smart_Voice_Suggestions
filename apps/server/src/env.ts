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
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
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
    /** Optional Slack-compatible webhook for analytics alerts (P6.4). Payloads carry rule names and numbers only. */
    ALERT_WEBHOOK_URL: z.string().url().optional(),
  })
  .transform((e) => ({
    ...e,
    SESSION_SECRET: e.SESSION_SECRET ?? DEV_SESSION_SECRET,
    sessionSecretIsDefault: e.SESSION_SECRET === undefined,
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

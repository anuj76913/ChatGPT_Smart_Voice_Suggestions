import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { AlertEvaluator } from './analytics/alerts';
import { registerAnalyticsRoutes } from './analytics/routes';
import { registerAuth } from './auth';
import { registerDogfoodRoutes } from './dogfood/routes';
import { registerChatRoutes } from './chat/routes';
import { Classifier } from './classifier/classifier';
import { registerClassifierRoutes } from './classifier/routes';
import { registerConfigRoutes } from './config/routes';
import { ConfigService } from './config/service';
import type { Db } from './db';
import type { Env } from './env';
import { registerEventRoutes } from './events/routes';
import type { LlmGateway } from './llm/gateway';
import { RetentionJob } from './privacy/retention';
import { RateLimiter } from './rate-limit';
import { registerSecurity } from './security';
import { SuggestionEngine } from './suggestions/engine';
import { registerSuggestionRoutes } from './suggestions/routes';
import { VoiceOrchestrator } from './voice/orchestrator';
import { registerVoiceRoutes } from './voice/routes';
import { VoiceSummaries } from './voice/summary';
import type { SpeechGateway } from './voice/speech';

export interface AppDeps {
  /** Optional: the server's alert evaluator (index.ts starts its schedule). Built here when absent. */
  alerts?: AlertEvaluator | null;
  env: Env;
  db: Db | null;
  gateway?: LlmGateway | null;
  config?: ConfigService;
  classifier?: Classifier | null;
  speech?: SpeechGateway | null;
  limits?: Partial<{ chatPerMinute: number; eventsPerMinute: number; loginPerMinute: number }>;
  /** Tests: capture the server log (P7.3 privacy audit). Defaults to stdout outside the test env. */
  logStream?: NodeJS.WritableStream;
  /** Optional: the transcript-retention job (index.ts starts its schedule). Built here when absent. */
  retention?: RetentionJob | null;
}

type CheckStatus = 'ok' | 'not_configured' | 'error';

/** Never log credentials: cookies, auth headers, Set-Cookie. Request bodies are never logged at all. */
const LOG_REDACT = ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'];

/** S1 API gateway / BFF: auth, rate limits, routing, streaming. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { env, db } = deps;
  const app = Fastify({
    logger: deps.logStream
      ? { level: 'trace', stream: deps.logStream, redact: LOG_REDACT }
      : env.APP_ENV === 'test'
        ? false
        : { level: env.LOG_LEVEL, redact: LOG_REDACT },
    bodyLimit: 64 * 1024,
    trustProxy: env.APP_ENV === 'staging' || env.APP_ENV === 'production',
  });
  const config = deps.config ?? new ConfigService(db, { reloadMs: env.CONFIG_RELOAD_MS });
  const gateway = deps.gateway ?? null;
  const classifier = deps.classifier ?? (gateway ? new Classifier(gateway, () => config.get()) : null);
  const suggestions = db ? new SuggestionEngine(db, classifier, config, { warn: (o, m) => app.log.warn(o, m) }) : null;
  const log = { warn: (o: object, m: string) => app.log.warn(o, m) };
  const summaries = db ? new VoiceSummaries({ db, gateway, getConfig: () => config.get(), log }) : null;
  const voice = db
    ? new VoiceOrchestrator({
        db,
        gateway,
        speech: deps.speech ?? null,
        getConfig: () => config.get(),
        secret: env.SESSION_SECRET,
        log,
        // Start the summary (tip via Groq) as soon as a session ends, so the summary screen doesn't wait.
        onEnded: (sessionId, userId) => summaries?.warm(sessionId, userId),
      })
    : null;
  const alerts =
    deps.alerts !== undefined
      ? deps.alerts
      : db
        ? new AlertEvaluator({ db, getConfig: () => config.get(), webhookUrl: env.ALERT_WEBHOOK_URL ?? null, log: { warn: (o, m) => app.log.warn(o, m), error: (o, m) => app.log.error(o, m) } })
        : null;
  const retention =
    deps.retention !== undefined ? deps.retention : db ? new RetentionJob({ db, getConfig: () => config.get(), log: { warn: (o, m) => app.log.warn(o, m), info: (o, m) => app.log.info(o, m) } }) : null;
  const minute = 60_000;

  registerSecurity(app, env);
  app.register(cookie, { secret: env.SESSION_SECRET });
  // Voice turns arrive as one audio clip per message; allow up to the configured max clip size.
  app.register(websocket, { options: { maxPayload: config.get().voice.maxTurnAudioBytes + 64 * 1024 } });
  app.addHook('onClose', async () => {
    alerts?.stop();
    retention?.stop();
    await voice?.shutdown();
  });
  app.decorate('alerts', alerts);
  app.decorate('retention', retention);

  app.after(() => {
    registerAuth(app, { env, db, loginLimiter: new RateLimiter(deps.limits?.loginPerMinute ?? 10, minute), dogfoodCohorts: () => config.get().dogfoodCohorts });
    registerDogfoodRoutes(app, { db, config, limiter: new RateLimiter(10, minute) });
    registerChatRoutes(app, {
      db,
      gateway,
      limiter: new RateLimiter(deps.limits?.chatPerMinute ?? 20, minute),
      suggestions,
      graceMs: () => config.get().suggestion.graceMs,
    });
    registerSuggestionRoutes(app, { db, config, limiter: new RateLimiter(60, minute) });
    registerEventRoutes(app, { db, config, limiter: new RateLimiter(deps.limits?.eventsPerMinute ?? 60, minute) });
    registerConfigRoutes(app, { config });
    registerClassifierRoutes(app, { classifier, config });
    registerVoiceRoutes(app, { voice, summaries, secret: env.SESSION_SECRET, limiter: new RateLimiter(10, minute), wsTokenOnly: env.voiceWsTokenOnly });
    registerAnalyticsRoutes(app, { db, config, alerts, limiter: new RateLimiter(30, minute) });
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'svs-server', env: env.APP_ENV }));

  app.get('/readyz', async (_req, reply) => {
    let database: CheckStatus = 'not_configured';
    if (db) {
      try {
        await db.ping();
        database = 'ok';
      } catch {
        database = 'error';
      }
    }
    const groq: CheckStatus = env.GROQ_API_KEY ? 'ok' : 'not_configured';
    const ready = database === 'ok' && groq === 'ok';
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { database, groq, config: config.isFresh() ? 'ok' : 'stale' },
      llmProvider: config.get().llm.provider,
    });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** P6.4 alert evaluator (null without a database). */
    alerts: AlertEvaluator | null;
    /** P7.3 transcript-retention job (null without a database). */
    retention: RetentionJob | null;
  }
}

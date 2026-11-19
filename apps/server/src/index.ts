import { DEMO_CONFIG } from '@svs/shared';
import { buildApp } from './app';
import { ConfigService } from './config/service';
import { createDb } from './db';
import { loadEnv } from './env';
import { LlmGateway } from './llm/gateway';
import { sttUsageRecorder, usageRecorder } from './llm/usage-store';
import { SpeechGateway } from './voice/speech';
import { runMigrations } from './migrate';

type LogFn = (obj: object, msg: string) => void;

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

if (db && env.migrateOnStart) {
  const applied = await runMigrations(db);
  if (applied.length) console.log(`applied migrations: ${applied.join(', ')}`);
}

// Services are created before the Fastify logger exists; they log through this indirection once it does.
let sink: { warn: LogFn; info: LogFn } = { warn: (o, m) => console.warn(m, o), info: (o, m) => console.log(m, o) };
const log = { warn: (o: object, m: string) => sink.warn(o, m), info: (o: object, m: string) => sink.info(o, m) };

const config = new ConfigService(db, { reloadMs: env.CONFIG_RELOAD_MS, log });
const gateway = env.GROQ_API_KEY
  ? new LlmGateway({
      apiKey: env.GROQ_API_KEY,
      baseUrl: env.GROQ_BASE_URL,
      getConfig: () => config.get(),
      onUsage: usageRecorder(db, log),
      log,
    })
  : null;
const speech = env.GROQ_API_KEY
  ? new SpeechGateway({ apiKey: env.GROQ_API_KEY, baseUrl: env.GROQ_BASE_URL, getConfig: () => config.get(), onUsage: sttUsageRecorder(db, log) })
  : null;
const app = buildApp({ env, db, config, gateway, speech });
sink = { warn: (o, m) => app.log.warn(o, m), info: (o, m) => app.log.info(o, m) };
await config.start();
// Deployed demo (APPLY_DEMO_CONFIG=true): turn the demo config on once, on a fresh database. Never overwrites
// overrides that already exist, so later changes made with ops:config or the admin API survive restarts.
if (env.applyDemoConfig && db && Object.keys(config.getOverrides()).length === 0) {
  const r = await config.setOverrides(DEMO_CONFIG, 'deploy', 'APPLY_DEMO_CONFIG: team demo config on first start');
  log.info({ version: r.version }, 'applied demo config');
}
// P6.4: evaluate alert rules on a schedule (analytics.alerts.intervalMs; 0 disables it).
app.alerts?.start();
// P7.3: purge voice transcripts past the retention window (privacy.voiceTranscriptRetentionDays).
app.retention?.start();

if (!env.GROQ_API_KEY) app.log.warn('GROQ_API_KEY is not set: chat is unavailable (see docs/phase0/groq-setup.md)');
if (!env.DATABASE_URL) app.log.warn('DATABASE_URL is not set: chat, events and config are unavailable');
if (env.sessionSecretIsDefault) app.log.warn('SESSION_SECRET not set: using the insecure development secret');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  config.stop();
  await app.close();
  await db?.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

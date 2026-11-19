/**
 * Phase 7 hardening: security (P7.4), privacy (P7.3) and chaos / fault injection (P7.5). Needs TEST_DATABASE_URL.
 */
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mergeConfig, type ChatStreamEvent, type CreateVoiceSessionResponse, type SvsConfig, type VoiceServerMessage } from '@svs/shared';
import type WebSocket from 'ws';
import { buildApp } from '../src/app';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { usageRecorder } from '../src/llm/usage-store';
import { runMigrations } from '../src/migrate';
import { RetentionJob } from '../src/privacy/retention';
import { SpeechGateway } from '../src/voice/speech';
import { completion, errorResponse, startFakeGroq, streamOf, type FakeGroq, type FakeResponse } from './fake-groq';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

const KEY = 'gsk_CANARYKEY_0123456789abcdef';
const QUERY_CANARY = 'canaryquery7c1f';
const TRANSCRIPT_CANARY = 'canarytranscript91ab';
const ANSWER_CANARY = 'canaryanswer55d2';

d('Phase 7 hardening (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  let realGet: () => SvsConfig;
  let logs = '';
  let classifierReply: () => FakeResponse;
  let sttReply: () => FakeResponse;
  const sockets: WebSocket[] = [];
  const env = loadEnv({ APP_ENV: 'test', GROQ_API_KEY: KEY, DATABASE_URL: TEST_DB, WEB_ORIGIN: 'http://localhost:5173' });

  beforeAll(async () => {
    db = createDb(TEST_DB)!;
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    fake = await startFakeGroq();
    config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    realGet = config.get.bind(config);
    const getConfig = () => config.get();
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logs += String(chunk);
        cb();
      },
    });
    app = buildApp({
      env,
      db,
      config,
      // Real usage metering, so the privacy audit covers llm_usage rows too.
      gateway: new LlmGateway({ apiKey: KEY, baseUrl: fake.url, getConfig, onUsage: usageRecorder(db) }),
      speech: new SpeechGateway({ apiKey: KEY, baseUrl: fake.url, getConfig }),
      limits: { chatPerMinute: 1000, loginPerMinute: 1000, eventsPerMinute: 1000 },
      logStream,
      alerts: null,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.close();
  });
  beforeEach(async () => {
    fake.reset();
    config.get = realGet;
    await config.setOverrides({ enabled: true, rolloutPercent: 100, experiment: { id: 'svs_v1', treatmentShare: 1 } }, 'test', 'hardening');
    classifierReply = () => completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' }));
    sttReply = () => ({ kind: 'json', body: { text: `I built a chatbot ${TRANSCRIPT_CANARY}`, language: 'english', segments: [{ avg_logprob: -0.2, no_speech_prob: 0.01 }] } });
    fake.setHandler((r) => {
      if (r.path.includes('/audio/transcriptions')) return sttReply();
      if (r.body.stream) return streamOf([`Here is how ${ANSWER_CANARY}. `, 'Good luck?']);
      const rf = r.body.response_format as { json_schema?: { name?: string } } | undefined;
      if (rf?.json_schema?.name === 'session_summary') return completion(JSON.stringify({ tip: 'Add one number.', next_activity_index: 0 }));
      if (rf) return classifierReply();
      return completion('Welcome! Tell me about yourself?');
    });
  });
  afterEach(() => {
    for (const s of sockets.splice(0)) s.terminate();
  });

  let n = 0;
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: `hd${++n}` } });
    const v = res.cookies.find((c) => c.name === 'svs_session')!.value;
    return { cookie: { svs_session: v }, header: `svs_session=${v}`, id: res.json().id as string };
  };
  const chat = async (u: { cookie: Record<string, string> }, text: string) => {
    const conv = (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie })).json().id as string;
    const t0 = Date.now();
    const res = await app.inject({ method: 'POST', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie, payload: { text, client_msg_id: `m-${crypto.randomUUID()}` } });
    const events = res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as ChatStreamEvent);
    return { conv, events, ms: Date.now() - t0, status: res.statusCode };
  };
  const decisions = async (userId: string) => {
    for (let i = 0; i < 80; i++) {
      const rows = (await db.query<{ outcome: string }>('SELECT outcome FROM suggestion_decisions WHERE user_id = $1', [userId])).rows;
      if (rows.length) return rows.map((r) => r.outcome);
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  };

  // ───────────────────────── P7.4 security ─────────────────────────
  describe('security (P7.4)', () => {
    it('every non-public route requires a session', async () => {
      const PUBLIC = new Set(['GET /healthz', 'GET /readyz', 'POST /v1/auth/dev-login', 'POST /v1/auth/logout']);
      const checked: string[] = [];
      for (const r of app.routeInventory) {
        const key = `${r.method} ${r.url}`;
        if (PUBLIC.has(key) || r.method === 'OPTIONS') continue;
        const url = r.url.replace(/:id\b/g, '00000000-0000-4000-8000-000000000000');
        const res = await app.inject({ method: r.method as 'GET', url, payload: ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined });
        expect(res.statusCode, key).toBe(401);
        checked.push(key);
      }
      expect(checked.length).toBeGreaterThan(20);
    });

    it('logout revokes the session server-side (a copied cookie stops working)', async () => {
      const u = await login();
      expect((await app.inject({ method: 'GET', url: '/v1/me', cookies: u.cookie })).statusCode).toBe(200);
      await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies: u.cookie });
      expect((await app.inject({ method: 'GET', url: '/v1/me', cookies: u.cookie })).statusCode).toBe(401);
      // Logging in again issues a cookie for the new epoch.
      const again = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: `hd${n}` } });
      const v = again.cookies.find((c) => c.name === 'svs_session')!.value;
      expect((await app.inject({ method: 'GET', url: '/v1/me', cookies: { svs_session: v } })).statusCode).toBe(200);
      // Old-format cookies (plain user id) are no longer accepted.
      expect((await app.inject({ method: 'GET', url: '/v1/me', cookies: { svs_session: app.signCookie(u.id) } })).statusCode).toBe(401);
    });

    it('blocks cross-origin state changes and WebSocket upgrades; allows same-origin and the web origin', async () => {
      const u = await login();
      const evil = await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie, headers: { origin: 'https://evil.example' } });
      expect(evil.statusCode).toBe(403);
      expect(evil.json()).toEqual({ error: 'forbidden_origin' });
      expect((await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie, headers: { origin: 'http://localhost:5173' } })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie, headers: { origin: 'http://localhost:80', host: 'localhost:80' } })).statusCode).toBe(201);
      const ws = await app.inject({ method: 'GET', url: '/v1/voice/sessions/00000000-0000-4000-8000-000000000000/stream', cookies: u.cookie, headers: { origin: 'https://evil.example', upgrade: 'websocket', connection: 'upgrade' } });
      expect(ws.statusCode).toBe(403);
      // Reads are not blocked (they don't change state, and CORS keeps the response from other origins).
      expect((await app.inject({ method: 'GET', url: '/v1/me', cookies: u.cookie, headers: { origin: 'https://evil.example' } })).statusCode).toBe(200);
    });

    it('limits spoken turns per session (each turn costs Groq calls)', async () => {
      const limited = mergeConfig(realGet(), { voice: { maxTurnsPerMinute: 2 } });
      config.get = () => limited;
      const u = await login();
      const s = (await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload: { intent: 'mock_interview', entry_point: 'mic_button' } })).json() as CreateVoiceSessionResponse;
      const msgs: VoiceServerMessage[] = [];
      const ws = await app.injectWS(`${s.stream.path}?token=${encodeURIComponent(s.stream.token)}`, { headers: { cookie: u.header } }, { onInit: (w) => w.on('message', (x) => msgs.push(JSON.parse(String(x)) as VoiceServerMessage)) });
      sockets.push(ws);
      const count = (type: string) => msgs.filter((m) => m.type === type).length;
      const until = async (ok: () => boolean) => {
        for (let i = 0; i < 250 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      };
      await until(() => count('ready') > 0);
      for (let k = 1; k <= 2; k++) {
        ws.send(JSON.stringify({ type: 'turn', mime: 'audio/webm' }));
        ws.send(Buffer.alloc(1000, 1));
        await until(() => count('reply.done') >= k);
      }
      ws.send(JSON.stringify({ type: 'turn', mime: 'audio/webm' }));
      ws.send(Buffer.alloc(1000, 1));
      await until(() => msgs.some((m) => m.type === 'error'));
      expect(msgs.find((m) => m.type === 'error')).toMatchObject({ code: 'too_many_turns' });
      expect(count('reply.done')).toBe(2);
    });

    it('sets security headers and never leaks internals in errors', async () => {
      const u = await login();
      const me = await app.inject({ method: 'GET', url: '/v1/me', cookies: u.cookie });
      expect(me.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
      const bad = await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie, headers: { 'content-type': 'application/json' }, payload: '{"broken' });
      expect(bad.statusCode).toBe(400);
      expect(Object.keys(bad.json())).toEqual(['error']);
      expect(bad.body).not.toMatch(/Unexpected|JSON at position|SyntaxError/);
      expect((await app.inject({ method: 'GET', url: '/v1/nope' })).json()).toEqual({ error: 'not_found' });
      // A database failure surfaces as a bare 500.
      await db.query('ALTER TABLE conversations RENAME TO conversations_x');
      try {
        const res = await app.inject({ method: 'GET', url: '/v1/conversations', cookies: u.cookie });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({ error: 'internal_error' });
      } finally {
        await db.query('ALTER TABLE conversations_x RENAME TO conversations');
      }
    });
  });

  // ───────────────────────── P7.3 privacy ─────────────────────────
  describe('privacy (P7.3)', () => {
    it('query, answer, transcript and the API key never reach logs, events or metering tables', async () => {
      logs = '';
      const u = await login();
      const { conv, events } = await chat(u, `Take my mock interview please ${QUERY_CANARY}`);
      const card = events.find((e) => e.type === 'suggestion') as Extract<ChatStreamEvent, { type: 'suggestion' }>;
      expect(card).toBeTruthy();
      // A Groq failure path too (errors are where content most often leaks).
      classifierReply = () => errorResponse(500);
      await chat(u, `Interview practice again ${QUERY_CANARY}`);
      // A voice session with a spoken turn.
      const s = (await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload: { intent: 'mock_interview', entry_point: 'suggestion_card', suggestion_id: card.suggestion_id, conversation_id: conv } })).json() as CreateVoiceSessionResponse;
      const msgs: VoiceServerMessage[] = [];
      const ws = await app.injectWS(`${s.stream.path}?token=${encodeURIComponent(s.stream.token)}`, { headers: { cookie: u.header } }, { onInit: (w) => w.on('message', (x) => msgs.push(JSON.parse(String(x)) as VoiceServerMessage)) });
      sockets.push(ws);
      const waitFor = async (type: string) => {
        for (let i = 0; i < 200 && !msgs.some((m) => m.type === type); i++) await new Promise((r) => setTimeout(r, 20));
      };
      await waitFor('ready');
      ws.send(JSON.stringify({ type: 'turn', mime: 'audio/webm' }));
      ws.send(Buffer.alloc(1000, 1));
      await waitFor('reply.done');
      ws.send(JSON.stringify({ type: 'end' }));
      await waitFor('session.ended');
      await new Promise((r) => setTimeout(r, 300)); // fire-and-forget writes (events, usage, summary)

      // Content is stored where the product needs it (chat history, transcripts)…
      expect((await db.query('SELECT count(*)::int AS n FROM voice_turns WHERE session_id = $1 AND transcript LIKE $2', [s.session_id, `%${TRANSCRIPT_CANARY}%`])).rows[0]!.n).toBe(1);
      // …and nowhere else.
      for (const canary of [QUERY_CANARY, ANSWER_CANARY, TRANSCRIPT_CANARY, KEY]) {
        expect(logs.includes(canary), `log contains ${canary}`).toBe(false);
        for (const table of ['events', 'llm_usage', 'suggestion_decisions', 'suggestions', 'alert_events', 'experiment_assignments', 'voice_sessions']) {
          const hit = await db.query(`SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE $1`, [`%${canary}%`]);
          expect(hit.rows[0]!.n, `${table} contains ${canary}`).toBe(0);
        }
      }
      expect(logs.length).toBeGreaterThan(0); // the log really was captured
    });

    it('purges voice transcripts and summary tips past the retention window', async () => {
      const u = await login();
      const vs = (await db.query<{ id: string }>("INSERT INTO voice_sessions (user_id, preset_id, entry_point, status) VALUES ($1, 'interview_practice', 'mic_button', 'ended') RETURNING id", [u.id])).rows[0]!.id;
      await db.query(
        `INSERT INTO voice_turns (session_id, role, transcript, at) VALUES
           ($1, 'user', 'old answer', now() - interval '40 days'), ($1, 'user', 'recent answer', now() - interval '2 days')`,
        [vs],
      );
      await db.query("INSERT INTO session_summaries (session_id, duration_s, questions_practised, tip, created_at) VALUES ($1, 60, 1, 'old tip', now() - interval '40 days')", [vs]);
      const job = new RetentionJob({ db, getConfig: () => mergeConfig(realGet(), { privacy: { voiceTranscriptRetentionDays: 30 } }) });
      const r = (await job.run())!;
      expect(r.turns).toBeGreaterThanOrEqual(1);
      expect(r.tips).toBeGreaterThanOrEqual(1);
      expect((await db.query('SELECT transcript FROM voice_turns WHERE session_id = $1', [vs])).rows).toEqual([{ transcript: 'recent answer' }]);
      expect((await db.query('SELECT tip FROM session_summaries WHERE session_id = $1', [vs])).rows[0]!.tip).toBeNull();
    });
  });

  // ───────────────────────── P7.5 chaos ─────────────────────────
  describe('chaos / fault injection (P7.5): chat is unaffected and the card is hidden', () => {
    const expectCleanAnswer = (events: ChatStreamEvent[]) => {
      const types = events.map((e) => e.type);
      expect(types).toContain('answer.complete');
      expect(types.at(-1)).toBe('stream.end');
      expect(types).not.toContain('suggestion');
      expect(types).not.toContain('answer.error');
    };

    it('Groq 429 storm on the classifier', async () => {
      classifierReply = () => errorResponse(429, 30);
      const u = await login();
      const r = await chat(u, 'Take my mock interview for TCS');
      expectCleanAnswer(r.events);
      expect(await decisions(u.id)).toEqual(['classifier_error']);
      expect(r.ms).toBeLessThan(3000); // no waiting out a 30 s retry-after
    });

    it('Groq 5xx and timeouts on the classifier', async () => {
      classifierReply = () => errorResponse(503);
      const u = await login();
      expectCleanAnswer((await chat(u, 'Take my mock interview for TCS')).events);
      classifierReply = () => ({ ...completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' })), delayMs: 5000 } as FakeResponse);
      const v = await login();
      const r = await chat(v, 'Take my mock interview for TCS');
      expectCleanAnswer(r.events);
      expect(r.ms).toBeLessThan(4500); // classifier timeout (2 s) + grace, not the 5 s delay
    });

    it('config store stale (can’t reload)', async () => {
      const fresh = config.isFresh.bind(config);
      config.isFresh = () => false;
      try {
        const u = await login();
        expectCleanAnswer((await chat(u, 'Take my mock interview for TCS')).events);
        expect(await decisions(u.id)).toEqual(['stale_config']);
      } finally {
        config.isFresh = fresh;
      }
    });

    it('prefs store down', async () => {
      const u = await login();
      await db.query('ALTER TABLE voice_prefs RENAME TO voice_prefs_x');
      try {
        const r = await chat(u, 'Take my mock interview for TCS');
        expectCleanAnswer(r.events);
      } finally {
        await db.query('ALTER TABLE voice_prefs_x RENAME TO voice_prefs');
      }
    });

    it('event store down: ingestion fails cleanly (client retries); voice sessions still start', async () => {
      const u = await login();
      await db.query('ALTER TABLE events RENAME TO events_x');
      try {
        const ev = await app.inject({
          method: 'POST',
          url: '/v1/events',
          cookies: u.cookie,
          payload: { events: [{ event: 'suggestions_opted_in', event_id: crypto.randomUUID(), ts: new Date().toISOString(), session_id: 't', app_version: '1', platform: 'web-mobile', props: { source: 'settings' } }] },
        });
        expect(ev.statusCode).toBe(500);
        expect(ev.json()).toEqual({ error: 'internal_error' });
        const s = await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload: { intent: 'mock_interview', entry_point: 'mic_button' } });
        expect(s.statusCode).toBe(201);
        expectCleanAnswer((await chat(u, 'What is an API?')).events);
      } finally {
        await db.query('ALTER TABLE events_x RENAME TO events');
      }
    });

    it('speech provider down: the learner is told, the session survives, then ends after 3 failures', async () => {
      sttReply = () => errorResponse(500);
      const u = await login();
      const s = (await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload: { intent: 'mock_interview', entry_point: 'mic_button' } })).json() as CreateVoiceSessionResponse;
      const msgs: VoiceServerMessage[] = [];
      const ws = await app.injectWS(`${s.stream.path}?token=${encodeURIComponent(s.stream.token)}`, { headers: { cookie: u.header } }, { onInit: (w) => w.on('message', (x) => msgs.push(JSON.parse(String(x)) as VoiceServerMessage)) });
      sockets.push(ws);
      const count = (type: string) => msgs.filter((m) => m.type === type).length;
      for (let i = 0; i < 200 && !count('ready'); i++) await new Promise((r) => setTimeout(r, 20));
      for (let k = 1; k <= 3; k++) {
        ws.send(JSON.stringify({ type: 'turn', mime: 'audio/webm' }));
        ws.send(Buffer.alloc(1000, 1));
        for (let i = 0; i < 300 && count('error') < k && !count('session.ended'); i++) await new Promise((r) => setTimeout(r, 20));
      }
      for (let i = 0; i < 200 && !count('session.ended'); i++) await new Promise((r) => setTimeout(r, 20));
      expect(msgs.some((m) => m.type === 'error' && (m as { code: string }).code === 'stt_failed')).toBe(true);
      expect(msgs.find((m) => m.type === 'session.ended')).toMatchObject({ stats: { end_reason: 'error' } });
    });
  });
});

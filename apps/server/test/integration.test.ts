/**
 * End-to-end tests of the Phase 1 API against a real PostgreSQL database and the fake Groq server.
 * Needs TEST_DATABASE_URL (created by `npm run db:local:init`). The database is wiped and migrated at the start.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatStreamEvent } from '@svs/shared';
import { buildApp } from '../src/app';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { usageRecorder } from '../src/llm/usage-store';
import { runMigrations } from '../src/migrate';
import { errorResponse, startFakeGroq, streamOf, type FakeGroq } from './fake-groq';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Phase 1 API (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;

  const env = loadEnv({ APP_ENV: 'test', ADMIN_USERS: 'admin', GROQ_API_KEY: 'gsk_integration_key', DATABASE_URL: TEST_DB });

  beforeAll(async () => {
    db = createDb(TEST_DB)!;
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    fake = await startFakeGroq();
    config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    const gateway = new LlmGateway({ apiKey: env.GROQ_API_KEY!, baseUrl: fake.url, getConfig: () => config.get(), onUsage: usageRecorder(db) });
    app = buildApp({ env, db, gateway, config, limits: { chatPerMinute: 5, loginPerMinute: 1000 } });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.close();
  });

  beforeEach(() => fake.reset());

  // ── helpers ──
  const login = async (handle: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((k) => k.name === 'svs_session')!;
    return { cookie: { svs_session: c.value }, me: res.json() };
  };
  const newConversation = async (cookie: Record<string, string>) =>
    (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: cookie })).json().id as string;
  const send = async (cookie: Record<string, string>, convId: string, text: string, clientMsgId: string) => {
    const res = await app.inject({ method: 'POST', url: `/v1/conversations/${convId}/messages`, cookies: cookie, payload: { text, client_msg_id: clientMsgId } });
    const events = res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as ChatStreamEvent);
    return { res, events };
  };
  const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 2000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  // ── auth ──
  it('rejects unauthenticated requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', cookies: { svs_session: 'forged' } })).statusCode).toBe(401);
  });

  it('dev login creates a user with a signed httpOnly cookie; admin comes from ADMIN_USERS', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: 'Asha' } });
    const c = res.cookies.find((k) => k.name === 'svs_session')!;
    expect(c.httpOnly).toBe(true);
    expect(res.json()).toMatchObject({ handle: 'asha', is_admin: false });
    expect((await login('admin')).me.is_admin).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: 'x' } })).statusCode).toBe(400);
  });

  // ── chat ──
  it('streams an answer: accepted → deltas → complete → end, and persists both messages', async () => {
    const { cookie } = await login('ravi');
    const conv = await newConversation(cookie);
    fake.setHandler(() => streamOf(['Sure! ', 'Here is ', 'how.'], { reasoning: 'SECRET' }));
    const { res, events } = await send(cookie, conv, 'Help me prepare for my TCS interview', 'msg-00000001');
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(events.map((e) => e.type)).toEqual(['message.accepted', 'answer.delta', 'answer.delta', 'answer.delta', 'answer.complete', 'stream.end']);
    expect(events.filter((e) => e.type === 'answer.delta').map((e) => (e as { text: string }).text).join('')).toBe('Sure! Here is how.');
    expect(res.body).not.toContain('SECRET');
    expect(events.some((e) => e.type === 'suggestion')).toBe(false); // reserved for Phase 3

    const msgs = (await app.inject({ method: 'GET', url: `/v1/conversations/${conv}/messages`, cookies: cookie })).json().messages;
    expect(msgs).toEqual([
      expect.objectContaining({ role: 'user', content: 'Help me prepare for my TCS interview', status: 'complete' }),
      expect.objectContaining({ role: 'assistant', content: 'Sure! Here is how.', status: 'complete' }),
    ]);
    const list = (await app.inject({ method: 'GET', url: '/v1/conversations', cookies: cookie })).json().conversations;
    expect(list[0]).toMatchObject({ id: conv, title: 'Help me prepare for my TCS interview' });

    const usage = await waitFor(async () => (await db.query("SELECT * FROM llm_usage WHERE use_case = 'chat' AND status = 'ok'")).rows[0]);
    expect(usage).toMatchObject({ model: 'openai/gpt-oss-120b', total_tokens: 25 });
    const row = (await db.query("SELECT model, ttft_ms FROM messages WHERE role = 'assistant'")).rows[0]!;
    expect(row.model).toBe('openai/gpt-oss-120b');
    expect(row.ttft_ms).toBeGreaterThanOrEqual(0);
  });

  it('sends the conversation history to the model, oldest first, with the system prompt', async () => {
    const { cookie } = await login('meena');
    const conv = await newConversation(cookie);
    fake.setHandler(() => streamOf(['first answer']));
    await send(cookie, conv, 'first question', 'msg-hist-0001');
    fake.setHandler(() => streamOf(['second answer']));
    await send(cookie, conv, 'second question', 'msg-hist-0002');
    const sent = fake.requests.at(-1)!.body.messages as Array<{ role: string; content: string }>;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent.at(-1)!.content).toBe('second question');
  });

  it('is idempotent on client_msg_id: a resend replays the stored answer without calling Groq', async () => {
    const { cookie } = await login('kiran');
    const conv = await newConversation(cookie);
    fake.setHandler(() => streamOf(['Answer once']));
    await send(cookie, conv, 'question', 'msg-idem-0001');
    const before = fake.requests.length;
    const { events } = await send(cookie, conv, 'question', 'msg-idem-0001');
    expect(events[0]).toMatchObject({ type: 'message.accepted', replay: true });
    expect(events.filter((e) => e.type === 'answer.delta').map((e) => (e as { text: string }).text).join('')).toBe('Answer once');
    expect(fake.requests.length).toBe(before);
    const n = (await db.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conv])).rows[0]!.n;
    expect(n).toBe(2);
  });

  it('reports a Groq outage as answer.error, then regenerates on retry with the same client_msg_id', async () => {
    const { cookie } = await login('farah');
    const conv = await newConversation(cookie);
    fake.setHandler(() => errorResponse(500));
    const failed = await send(cookie, conv, 'question', 'msg-fail-0001');
    expect(failed.events.map((e) => e.type)).toEqual(['message.accepted', 'answer.error', 'stream.end']);
    expect(failed.events[1]).toMatchObject({ code: 'llm_unavailable', retryable: true });
    fake.setHandler(() => streamOf(['recovered']));
    const retry = await send(cookie, conv, 'question', 'msg-fail-0001');
    expect(retry.events[0]).toMatchObject({ replay: false });
    expect(retry.events.map((e) => e.type)).toContain('answer.complete');
    const msgs = (await app.inject({ method: 'GET', url: `/v1/conversations/${conv}/messages`, cookies: cookie })).json().messages;
    expect(msgs.map((m: { role: string; content: string }) => `${m.role}:${m.content}`)).toEqual(['user:question', 'assistant:recovered']);
  });

  it("keeps users out of each other's conversations", async () => {
    const a = await login('owner1');
    const b = await login('intruder');
    const conv = await newConversation(a.cookie);
    expect((await app.inject({ method: 'GET', url: `/v1/conversations/${conv}/messages`, cookies: b.cookie })).statusCode).toBe(404);
    expect((await send(b.cookie, conv, 'hi', 'msg-intr-0001')).res.statusCode).toBe(404);
  });

  it('validates the message body and rate-limits per user', async () => {
    const { cookie } = await login('spammer');
    const conv = await newConversation(cookie);
    expect((await send(cookie, conv, '   ', 'msg-bad-00001')).res.statusCode).toBe(400);
    expect((await send(cookie, conv, 'hi', 'x')).res.statusCode).toBe(400);
    fake.setHandler(() => streamOf(['ok']));
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await send(cookie, conv, `q${i}`, `msg-rate-000${i}`)).res.statusCode);
    expect(codes.filter((c) => c === 429)).toHaveLength(codes.length - 3); // 2 bad requests + 3 successes used the 5/min budget
  });

  // ── events ──
  it('ingests valid events with server-side enrichment, dedupes, and rejects content or server-only events', async () => {
    const { cookie, me } = await login('eventer');
    const ev = (over: Record<string, unknown> = {}) => ({
      event: 'suggestions_opted_in',
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      session_id: 'tab-1',
      app_version: '0.1.0',
      platform: 'web-desktop',
      props: { source: 'settings' },
      ...over,
    });
    const good = ev();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      cookies: cookie,
      payload: {
        events: [
          good,
          good,
          ev({ props: { transcript: 'hello' } }),
          ev({ event: 'voice_session_started' }),
          // Phase 6: references must exist and belong to the user (P6.1)
          ev({ event: 'answer_feedback', props: { message_id: crypto.randomUUID(), thumbs: 'down', had_suggestion: false } }),
        ],
      },
    });
    expect(res.json()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(res.json().rejected).toHaveLength(3);
    const row = (await db.query('SELECT * FROM events WHERE event_id = $1', [good.event_id])).rows[0]!;
    expect(row).toMatchObject({ user_id: me.id, source: 'client', arm: null, cohort: 'test', platform: 'web-desktop' });
    expect(row.props).toMatchObject({ source: 'settings' });
  });

  // ── config ──
  it('client config is available to users; the admin API is admins-only', async () => {
    const user = await login('normaluser');
    const cc = (await app.inject({ method: 'GET', url: '/v1/config/client', cookies: user.cookie })).json();
    expect(cc).toMatchObject({ ttl_seconds: 60, copy_languages: ['en', 'hi', 'bn', 'mr', 'te'] }); // FR-11: Hindi (Phase 5) + regional (Phase 10)
    expect((await app.inject({ method: 'GET', url: '/v1/admin/config', cookies: user.cookie })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/v1/admin/config/overrides', cookies: user.cookie, payload: { overrides: {}, reason: 'nope' } })).statusCode).toBe(403);
  });

  it('admin overrides are validated, audited, applied at once and picked up by other instances', async () => {
    const { cookie } = await login('admin');
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/admin/config/overrides',
      cookies: cookie,
      payload: { overrides: { classifier: { thresholds: { mock_interview: 0 } } }, reason: 'try a bad threshold' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_config');

    const ok = await app.inject({
      method: 'PUT',
      url: '/v1/admin/config/overrides',
      cookies: cookie,
      payload: { overrides: { enabled: true, rolloutPercent: 100, killSwitch: [{ cohort: 'test' }] }, reason: 'kill switch drill for test cohort' },
    });
    expect(ok.statusCode).toBe(200);
    const view = (await app.inject({ method: 'GET', url: '/v1/admin/config', cookies: cookie })).json();
    expect(view.effective).toMatchObject({ enabled: true, rolloutPercent: 100 });
    expect(view.gate_for_me).toEqual({ allowed: false, reason: 'kill_switch' });
    expect(view.audit[0]).toMatchObject({ actor: 'admin', reason: 'kill switch drill for test cohort', new_overrides: { enabled: true } });

    // Another server instance sees the change on its next reload (hot reload, ≤1 min).
    const other = new ConfigService(db, { reloadMs: 60000 });
    await other.load();
    expect(other.get().killSwitch).toEqual([{ cohort: 'test' }]);
    expect(other.getVersion()).toBe(view.version);

    await config.setOverrides({}, 'admin', 'reset after test');
  });

  // ── classifier probe (Phase 2) ──
  it('admin classify probe shows the S3 decision and the card at current thresholds; admins only', async () => {
    const user = await login('notadmin2');
    expect((await app.inject({ method: 'POST', url: '/v1/admin/classify', cookies: user.cookie, payload: { text: 'mock interview lo' } })).statusCode).toBe(403);
    const { cookie } = await login('admin');
    fake.setHandler(() => ({ kind: 'json', body: { choices: [{ message: { content: JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'hinglish' }) } }], usage: {} } }));
    const res = (await app.inject({ method: 'POST', url: '/v1/admin/classify', cookies: cookie, payload: { text: 'Mera kal TCS interview hai, mock interview le lo' } })).json();
    expect(res.result).toMatchObject({ intent: 'mock_interview', stage: 'model' });
    expect(res.card).toBe('mock_interview');
    expect(res.prefilter.pass).toBe(true);
    const skipped = (await app.inject({ method: 'POST', url: '/v1/admin/classify', cookies: cookie, payload: { text: 'hello' } })).json();
    expect(skipped).toMatchObject({ result: { stage: 'prefilter', intent: 'none' }, card: null });
  });

  it('readyz reports ready with database, Groq key and fresh config', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ database: 'ok', groq: 'ok', config: 'ok' });
    expect(res.body).not.toContain('gsk_integration_key');
  });
});

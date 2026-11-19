/**
 * Phase 3: S4 decision engine, S5 prefs/caps, S6 arms, card delivery and user controls,
 * end-to-end against PostgreSQL and the fake Groq server. Needs TEST_DATABASE_URL.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readSseData, type ChatStreamEvent, type DeepPartial, type SvsConfig } from '@svs/shared';
import { buildApp } from '../src/app';
import { Classifier } from '../src/classifier/classifier';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { SuggestionEngine } from '../src/suggestions/engine';
import { completion, errorResponse, startFakeGroq, streamOf, type FakeGroq, type FakeResponse } from './fake-groq';

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

const VOICE_Q = 'Take my mock interview for a TCS fresher role';
const PLAIN_Q = 'Write Python code to reverse a linked list';
const ON: DeepPartial<SvsConfig> = { enabled: true, rolloutPercent: 100, experiment: { id: 'svs_v1', treatmentShare: 1 } };

d('Phase 3 suggestions (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  let classifierReply: () => FakeResponse;
  let chatReply: () => FakeResponse;
  const env = loadEnv({ APP_ENV: 'test', ADMIN_USERS: 'admin', GROQ_API_KEY: 'gsk_test', DATABASE_URL: TEST_DB });

  const setConfig = (o: DeepPartial<SvsConfig>) => config.setOverrides(o, 'test', 'phase 3 test setup');

  beforeAll(async () => {
    db = createDb(TEST_DB)!;
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    fake = await startFakeGroq();
    config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    const gateway = new LlmGateway({ apiKey: 'gsk_test', baseUrl: fake.url, getConfig: () => config.get() });
    app = buildApp({ env, db, gateway, config, limits: { chatPerMinute: 1000, loginPerMinute: 1000 } });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.close();
  });
  beforeEach(async () => {
    fake.reset();
    classifierReply = () => completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' }));
    chatReply = () => streamOf(['Sure, ', "let's prepare."]);
    fake.setHandler((r) => (r.body.response_format ? classifierReply() : chatReply()));
    await setConfig(ON);
  });

  // ── helpers ──
  let n = 0;
  const login = async (prefix = 'u') => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: `${prefix}${++n}` } });
    return { cookie: { svs_session: res.cookies.find((c) => c.name === 'svs_session')!.value }, id: res.json().id as string };
  };
  const conv = async (cookie: Record<string, string>) => (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: cookie })).json().id as string;
  const send = async (cookie: Record<string, string>, convId: string, text: string, clientMsgId = `m-${crypto.randomUUID()}`) => {
    const res = await app.inject({ method: 'POST', url: `/v1/conversations/${convId}/messages`, cookies: cookie, payload: { text, client_msg_id: clientMsgId } });
    return res.body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as ChatStreamEvent);
  };
  const card = (events: ChatStreamEvent[]) => events.find((e) => e.type === 'suggestion') as Extract<ChatStreamEvent, { type: 'suggestion' }> | undefined;
  const outcomes = async (userId: string) => (await db.query<{ outcome: string }>('SELECT outcome FROM suggestion_decisions WHERE user_id = $1 ORDER BY id', [userId])).rows.map((r) => r.outcome);
  const until = async <T>(fn: () => Promise<T | undefined | false>, ms = 3000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const voiceCards = async (cookie: Record<string, string>, count: number) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const c = card(await send(cookie, await conv(cookie), VOICE_Q));
      if (c) ids.push(c.suggestion_id);
    }
    return ids;
  };
  const dismiss = (cookie: Record<string, string>, id: string) => app.inject({ method: 'POST', url: `/v1/suggestions/${id}/dismiss`, cookies: cookie });

  // ── delivery contract ──
  it('treatment: card arrives after answer.complete and before stream.end, with server copy; impression and events recorded', async () => {
    const u = await login();
    const events = await send(u.cookie, await conv(u.cookie), VOICE_Q);
    expect(events.map((e) => e.type)).toEqual(['message.accepted', 'answer.delta', 'answer.delta', 'answer.complete', 'suggestion', 'stream.end']);
    const c = card(events)!;
    expect(c).toMatchObject({ intent: 'mock_interview', preset_id: 'interview_practice', copy: { cta: 'Try Voice Practice', opt_out_label: "Don't suggest voice" } });
    expect(c.suggestion_id).toBe(`sg_${c.message_id}`);
    const row = (await db.query('SELECT status, arm FROM suggestions WHERE id = $1', [c.suggestion_id])).rows[0];
    expect(row).toEqual({ status: 'shown', arm: 'treatment' });
    const ev = (await db.query("SELECT arm, source, intent_type FROM events WHERE event = 'suggestion_eligible' AND user_id = $1", [u.id])).rows;
    expect(ev).toEqual([{ arm: 'treatment', source: 'server', intent_type: 'mock_interview' }]);
    expect(await until(async () => (await outcomes(u.id)).length > 0 && outcomes(u.id))).toEqual(['shown']);
  });

  it('stored messages carry the visible card; a dismissed card stays hidden', async () => {
    const u = await login();
    const c1 = await conv(u.cookie);
    const s = card(await send(u.cookie, c1, VOICE_Q))!;
    let msgs = (await app.inject({ method: 'GET', url: `/v1/conversations/${c1}/messages`, cookies: u.cookie })).json().messages;
    expect(msgs[1].suggestion).toMatchObject({ suggestion_id: s.suggestion_id, status: 'shown', intent: 'mock_interview' });
    await dismiss(u.cookie, s.suggestion_id);
    msgs = (await app.inject({ method: 'GET', url: `/v1/conversations/${c1}/messages`, cookies: u.cookie })).json().messages;
    expect(msgs[1].suggestion).toBeNull();
  });

  it('prefilter miss: no card and no classifier call', async () => {
    const u = await login();
    const events = await send(u.cookie, await conv(u.cookie), PLAIN_Q);
    expect(card(events)).toBeUndefined();
    expect(fake.requests.some((r) => r.body.response_format)).toBe(false);
    expect(await until(() => outcomes(u.id).then((o) => o.length > 0 && o))).toEqual(['prefilter']);
  });

  it('control arm: never a card, but a shadow impression and suggestion_eligible (arm=control)', async () => {
    await setConfig({ ...ON, experiment: { id: 'svs_v1', treatmentShare: 0 } });
    const u = await login('ctl');
    const events = await send(u.cookie, await conv(u.cookie), VOICE_Q);
    expect(card(events)).toBeUndefined();
    expect((await db.query('SELECT status, arm FROM suggestions WHERE user_id = $1', [u.id])).rows).toEqual([{ status: 'eligible_control', arm: 'control' }]);
    expect((await db.query("SELECT arm FROM events WHERE event = 'suggestion_eligible' AND user_id = $1", [u.id])).rows).toEqual([{ arm: 'control' }]);
    expect((await db.query('SELECT arm FROM experiment_assignments WHERE user_id = $1', [u.id])).rows[0]!.arm).toBe('control');
    // Assignment is sticky even if the split changes later (EX-08).
    await setConfig(ON);
    expect(card(await send(u.cookie, await conv(u.cookie), VOICE_Q))).toBeUndefined();
  });

  it('dogfood cohorts get the card while the feature is disabled, outside the experiment', async () => {
    await setConfig({ enabled: false, dogfoodCohorts: ['test'], experiment: { id: 'svs_v1', treatmentShare: 0 } });
    const u = await login('dog');
    expect(card(await send(u.cookie, await conv(u.cookie), VOICE_Q))).toBeDefined();
    expect((await db.query('SELECT count(*)::int AS n FROM experiment_assignments WHERE user_id = $1', [u.id])).rows[0]!.n).toBe(0);
  });

  // ── caps (FR-5) ──
  it('at most one card per conversation', async () => {
    const u = await login();
    const c1 = await conv(u.cookie);
    expect(card(await send(u.cookie, c1, VOICE_Q))).toBeDefined();
    expect(card(await send(u.cookie, c1, 'Ask me HR interview questions one by one'))).toBeUndefined();
    expect(await until(() => outcomes(u.id).then((o) => o.length === 2 && o))).toEqual(['shown', 'conv_cap']);
  });

  it('at most 3 per rolling 7 days; an impression exactly 7×24h old no longer counts', async () => {
    const u = await login();
    expect(await voiceCards(u.cookie, 4)).toHaveLength(3);
    await db.query("UPDATE suggestions SET evaluated_at = now() - interval '168 hours 1 second' WHERE id = (SELECT id FROM suggestions WHERE user_id = $1 ORDER BY evaluated_at LIMIT 1)", [u.id]);
    expect(await voiceCards(u.cookie, 1)).toHaveLength(1);
  });

  it('two tabs racing for the last weekly slot: only one card', async () => {
    await setConfig({ ...ON, cap: { perConversation: 1, perRollingWeek: 1, rollingWindowHours: 168 } });
    const u = await login();
    const [a, b] = await Promise.all([conv(u.cookie), conv(u.cookie)]);
    const results = await Promise.all([send(u.cookie, a, VOICE_Q), send(u.cookie, b, VOICE_Q)]);
    expect(results.filter((r) => card(r)).length).toBe(1);
  });

  // ── dismiss / tap / pause (FR-4, FR-5) ──
  it('3 dismissals in a row pause suggestions for 14 days', async () => {
    const u = await login();
    const ids = await voiceCards(u.cookie, 3);
    const r = [];
    for (const id of ids) r.push((await dismiss(u.cookie, id)).json());
    expect(r.map((x) => x.consecutive_dismissals)).toEqual([1, 2, 3]);
    expect(r[2].paused).toBe(true);
    const prefs = (await app.inject({ method: 'GET', url: '/v1/me/voice-preferences', cookies: u.cookie })).json();
    expect(new Date(prefs.paused_until).getTime() - Date.now()).toBeGreaterThan(13.9 * 86400_000);
    await db.query('DELETE FROM suggestions WHERE user_id = $1', [u.id]); // free the weekly cap to prove the pause alone blocks
    expect(card(await send(u.cookie, await conv(u.cookie), VOICE_Q))).toBeUndefined();
    expect((await outcomes(u.id)).at(-1)).toBe('paused');
  });

  it('a tap resets the streak (dismiss, dismiss, tap, dismiss → 1); dismissing twice counts once', async () => {
    await setConfig({ ...ON, cap: { perConversation: 1, perRollingWeek: 10, rollingWindowHours: 168 } });
    const u = await login();
    const [s1, s2, s3, s4] = await voiceCards(u.cookie, 4);
    await dismiss(u.cookie, s1!);
    expect((await dismiss(u.cookie, s1!)).json()).toEqual({ counted: false });
    await dismiss(u.cookie, s2!);
    expect((await app.inject({ method: 'POST', url: `/v1/suggestions/${s3}/tap`, cookies: u.cookie })).json()).toMatchObject({ tapped: true, intent: 'mock_interview' });
    expect((await dismiss(u.cookie, s4!)).json()).toMatchObject({ consecutive_dismissals: 1, paused: false });
  });

  it("users can't act on someone else's card", async () => {
    const a = await login();
    const b = await login();
    const [id] = await voiceCards(a.cookie, 1);
    expect((await dismiss(b.cookie, id!)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/suggestions/${id}/tap`, cookies: b.cookie })).statusCode).toBe(404);
  });

  it('opt-out stops cards at once and marks the card; opting back in clears an active pause', async () => {
    const u = await login();
    const [id] = await voiceCards(u.cookie, 1);
    const off = await app.inject({ method: 'PUT', url: '/v1/me/voice-preferences', cookies: u.cookie, payload: { suggestions_enabled: false, suggestion_id: id } });
    expect(off.json().suggestions_enabled).toBe(false);
    expect((await db.query('SELECT status FROM suggestions WHERE id = $1', [id])).rows[0]!.status).toBe('opted_out');
    expect(card(await send(u.cookie, await conv(u.cookie), VOICE_Q))).toBeUndefined();
    await db.query("UPDATE voice_prefs SET paused_until = now() + interval '5 days', consecutive_dismissals = 2 WHERE user_id = $1", [u.id]);
    const on = await app.inject({ method: 'PUT', url: '/v1/me/voice-preferences', cookies: u.cookie, payload: { suggestions_enabled: true } });
    expect(on.json()).toMatchObject({ suggestions_enabled: true, paused_until: null });
    expect(card(await send(u.cookie, await conv(u.cookie), VOICE_Q))).toBeDefined();
  });

  // ── kill switch, failures, lateness (fail closed) ──
  it('kill switch by cohort hides cards with no release; chat is unaffected', async () => {
    await setConfig({ ...ON, killSwitch: [{ cohort: 'test' }] });
    const u = await login();
    const events = await send(u.cookie, await conv(u.cookie), VOICE_Q);
    expect(events.map((e) => e.type)).toContain('answer.complete');
    expect(card(events)).toBeUndefined();
    expect(await until(() => outcomes(u.id).then((o) => o.length > 0 && o))).toEqual(['kill_switch']);
  });

  it('kill switch flipped after the decision but before delivery: no card (DE-21)', async () => {
    const u = await login();
    const user = (await app.inject({ method: 'GET', url: '/v1/me', cookies: u.cookie })).json();
    const convId = await conv(u.cookie);
    const msg = (await db.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', 'x') RETURNING id", [convId])).rows[0]!.id;
    const gateway = new LlmGateway({ apiKey: 'k', baseUrl: fake.url, getConfig: () => config.get() });
    const engine = new SuggestionEngine(db, new Classifier(gateway, () => config.get()), config);
    const authUser = { ...user, region: 'IN', tier: null, primary_language: null, cohort: 'test', timezone: 'Asia/Kolkata' };
    const input = { user: authUser, conversationId: convId, messageId: msg, query: VOICE_Q, recentTurns: [] };
    const decision = await engine.decide(input);
    expect(decision.eligible).toBe(true);
    await setConfig({ ...ON, killSwitch: [{ cohort: 'test' }] });
    expect(await engine.commit(input, decision as Extract<typeof decision, { eligible: true }>)).toEqual({ send: false, outcome: 'kill_switch' });
  });

  it('classifier outage: answer streams normally, no card', async () => {
    classifierReply = () => errorResponse(500);
    const u = await login();
    const events = await send(u.cookie, await conv(u.cookie), VOICE_Q);
    expect(events.map((e) => e.type)).toEqual(['message.accepted', 'answer.delta', 'answer.delta', 'answer.complete', 'stream.end']);
    expect(await until(() => outcomes(u.id).then((o) => o.length > 0 && o))).toEqual(['classifier_error']);
  });

  it('answer fails: no card and no impression even if the classifier says yes', async () => {
    chatReply = () => errorResponse(500);
    const u = await login();
    const events = await send(u.cookie, await conv(u.cookie), VOICE_Q);
    expect(events.map((e) => e.type)).toEqual(['message.accepted', 'answer.error', 'stream.end']);
    expect(await until(() => outcomes(u.id).then((o) => o.length > 0 && o))).toEqual(['answer_failed']);
    expect((await db.query('SELECT count(*)::int AS n FROM suggestions WHERE user_id = $1', [u.id])).rows[0]!.n).toBe(0);
  });

  it('decision later than the 500 ms grace window: card dropped, kept as `late`, not counted', async () => {
    classifierReply = () => ({ ...(completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' })) as Extract<FakeResponse, { kind: 'json' }>), delayMs: 1200 });
    const u = await login();
    expect(card(await send(u.cookie, await conv(u.cookie), VOICE_Q))).toBeUndefined();
    const status = await until(async () => (await db.query('SELECT status FROM suggestions WHERE user_id = $1', [u.id])).rows[0]?.status);
    expect(status).toBe('late');
    expect(await until(() => outcomes(u.id).then((o) => o.length > 0 && o))).toEqual(['late']);
    expect(await voiceCards(u.cookie, 3).then((ids) => ids.length)).toBe(0); // the slow classifier keeps every card late
  });

  it('the suggestion path never delays the answer: first token arrives while the classifier is still thinking', async () => {
    classifierReply = () => ({ ...(completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' })) as Extract<FakeResponse, { kind: 'json' }>), delayMs: 1500 });
    chatReply = () => streamOf(['first', ' second'], { delayBetweenMs: 50 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const u = await login();
    const cookie = `svs_session=${u.cookie.svs_session}`;
    const convId = (await (await fetch(`${base}/v1/conversations`, { method: 'POST', headers: { cookie } })).json()) as { id: string };
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/conversations/${convId.id}/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: VOICE_Q, client_msg_id: `m-${crypto.randomUUID()}` }),
    });
    let firstDelta = -1;
    let end = -1;
    for await (const data of readSseData(res.body!)) {
      const e = JSON.parse(data) as ChatStreamEvent;
      if (e.type === 'answer.delta' && firstDelta < 0) firstDelta = Date.now() - t0;
      if (e.type === 'stream.end') end = Date.now() - t0;
    }
    expect(firstDelta).toBeLessThan(400);
    expect(end).toBeLessThan(1100); // answer (~0.1 s) + at most the 500 ms grace, never the 1.5 s classifier
  });
});

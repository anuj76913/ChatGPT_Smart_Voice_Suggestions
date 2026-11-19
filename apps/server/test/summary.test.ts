/**
 * Phase 5: session summary (FR-8), next activity (FR-9), streak (P5.3), Back-to-Chat recap, Hindi copy (FR-11).
 * Unit tests run anywhere; integration tests need TEST_DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import {
  mergeConfig,
  suggestionCopy,
  type ChatStreamEvent,
  type CreateVoiceSessionResponse,
  type DeepPartial,
  type SessionSummary,
  type SvsConfig,
  type VoiceServerMessage,
} from '@svs/shared';
import { buildApp } from '../src/app';
import { prefilter } from '../src/classifier/prefilter';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { PRESETS } from '../src/voice/presets';
import { SpeechGateway } from '../src/voice/speech';
import { creditDay, dayBefore, localDay, visibleStreak } from '../src/voice/streak';
import { completion, errorResponse, startFakeGroq, streamOf, type FakeGroq, type FakeResponse } from './fake-groq';

describe('streak rules (P5.3)', () => {
  it('uses the local calendar day in the user time zone (TM-03/04)', () => {
    const at = new Date('2026-11-16T19:00:00Z'); // 00:30 next day in India
    expect(localDay(at, 'Asia/Kolkata')).toBe('2026-11-17');
    expect(localDay(at, 'UTC')).toBe('2026-11-16');
    expect(localDay(at, 'America/Los_Angeles')).toBe('2026-11-16');
    expect(localDay(at, 'Not/AZone')).toBe('2026-11-17'); // falls back to Asia/Kolkata
  });
  it('computes the previous day across month and year boundaries', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });
  it('same day → unchanged, next day → +1, gap → 1, older day never rewinds (SU-06/08)', () => {
    expect(creditDay({ current: 0, lastDay: null }, '2026-11-17')).toEqual({ current: 1, lastDay: '2026-11-17' });
    expect(creditDay({ current: 2, lastDay: '2026-11-17' }, '2026-11-17')).toEqual({ current: 2, lastDay: '2026-11-17' });
    expect(creditDay({ current: 2, lastDay: '2026-11-16' }, '2026-11-17')).toEqual({ current: 3, lastDay: '2026-11-17' });
    expect(creditDay({ current: 5, lastDay: '2026-11-14' }, '2026-11-17')).toEqual({ current: 1, lastDay: '2026-11-17' });
    expect(creditDay({ current: 4, lastDay: '2026-11-17' }, '2026-11-16')).toEqual({ current: 4, lastDay: '2026-11-17' });
  });
  it('shows a streak only while it is alive (last day today or yesterday)', () => {
    expect(visibleStreak({ current: 3, lastDay: '2026-11-16' }, '2026-11-17')).toBe(3);
    expect(visibleStreak({ current: 3, lastDay: '2026-11-15' }, '2026-11-17')).toBe(0);
  });
});

describe('Hindi copy (FR-11)', () => {
  it('has Hindi card copy for every intent and falls back to English for other languages', () => {
    expect(suggestionCopy('mock_interview', 'hi')).toMatchObject({ title: 'आवाज़ से इंटरव्यू की प्रैक्टिस करें', cta: 'वॉइस प्रैक्टिस आज़माएँ' });
    expect(suggestionCopy('viva_revision', 'hi').opt_out_label).toBe('वॉइस का सुझाव न दें');
    expect(suggestionCopy('pronunciation', 'ta').cta).toBe('Try Voice Practice');
  });
  it('lets Devanagari practice requests reach the classifier (prefilter pf-v2)', () => {
    expect(prefilter('मेरा इंटरव्यू कल है, मॉक इंटरव्यू लीजिए').pass).toBe(true);
    expect(prefilter('मुझसे अंग्रेज़ी बोलने की प्रैक्टिस करवाइए').pass).toBe(true);
    expect(prefilter('भारत की राजधानी क्या है?').pass).toBe(false);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

const stt = (text: string, language = 'english'): FakeResponse => ({ kind: 'json', body: { text, language, segments: [{ avg_logprob: -0.2, no_speech_prob: 0.01 }] } });

d('Phase 5 summary, streak, recap (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  let realGet: () => SvsConfig;
  let summaryReply: () => FakeResponse;
  let sttReply: () => FakeResponse;
  let classifierReply: () => FakeResponse;
  const env = loadEnv({ APP_ENV: 'test', GROQ_API_KEY: 'gsk_test', DATABASE_URL: TEST_DB });
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    db = createDb(TEST_DB)!;
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    fake = await startFakeGroq();
    config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    realGet = config.get.bind(config);
    const getConfig = () => config.get();
    app = buildApp({
      env,
      db,
      config,
      gateway: new LlmGateway({ apiKey: 'k', baseUrl: fake.url, getConfig }),
      speech: new SpeechGateway({ apiKey: 'k', baseUrl: fake.url, getConfig }),
      limits: { chatPerMinute: 1000, loginPerMinute: 1000 },
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
    await config.setOverrides({}, 'test', 'reset');
    sttReply = () => stt('I am a final year student and I built a library chatbot');
    summaryReply = () => completion(JSON.stringify({ tip: 'Add one number that shows the impact of your project.', next_activity_index: 1 }));
    classifierReply = () => completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'hi' }));
    fake.setHandler((r) => {
      if (r.path.includes('/audio/transcriptions')) return sttReply();
      if (r.body.stream) return streamOf(['Good answer. ', 'What was the hardest part?']);
      const rf = r.body.response_format as { json_schema?: { name?: string } } | undefined;
      if (rf?.json_schema?.name === 'session_summary') return summaryReply();
      if (rf) return classifierReply();
      return completion('Welcome! Tell me about yourself?');
    });
  });
  afterEach(() => {
    for (const s of sockets.splice(0)) s.terminate();
  });

  const override = (o: DeepPartial<SvsConfig>) => {
    const merged = mergeConfig(realGet(), o);
    config.get = () => merged;
  };
  let n = 0;
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: `sum${++n}` } });
    const v = res.cookies.find((c) => c.name === 'svs_session')!.value;
    return { cookie: { svs_session: v }, header: `svs_session=${v}`, id: res.json().id as string };
  };
  const newConv = async (u: { cookie: Record<string, string> }) => (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie })).json().id as string;
  const create = async (u: { cookie: Record<string, string> }, body: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload: { intent: 'mock_interview', entry_point: 'suggestion_card', ...body } });

  /** Runs a session with `answers` spoken turns, optionally waiting so it qualifies for WAVL, then ends it. */
  const session = async (u: { cookie: Record<string, string>; header: string }, answers: number, opts: { qualify?: boolean; body?: Record<string, unknown> } = {}) => {
    if (opts.qualify) override({ voice: { wavlMinSessionS: 1 } });
    const s = (await create(u, opts.body)).json() as CreateVoiceSessionResponse;
    const msgs: VoiceServerMessage[] = [];
    const ws = await app.injectWS(`${s.stream.path}?token=${encodeURIComponent(s.stream.token)}`, { headers: { cookie: u.header } }, {
      onInit: (w) => w.on('message', (data) => msgs.push(JSON.parse(String(data)) as VoiceServerMessage)),
    });
    sockets.push(ws);
    const waitFor = async (type: VoiceServerMessage['type'], count = 1) => {
      const end = Date.now() + 4000;
      while (msgs.filter((m) => m.type === type).length < count) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${type}`);
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitFor('ready');
    for (let i = 1; i <= answers; i++) {
      ws.send(JSON.stringify({ type: 'turn', mime: 'audio/webm' }));
      ws.send(Buffer.alloc(1000, 1));
      await waitFor('reply.done', i);
    }
    if (opts.qualify) await new Promise((r) => setTimeout(r, 1100));
    ws.send(JSON.stringify({ type: 'end' }));
    await waitFor('session.ended');
    const ended = msgs.find((m) => m.type === 'session.ended') as Extract<VoiceServerMessage, { type: 'session.ended' }>;
    return { s, stats: ended.stats };
  };
  const summary = async (u: { cookie: Record<string, string> }, id: string) => app.inject({ method: 'GET', url: `/v1/voice/sessions/${id}/summary`, cookies: u.cookie });

  it('summary: duration, questions, one tip from the summary model, next activity, streak credited', async () => {
    const u = await login();
    const { s, stats } = await session(u, 1, { qualify: true });
    expect(stats.streak).toEqual({ current: 1, goal: 3, credited: true });
    const res = await summary(u, s.session_id);
    expect(res.statusCode).toBe(200);
    const sum = res.json() as SessionSummary;
    expect(sum).toMatchObject({
      label: 'Interview Practice',
      questions_practised: 1,
      short_session: false,
      qualifies_for_wavl: true,
      tip: 'Add one number that shows the impact of your project.',
      encouragement: null,
      next_activity: { index: 1, label: PRESETS.mock_interview.nextActivities[1] },
      streak: { current: 1, goal: 3, credited: true },
    });
    const req = fake.requests.find((r) => (r.body.response_format as { json_schema?: { name?: string } })?.json_schema?.name === 'session_summary')!;
    expect(req.body).toMatchObject({ model: 'openai/gpt-oss-120b', stream: false, response_format: { json_schema: { strict: true } } });
    expect(JSON.stringify(req.body.messages)).toContain('library chatbot');
    expect((await db.query('SELECT tip_source FROM session_summaries WHERE session_id = $1', [s.session_id])).rows[0]!.tip_source).toBe('llm');
  });

  it('the summary is built in the background when the session ends', async () => {
    const u = await login();
    const { s } = await session(u, 1);
    for (let i = 0; i < 80; i++) {
      if ((await db.query('SELECT 1 FROM session_summaries WHERE session_id = $1', [s.session_id])).rows[0]) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('summary was not warmed');
  });

  it('both summary models fail: summary without a tip, default next activity (SU-04)', async () => {
    summaryReply = () => errorResponse(500);
    const u = await login();
    const { s } = await session(u, 1);
    const sum = (await summary(u, s.session_id)).json() as SessionSummary;
    expect(sum).toMatchObject({ tip: null, next_activity: { index: 0 } });
    const models = fake.requests.filter((r) => (r.body.response_format as { json_schema?: { name?: string } })?.json_schema?.name === 'session_summary').map((r) => r.model);
    expect(models).toContain('openai/gpt-oss-120b');
    expect(models).toContain('openai/gpt-oss-20b');
  });

  it('no answers: no tip request, an encouragement instead, short session, no streak credit (SU-02/SU-03)', async () => {
    const u = await login();
    const { s, stats } = await session(u, 0);
    expect(stats.streak.credited).toBe(false);
    const sum = (await summary(u, s.session_id)).json() as SessionSummary;
    expect(sum).toMatchObject({ tip: null, short_session: true, questions_practised: 0, streak: { credited: false } });
    expect(sum.encouragement).toContain('Next time');
    expect(fake.requests.some((r) => (r.body.response_format as { json_schema?: { name?: string } })?.json_schema?.name === 'session_summary')).toBe(false);
  });

  it('writes the tip in the language the learner spoke most (Hinglish)', async () => {
    sttReply = () => stt('Main final year mein hoon aur mera project ek chatbot hai', 'hindi');
    const u = await login();
    const { s } = await session(u, 1);
    const sum = (await summary(u, s.session_id)).json() as SessionSummary;
    expect(sum.language).toBe('hinglish');
    const req = fake.requests.find((r) => (r.body.response_format as { json_schema?: { name?: string } })?.json_schema?.name === 'session_summary')!;
    expect(JSON.stringify(req.body.messages)).toContain('Hinglish');
  });

  it('mid-session language switch: the summary follows the language spoken most (P5.6)', async () => {
    let turn = 0;
    sttReply = () =>
      ++turn === 1 ? stt('I built a library chatbot for my college') : stt('Haan, title mein spelling galat hoti hai, isliye maine fuzzy matching use kiya aur ye kaam kar gaya', 'hindi');
    const u = await login();
    const { s, stats } = await session(u, 3);
    expect(stats.dominant_language).toBe('hinglish');
    const sum = (await summary(u, s.session_id)).json() as SessionSummary;
    expect(sum.language).toBe('hinglish');
    const req = fake.requests.find((r) => (r.body.response_format as { json_schema?: { name?: string } })?.json_schema?.name === 'session_summary')!;
    expect(JSON.stringify(req.body.messages)).toContain('Hinglish');
  });

  it('streak: same day stays, next day +1, gap resets', async () => {
    const u = await login();
    expect((await session(u, 1, { qualify: true })).stats.streak.current).toBe(1);
    expect((await session(u, 1, { qualify: true })).stats.streak.current).toBe(1); // same day
    await db.query("UPDATE voice_prefs SET streak_current = 4, streak_last_day = (now() AT TIME ZONE 'Asia/Kolkata')::date - 1 WHERE user_id = $1", [u.id]);
    expect((await session(u, 1, { qualify: true })).stats.streak.current).toBe(5); // consecutive day
    await db.query("UPDATE voice_prefs SET streak_current = 4, streak_last_day = (now() AT TIME ZONE 'Asia/Kolkata')::date - 3 WHERE user_id = $1", [u.id]);
    expect((await session(u, 1, { qualify: true })).stats.streak.current).toBe(1); // gap
  });

  it('summary is owner-only and only after the session has ended', async () => {
    const a = await login();
    const b = await login();
    const live = (await create(a)).json() as CreateVoiceSessionResponse;
    expect((await summary(a, live.session_id)).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/v1/voice/sessions/${live.session_id}/end`, cookies: a.cookie });
    expect((await summary(b, live.session_id)).statusCode).toBe(404);
    expect((await summary(a, live.session_id)).statusCode).toBe(200);
  });

  it('Back to Chat appends one short recap (idempotent)', async () => {
    const u = await login();
    const conv = await newConv(u);
    const { s } = await session(u, 1, { qualify: true, body: { conversation_id: conv } });
    const r1 = (await app.inject({ method: 'POST', url: `/v1/voice/sessions/${s.session_id}/recap`, cookies: u.cookie })).json();
    const r2 = (await app.inject({ method: 'POST', url: `/v1/voice/sessions/${s.session_id}/recap`, cookies: u.cookie })).json();
    expect(r1.message_id).toBe(r2.message_id);
    const msgs = (await app.inject({ method: 'GET', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie })).json().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe('voice_recap'); // not a model answer: the UI shows no thumbs (bug bash BB-04)
    expect(msgs[0].content).toContain('Interview Practice');
    expect(msgs[0].content).toContain('Add one number that shows the impact');
    expect(msgs[0].content).toContain('Streak');
  });

  it('next activity: a new session focuses on the chosen activity (FR-9); unknown index → 400', async () => {
    const u = await login();
    const res = await create(u, { entry_point: 'next_activity', next_activity_index: 1 });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as CreateVoiceSessionResponse).session_id;
    expect((await db.query('SELECT entry_point, focus FROM voice_sessions WHERE id = $1', [id])).rows[0]).toEqual({ entry_point: 'next_activity', focus: PRESETS.mock_interview.nextActivities[1] });
    const opening = fake.requests.find((r) => !r.body.stream && !r.body.response_format && !r.path.includes('audio'))!;
    expect(JSON.stringify(opening.body.messages)).toContain(`Focus for this session: ${PRESETS.mock_interview.nextActivities[1]}`);
    expect((await create(u, { entry_point: 'next_activity', next_activity_index: 7 })).statusCode).toBe(400);
  });

  it('Hindi cards: blocked until the classifier covers Hindi, then shown with Hindi copy (CL-06, FR-11)', async () => {
    await config.setOverrides({ enabled: true, rolloutPercent: 100, experiment: { id: 'svs_v1', treatmentShare: 1 } }, 'test', 'hindi card test');
    const u = await login();
    const ask = async () => {
      const conv = await newConv(u);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conv}/messages`,
        cookies: u.cookie,
        payload: { text: 'मेरा इंटरव्यू कल है, मॉक इंटरव्यू लीजिए', client_msg_id: `m-${crypto.randomUUID()}` },
      });
      const card = res.body
        .split('\n\n')
        .filter((b) => b.startsWith('data: '))
        .map((b) => JSON.parse(b.slice(6)) as ChatStreamEvent)
        .find((e) => e.type === 'suggestion') as Extract<ChatStreamEvent, { type: 'suggestion' }> | undefined;
      return { conv, card };
    };
    expect((await ask()).card).toBeUndefined();
    // The reason-code row is written fire-and-forget after the stream ends; wait for it.
    let reasons: string[] = [];
    for (let i = 0; i < 80 && !reasons.length; i++) {
      reasons = (await db.query('SELECT outcome FROM suggestion_decisions WHERE user_id = $1', [u.id])).rows.map((r) => r.outcome as string);
      if (!reasons.length) await new Promise((r) => setTimeout(r, 25));
    }
    expect(reasons).toContain('language_not_supported');

    await config.setOverrides(
      { enabled: true, rolloutPercent: 100, experiment: { id: 'svs_v1', treatmentShare: 1 }, classifier: { languages: ['en', 'hinglish', 'hi'] } },
      'test',
      'enable hindi cards',
    );
    const { conv, card } = await ask();
    expect(card).toMatchObject({ language: 'hi', copy: { title: 'आवाज़ से इंटरव्यू की प्रैक्टिस करें', cta: 'वॉइस प्रैक्टिस आज़माएँ' } });
    const stored = (await app.inject({ method: 'GET', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie })).json().messages[1].suggestion;
    expect(stored).toMatchObject({ language: 'hi', copy: { cta: 'वॉइस प्रैक्टिस आज़माएँ' } });
  });
});

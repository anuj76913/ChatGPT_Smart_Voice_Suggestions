/**
 * Phase 4 voice sessions (S8 orchestrator, S9 speech, WS protocol) against PostgreSQL and the fake Groq server.
 * Needs TEST_DATABASE_URL. Audio is fake bytes: the fake Whisper endpoint returns scripted transcripts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { DEFAULT_SVS_CONFIG, mergeConfig, type CreateVoiceSessionResponse, type DeepPartial, type SvsConfig, type VoiceServerMessage } from '@svs/shared';
import { buildApp } from '../src/app';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { isQuestion, speakable, takeSentences } from '../src/voice/orchestrator';
import { languageOf, SpeechGateway } from '../src/voice/speech';
import { signStreamToken, verifyStreamToken } from '../src/voice/token';
import { completion, errorResponse, startFakeGroq, streamOf, type FakeGroq, type FakeResponse } from './fake-groq';

describe('voice helpers', () => {
  it('splits streamed text into sentences without breaking numbers', () => {
    expect(takeSentences('Good start. You scored 3.5 out of 5! Next ques')).toEqual([['Good start.', 'You scored 3.5 out of 5!'], 'Next ques']);
    expect(takeSentences('अच्छा। अगला सवाल')).toEqual([['अच्छा।'], 'अगला सवाल']);
    expect(takeSentences('No terminator yet')).toEqual([[], 'No terminator yet']);
  });
  it('detects questions even with closing quotes (live-run finding)', () => {
    expect(isQuestion('Tell me: “why this role?”')).toBe(true);
    expect(isQuestion('Which project? ')).toBe(true);
    expect(isQuestion('Good answer.')).toBe(false);
  });
  it('makes text safe for text-to-speech (IS-19)', () => {
    expect(speakable('**Great** answer, see https://x.com and `code` # now')).toBe('Great answer, see and code now');
  });
  it('tags transcript language by script and romanized Hindi', () => {
    expect(languageOf('I am a final year student', 'english')).toBe('en');
    expect(languageOf('Main final year mein hoon aur mera project hai', 'hindi')).toBe('hinglish');
    expect(languageOf('मैं अंतिम वर्ष का छात्र हूँ', 'hindi')).toBe('hi');
  });
  it('stream tokens are scoped to one session and user, and expire', () => {
    const t = signStreamToken('secret-secret-secret-secret-secret-32', 's1', 'u1', 1000);
    expect(verifyStreamToken('secret-secret-secret-secret-secret-32', t, 's1', 'u1', 2000)).toBe(true);
    expect(verifyStreamToken('secret-secret-secret-secret-secret-32', t, 's2', 'u1', 2000)).toBe(false);
    expect(verifyStreamToken('secret-secret-secret-secret-secret-32', t, 's1', 'u2', 2000)).toBe(false);
    expect(verifyStreamToken('secret-secret-secret-secret-secret-32', t, 's1', 'u1', 1000 + 6 * 60 * 1000)).toBe(false);
    expect(verifyStreamToken('other-secret-other-secret-other-secret', t, 's1', 'u1', 2000)).toBe(false);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

const stt = (text: string, opts: { avg?: number; nsp?: number; language?: string } = {}): FakeResponse => ({
  kind: 'json',
  body: { text, language: opts.language ?? 'english', duration: 2.1, segments: [{ avg_logprob: opts.avg ?? -0.3, no_speech_prob: opts.nsp ?? 0.01 }] },
});

d('Phase 4 voice sessions (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  let realGet: () => SvsConfig;
  let openingReply: () => FakeResponse;
  let sttReply: () => FakeResponse;
  let coachReply: () => FakeResponse;
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
    const gateway = new LlmGateway({ apiKey: 'gsk_test', baseUrl: fake.url, getConfig });
    const speech = new SpeechGateway({ apiKey: 'gsk_test', baseUrl: fake.url, getConfig });
    app = buildApp({ env, db, gateway, speech, config, limits: { chatPerMinute: 1000, loginPerMinute: 1000 } });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.close();
  });
  beforeEach(() => {
    fake.reset();
    config.get = realGet;
    openingReply = () => completion("Hi, I'm your interviewer today. Could you tell me about yourself?");
    sttReply = () => stt('I am a final year computer science student from Indore');
    coachReply = () => streamOf(['Good start. ', 'Which project are you most proud of?']);
    fake.setHandler((r) => {
      if (r.path.includes('/audio/transcriptions')) return sttReply();
      if (r.body.stream) return coachReply();
      return openingReply();
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
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: `voice${++n}` } });
    const v = res.cookies.find((c) => c.name === 'svs_session')!.value;
    return { cookie: { svs_session: v }, header: `svs_session=${v}`, id: res.json().id as string };
  };
  const chatConversation = async (cookie: Record<string, string>) => {
    const id = (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: cookie })).json().id as string;
    const prev = fake.requests.length;
    fake.setHandler((r) => (r.path.includes('/audio/transcriptions') ? sttReply() : r.body.stream ? streamOf(['Here is how to prepare for TCS.']) : openingReply()));
    await app.inject({ method: 'POST', url: `/v1/conversations/${id}/messages`, cookies: cookie, payload: { text: 'Help me prepare for my TCS Ninja interview', client_msg_id: `m-${crypto.randomUUID()}` } });
    fake.requests.splice(prev);
    fake.setHandler((r) => (r.path.includes('/audio/transcriptions') ? sttReply() : r.body.stream ? coachReply() : openingReply()));
    return id;
  };
  const create = async (cookie: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: cookie, payload: { intent: 'mock_interview', entry_point: 'suggestion_card', ...body } });
  const connect = async (u: { header: string }, s: CreateVoiceSessionResponse, extra = '') => {
    const msgs: VoiceServerMessage[] = [];
    let closed: { code: number } | null = null;
    const ws = await app.injectWS(`${s.stream.path}?token=${encodeURIComponent(s.stream.token)}${extra}`, { headers: { cookie: u.header } }, {
      onInit: (w) => {
        w.on('message', (data) => msgs.push(JSON.parse(String(data)) as VoiceServerMessage));
        w.on('close', (code) => (closed = { code }));
      },
    });
    sockets.push(ws);
    const waitFor = async <T extends VoiceServerMessage['type']>(type: T, count = 1, ms = 3000) => {
      const end = Date.now() + ms;
      while (msgs.filter((m) => m.type === type).length < count) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${type}; got ${msgs.map((m) => m.type).join(',')}`);
        await new Promise((r) => setTimeout(r, 15));
      }
      return msgs.filter((m) => m.type === type) as Array<Extract<VoiceServerMessage, { type: T }>>;
    };
    const speak = (bytes = 2048) => {
      ws.send(JSON.stringify({ type: 'turn', mime: 'audio/webm' }));
      ws.send(Buffer.alloc(bytes, 7));
    };
    return { ws, msgs, waitFor, speak, closed: () => closed };
  };

  it('creates a session: preset label, LLM opening using the chat context, stream token, limits, server event', async () => {
    const u = await login();
    const conv = await chatConversation(u.cookie);
    const res = await create(u.cookie, { conversation_id: conv });
    expect(res.statusCode).toBe(201);
    const s = res.json() as CreateVoiceSessionResponse;
    expect(s).toMatchObject({ label: 'Interview Practice', preset_id: 'interview_practice', opening: { source: 'llm', language: 'en' }, settings: { speed: 'normal' } });
    expect(s.opening.text).toContain('tell me about yourself');
    expect(s.limits).toMatchObject({ max_duration_s: 600, end_of_speech_silence_ms: 1800 });
    const openingReq = fake.requests.find((r) => !r.body.stream && !r.path.includes('audio'))!;
    expect(JSON.stringify(openingReq.body.messages)).toContain('TCS Ninja');
    expect((await db.query('SELECT status, entry_point, opening_source FROM voice_sessions WHERE id = $1', [s.session_id])).rows[0]).toEqual({ status: 'active', entry_point: 'suggestion_card', opening_source: 'llm' });
    // The event is written fire-and-forget after the response; wait for it.
    let started: Array<{ p: string }> = [];
    for (let i = 0; i < 80 && !started.length; i++) {
      started = (await db.query<{ p: string }>("SELECT props->>'preset_id' AS p FROM events WHERE event = 'voice_session_started' AND user_id = $1", [u.id])).rows;
      if (!started.length) await new Promise((r) => setTimeout(r, 25));
    }
    expect(started).toEqual([{ p: 'interview_practice' }]);
  });

  it('falls back to the preset template when the opening model misses its 600 ms budget', async () => {
    openingReply = () => ({ ...(completion('too slow') as Extract<FakeResponse, { kind: 'json' }>), delayMs: 1500 });
    const u = await login();
    const t0 = Date.now();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(s.opening).toMatchObject({ source: 'template', text: expect.stringContaining('tell me about yourself') });
  });

  it("rejects a bad token and someone else's session", async () => {
    const a = await login();
    const b = await login();
    const s = (await create(a.cookie, {})).json() as CreateVoiceSessionResponse;
    const bad = await connect(a, { ...s, stream: { ...s.stream, token: 'nope' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(bad.closed()?.code).toBe(4401);
    const other = await connect(b, s);
    await new Promise((r) => setTimeout(r, 50));
    expect(other.closed()?.code).toBe(4401);
    expect((await app.inject({ method: 'POST', url: `/v1/voice/sessions/${s.session_id}/end`, cookies: b.cookie })).statusCode).toBe(404);
  });

  it('turn loop: audio → Whisper → transcript → coach reply streamed sentence by sentence; no audio stored', async () => {
    const u = await login();
    const s = (await create(u.cookie, { conversation_id: await chatConversation(u.cookie) })).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    expect((await c.waitFor('ready'))[0]).toMatchObject({ session_id: s.session_id });
    c.speak();
    const [t] = await c.waitFor('transcript.final');
    expect(t).toMatchObject({ text: 'I am a final year computer science student from Indore', language: 'en', low_quality: false });
    const sentences = await c.waitFor('reply.sentence', 2);
    expect(sentences.map((x) => x.text)).toEqual(['Good start.', 'Which project are you most proud of?']);
    expect((await c.waitFor('reply.done'))[0]).toMatchObject({ question: true, text: 'Good start. Which project are you most proud of?' });
    const sttReq = fake.requests.find((r) => r.path.includes('/audio/transcriptions'))!;
    expect(sttReq.body).toMatchObject({ _multipart: true, model: 'whisper-large-v3-turbo', response_format: 'verbose_json' });
    const turns = (await db.query('SELECT role, transcript FROM voice_turns WHERE session_id = $1 ORDER BY at, id', [s.session_id])).rows;
    expect(turns.map((x) => x.role)).toEqual(['assistant', 'user', 'assistant']);
    const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('voice_turns','voice_sessions')")).rows.map((r) => r.column_name as string);
    expect(cols.some((col) => /audio|blob|recording/.test(col))).toBe(false);
  });

  it('follows a switch to Hinglish (reply in Latin script) and reports the dominant language (PRD-3)', async () => {
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    await c.waitFor('ready');
    sttReply = () => stt('Main final year mein hoon aur mera project ek chatbot hai', { language: 'hindi' });
    c.speak();
    expect((await c.waitFor('transcript.final'))[0]!.language).toBe('hinglish');
    await c.waitFor('reply.done');
    const coachReq = fake.requests.filter((r) => r.body.stream).at(-1)!;
    expect(JSON.stringify(coachReq.body.messages)).toContain('Latin script only');
    c.ws.send(JSON.stringify({ type: 'end' }));
    expect((await c.waitFor('session.ended'))[0]!.stats.dominant_language).toBe('hinglish');
  });

  it('noisy room: two low-quality turns in a row → one hint (PRD-2); empty transcripts skip the coach', async () => {
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    await c.waitFor('ready');
    sttReply = () => stt('uh the the project', { avg: -1.6 });
    c.speak();
    await c.waitFor('reply.done', 1);
    expect(c.msgs.some((m) => m.type === 'hint.noisy_room')).toBe(false);
    c.speak();
    await c.waitFor('hint.noisy_room');
    await c.waitFor('reply.done', 2);
    const coachCalls = fake.requests.filter((r) => r.body.stream).length;
    sttReply = () => stt('', { nsp: 0.95 });
    c.speak();
    await c.waitFor('transcript.empty');
    expect(fake.requests.filter((r) => r.body.stream).length).toBe(coachCalls);
  });

  it('refuses a second clip while a turn is processing, and oversized clips', async () => {
    coachReply = () => streamOf(['Okay.', ' Next?'], { delayFirstMs: 300 });
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    await c.waitFor('ready');
    c.speak();
    c.speak();
    await c.waitFor('busy');
    await c.waitFor('reply.done');
    override({ voice: { maxTurnAudioBytes: 1000 } });
    c.speak(5000);
    expect((await c.waitFor('error'))[0]!.code).toBe('audio_too_large');
  });

  it('coach failures: asks to repeat; after 3 failures in a row the session ends with error (IS-23)', async () => {
    coachReply = () => errorResponse(500);
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    await c.waitFor('ready');
    for (let i = 1; i <= 3; i++) {
      c.speak();
      await c.waitFor('reply.done', i); // the turn is finished; the next clip won't be refused as busy
    }
    expect(c.msgs.filter((m) => m.type === 'reply.sentence').map((m) => (m as { text: string }).text)).toEqual(Array(3).fill('Sorry, can you say that again?'));
    expect((await c.waitFor('session.ended'))[0]!.stats.end_reason).toBe('error');
  });

  it('speech-to-text failure falls back to whisper-large-v3, then reports stt_failed', async () => {
    sttReply = () => errorResponse(500);
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    await c.waitFor('ready');
    c.speak();
    expect((await c.waitFor('error'))[0]!.code).toBe('stt_failed');
    expect(fake.requests.filter((r) => r.path.includes('audio')).map((r) => r.body.model)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3']);
  });

  it('end: stats (questions, duration, WAVL), DB row and voice_session_completed', async () => {
    override({ voice: { wavlMinSessionS: 1 } });
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    await c.waitFor('ready');
    c.ws.send(JSON.stringify({ type: 'metrics', start_latency_ms: 840 }));
    c.speak();
    await c.waitFor('reply.done');
    await new Promise((r) => setTimeout(r, 1100));
    c.ws.send(JSON.stringify({ type: 'end' }));
    const [ended] = await c.waitFor('session.ended');
    expect(ended!.stats).toMatchObject({ end_reason: 'user', questions_practised: 1, user_turns: 1, dominant_language: 'en', qualifies_for_wavl: true });
    expect(ended!.stats.duration_s).toBeGreaterThanOrEqual(1);
    const row = (await db.query('SELECT status, end_reason, qualifies_for_wavl, start_latency_ms, questions_practised FROM voice_sessions WHERE id = $1', [s.session_id])).rows[0];
    expect(row).toEqual({ status: 'ended', end_reason: 'user', qualifies_for_wavl: true, start_latency_ms: 840, questions_practised: 1 });
    const ev = await (async () => {
      for (let i = 0; i < 40; i++) {
        const r = (await db.query("SELECT props FROM events WHERE event = 'voice_session_completed' AND user_id = $1", [u.id])).rows[0];
        if (r) return r.props;
        await new Promise((x) => setTimeout(x, 25));
      }
    })();
    expect(ev).toMatchObject({ qualifies_for_wavl: true, start_latency_ms: 840, end_reason: 'user' });
  });

  it('a short session does not count for WAVL; ending twice is idempotent', async () => {
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const a = (await app.inject({ method: 'POST', url: `/v1/voice/sessions/${s.session_id}/end`, cookies: u.cookie })).json();
    const b = (await app.inject({ method: 'POST', url: `/v1/voice/sessions/${s.session_id}/end`, cookies: u.cookie })).json();
    expect(a).toMatchObject({ qualifies_for_wavl: false, end_reason: 'user' });
    expect(b).toMatchObject({ session_id: s.session_id, end_reason: 'user' });
  });

  it('one live session per user: starting another supersedes the first (VS-08)', async () => {
    const u = await login();
    const first = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, first);
    await c.waitFor('ready');
    await create(u.cookie, { intent: 'pronunciation' });
    expect((await c.waitFor('session.ended'))[0]!.stats.end_reason).toBe('superseded');
  });

  it('network drop: reconnect resumes with missed turns; continue-in-text appends a recap to the chat (PRD-4)', async () => {
    const u = await login();
    const conv = await chatConversation(u.cookie);
    const s = (await create(u.cookie, { conversation_id: conv })).json() as CreateVoiceSessionResponse;
    const c1 = await connect(u, s);
    const [ready] = await c1.waitFor('ready');
    expect(ready!.resumed).toBe(false);
    c1.speak();
    const [t] = await c1.waitFor('transcript.final');
    await c1.waitFor('reply.done');
    c1.ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    const c2 = await connect(u, s, `&last_turn_id=${t!.turn_id}`);
    const [r2] = await c2.waitFor('ready');
    expect(r2!.resumed).toBe(true);
    expect(r2!.missed.map((m) => m.role)).toEqual(['assistant']);
    const out = (await app.inject({ method: 'POST', url: `/v1/voice/sessions/${s.session_id}/continue-in-text`, cookies: u.cookie })).json();
    expect(out).toMatchObject({ conversation_id: conv, stats: { end_reason: 'continue_in_text' } });
    const msgs = (await app.inject({ method: 'GET', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie })).json().messages;
    expect(msgs.at(-1).content).toContain('recap of your voice practice');
    expect(msgs.at(-1).content).toContain('I am a final year computer science student');
  });

  it('length cap: 1-minute warning, then the session ends with reason cap', async () => {
    override({ voice: { maxDurationS: 1, warnBeforeEndS: 0.5 } as never });
    const u = await login();
    const s = (await create(u.cookie, {})).json() as CreateVoiceSessionResponse;
    const c = await connect(u, s);
    await c.waitFor('ready');
    await c.waitFor('limit.warning', 1, 2000);
    expect((await c.waitFor('session.ended', 1, 2000))[0]!.stats.end_reason).toBe('cap');
  });

  it('privacy notice is acknowledged once per account (FR-6)', async () => {
    const u = await login();
    expect((await app.inject({ method: 'GET', url: '/v1/me/voice-preferences', cookies: u.cookie })).json().privacy_notice_seen).toBe(false);
    await app.inject({ method: 'POST', url: '/v1/me/privacy-notice-ack', cookies: u.cookie });
    expect((await app.inject({ method: 'GET', url: '/v1/me/voice-preferences', cookies: u.cookie })).json().privacy_notice_seen).toBe(true);
  });

  it('validates the create request and suggestion ownership', async () => {
    const a = await login();
    const b = await login();
    expect((await create(a.cookie, { intent: 'singing' })).statusCode).toBe(400);
    expect((await create(a.cookie, { suggestion_id: `sg_${crypto.randomUUID()}` })).statusCode).toBe(404);
    const conv = (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: b.cookie })).json().id;
    expect((await create(a.cookie, { conversation_id: conv })).statusCode).toBe(404);
    void DEFAULT_SVS_CONFIG;
  });
});

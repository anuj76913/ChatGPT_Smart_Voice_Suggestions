/**
 * Phase 11 v2 bets: Voice Preview Mode and quiet / whisper mode, each behind its own flag.
 * (Voice Learning Challenges were out of scope and were removed: the API and entry point must not exist.)
 * Needs TEST_DATABASE_URL (the content checks at the top run anywhere).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VOICE_INTENTS, VOICE_PREVIEWS, type ChatStreamEvent, type CreateVoiceSessionResponse, type DeepPartial, type SvsConfig } from '@svs/shared';
import { buildApp } from '../src/app';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { completion, startFakeGroq, streamOf, type FakeGroq } from './fake-groq';

describe('v2 content', () => {
  it('every intent has a ~30-second preview: coach, sample answer, coach', () => {
    for (const intent of VOICE_INTENTS) {
      const lines = VOICE_PREVIEWS[intent];
      expect(lines.map((l) => l.role)).toEqual(['coach', 'learner', 'coach']);
      const words = lines.map((l) => l.text).join(' ').split(/\s+/).length;
      expect(words, intent).toBeGreaterThan(35);
      expect(words, intent).toBeLessThan(90); // ≈ 30 s at ~2.5 words/s
    }
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Phase 11 v2 bets (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  const env = loadEnv({ APP_ENV: 'test', GROQ_API_KEY: 'gsk_test', DATABASE_URL: TEST_DB });
  const ON: DeepPartial<SvsConfig> = { v2: { previewMode: { enabled: true }, quietMode: { enabled: true } } };

  beforeAll(async () => {
    db = createDb(TEST_DB)!;
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    fake = await startFakeGroq();
    config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    app = buildApp({ env, db, config, gateway: new LlmGateway({ apiKey: 'k', baseUrl: fake.url, getConfig: () => config.get() }), limits: { chatPerMinute: 1000, loginPerMinute: 1000 }, alerts: null });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.close();
  });
  beforeEach(async () => {
    fake.reset();
    fake.setHandler((r) => (r.body.stream ? streamOf(['Sure. ']) : r.body.response_format ? completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' })) : completion('Welcome! Tell me about yourself?')));
    await config.setOverrides(ON, 'test', 'v2 on');
  });

  let n = 0;
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: `v2u${++n}` } });
    return { cookie: { svs_session: res.cookies.find((c) => c.name === 'svs_session')!.value }, id: res.json().id as string };
  };
  const createSession = (u: { cookie: Record<string, string> }, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload });

  it('everything is hidden while the flags are off', async () => {
    await config.setOverrides({}, 'test', 'v2 off');
    const u = await login();
    expect((await app.inject({ method: 'GET', url: '/v1/config/client', cookies: u.cookie })).json().features).toEqual({ preview_mode: false, quiet_mode: false });
    const s = (await createSession(u, { intent: 'mock_interview', entry_point: 'mic_button' })).json() as CreateVoiceSessionResponse;
    expect(s.settings.quiet).toBeUndefined();
  });

  it('flags on: features listed; challenges are not part of the product (no API, no entry point)', async () => {
    const u = await login();
    expect((await app.inject({ method: 'GET', url: '/v1/config/client', cookies: u.cookie })).json().features).toEqual({ preview_mode: true, quiet_mode: true });
    expect((await app.inject({ method: 'GET', url: '/v1/challenges', cookies: u.cookie })).statusCode).toBe(404);
    expect((await createSession(u, { intent: 'mock_interview', entry_point: 'challenge' })).statusCode).toBe(400);
    const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'voice_sessions' AND column_name LIKE 'challenge%'")).rows;
    expect(cols).toEqual([]);
    expect((await db.query("SELECT to_regclass('challenge_enrollments') AS t")).rows[0]!.t).toBeNull();
  });

  it('quiet mode: saved in preferences and returned in the session settings', async () => {
    const u = await login();
    expect((await createSession(u, { intent: 'spoken_english', entry_point: 'mic_button' })).json().settings.quiet).toBe(false);
    const prefs = (await app.inject({ method: 'PUT', url: '/v1/me/voice-preferences', cookies: u.cookie, payload: { voice_quiet: true } })).json();
    expect(prefs.voice_quiet).toBe(true);
    expect((await createSession(u, { intent: 'spoken_english', entry_point: 'mic_button' })).json().settings).toMatchObject({ quiet: true });
  });

  it('preview: a session can start from a preview, and preview events are tagged from the card', async () => {
    const u = await login();
    await config.setOverrides({ ...ON, enabled: true, rolloutPercent: 100, experiment: { id: 'svs_ramp', treatmentShare: 1 } } as DeepPartial<SvsConfig>, 'test', 'cards on');
    const conv = (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie })).json().id as string;
    const res = await app.inject({ method: 'POST', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie, payload: { text: 'Take my mock interview for TCS', client_msg_id: `m-${crypto.randomUUID()}` } });
    const card = res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as ChatStreamEvent)
      .find((e) => e.type === 'suggestion') as Extract<ChatStreamEvent, { type: 'suggestion' }>;
    expect(card).toBeTruthy();
    const ev = (event: string, props: Record<string, unknown>) => ({ event, event_id: crypto.randomUUID(), ts: new Date().toISOString(), session_id: 't', app_version: '1', platform: 'web-mobile', props });
    const r = (
      await app.inject({
        method: 'POST',
        url: '/v1/events',
        cookies: u.cookie,
        payload: { events: [ev('voice_preview_started', { suggestion_id: card.suggestion_id }), ev('voice_preview_ended', { suggestion_id: card.suggestion_id, seconds: 24, outcome: 'started_practice' })] },
      })
    ).json();
    expect(r.rejected).toEqual([]);
    expect((await db.query("SELECT intent_type FROM events WHERE user_id = $1 AND event LIKE 'voice_preview%'", [u.id])).rows).toEqual([{ intent_type: 'mock_interview' }, { intent_type: 'mock_interview' }]);
    const s = await createSession(u, { intent: 'mock_interview', entry_point: 'preview', suggestion_id: card.suggestion_id });
    expect(s.statusCode).toBe(201);
  });
});

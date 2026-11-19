/**
 * Split hosting (web on Vercel, API on Railway): several allowed web origins, the voice WebSocket authenticated by
 * its signed stream token alone (the browser has no API-host cookie), and the demo config applied on first start.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import type { CreateVoiceSessionResponse, VoiceServerMessage } from '@svs/shared';
import { buildApp } from '../src/app';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { SpeechGateway } from '../src/voice/speech';
import { signStreamToken, streamTokenUser } from '../src/voice/token';
import { completion, startFakeGroq, type FakeGroq } from './fake-groq';

describe('deployment settings', () => {
  it('WEB_ORIGIN takes one or more comma-separated origins', () => {
    const env = loadEnv({ APP_ENV: 'test', WEB_ORIGIN: 'https://svs.vercel.app, https://svs-git-main.vercel.app/' });
    expect(env.webOrigins).toEqual(['https://svs.vercel.app', 'https://svs-git-main.vercel.app']);
    expect(() => loadEnv({ APP_ENV: 'test', WEB_ORIGIN: 'https://ok.app,not a url' })).toThrow();
  });

  it('token-only WebSocket and demo-config-on-start are off unless asked for', () => {
    const env = loadEnv({ APP_ENV: 'test' });
    expect(env.voiceWsTokenOnly).toBe(false);
    expect(env.applyDemoConfig).toBe(false);
    expect(loadEnv({ APP_ENV: 'test', VOICE_WS_TOKEN_ONLY: 'true', APPLY_DEMO_CONFIG: '1' })).toMatchObject({ voiceWsTokenOnly: true, applyDemoConfig: true });
  });

  it('a stream token names its user only for its own session, while unexpired and untampered', () => {
    const t = signStreamToken('s'.repeat(40), 'sess-1', 'user-1', 1000);
    expect(streamTokenUser('s'.repeat(40), t, 'sess-1', 2000)).toBe('user-1');
    expect(streamTokenUser('s'.repeat(40), t, 'sess-2', 2000)).toBeNull(); // another session
    expect(streamTokenUser('s'.repeat(40), t, 'sess-1', 1000 + 6 * 60 * 1000)).toBeNull(); // expired (5 min)
    expect(streamTokenUser('x'.repeat(40), t, 'sess-1', 2000)).toBeNull(); // other secret
    const [payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'sess-1', u: 'attacker', e: 1e15 })).toString('base64url');
    expect(streamTokenUser('s'.repeat(40), `${forged}.${sig}`, 'sess-1', 2000)).toBeNull();
    expect(payload).toBeTruthy();
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('split hosting (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  const WEB = 'https://svs-demo.vercel.app';
  const env = loadEnv({ APP_ENV: 'test', GROQ_API_KEY: 'gsk_test', DATABASE_URL: TEST_DB, WEB_ORIGIN: WEB, VOICE_WS_TOKEN_ONLY: 'true' });
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    db = createDb(TEST_DB)!;
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    fake = await startFakeGroq();
    fake.setHandler(() => completion("Hi, I'm your interviewer. Tell me about yourself?"));
    const config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
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
    for (const s of sockets) s.terminate();
    await app?.close();
    await fake?.close();
    await db?.close();
  });

  const open = async (path: string, headers: Record<string, string>) => {
    const msgs: VoiceServerMessage[] = [];
    let closed: number | null = null;
    const ws = await app.injectWS(path, { headers }, {
      onInit: (w) => {
        w.on('message', (data) => msgs.push(JSON.parse(String(data)) as VoiceServerMessage));
        w.on('close', (code) => (closed = code));
      },
    });
    sockets.push(ws);
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 15));
    };
    return { msgs, closed: () => closed, until };
  };

  it('the voice WebSocket opens from the web origin with the stream token and no API-host cookie', async () => {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: 'split1' }, headers: { origin: WEB } });
    expect(login.statusCode).toBe(200);
    const cookie = { svs_session: login.cookies.find((c) => c.name === 'svs_session')!.value };
    const s = (await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: cookie, headers: { origin: WEB }, payload: { intent: 'mock_interview', entry_point: 'mic_button' } })).json() as CreateVoiceSessionResponse;
    const ws = await open(`${s.stream.path}?token=${encodeURIComponent(s.stream.token)}`, { origin: WEB }); // no cookie
    await ws.until(() => ws.msgs.some((m) => m.type === 'ready'));
    expect(ws.msgs.map((m) => m.type)).toContain('ready');
  });

  it('without a valid token, or from another site, it is refused', async () => {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: 'split2' } });
    const cookie = { svs_session: login.cookies.find((c) => c.name === 'svs_session')!.value };
    const s = (await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: cookie, payload: { intent: 'mock_interview', entry_point: 'mic_button' } })).json() as CreateVoiceSessionResponse;
    const noToken = await open(s.stream.path, { origin: WEB });
    await noToken.until(() => noToken.closed() !== null);
    expect(noToken.closed()).toBe(4401);
    // A cross-site page is stopped by the Origin check before the upgrade.
    const evil = await app.inject({ method: 'GET', url: `${s.stream.path}?token=${encodeURIComponent(s.stream.token)}`, headers: { origin: 'https://evil.example', upgrade: 'websocket', connection: 'Upgrade' } });
    expect(evil.statusCode).toBe(403);
  });
});

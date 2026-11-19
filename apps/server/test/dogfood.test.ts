/**
 * Phase 8: dogfood cohort + baseline pre-period config (P8.1, P8.4), research consent and query scrubbing (P8.2),
 * "Report a problem" (P8.3). Unit tests run anywhere; integration tests need TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SVS_CONFIG, mergeConfig, type ChatStreamEvent, type Me } from '@svs/shared';
import { buildApp } from '../src/app';
import { validateConfig } from '../src/config/schema';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { RetentionJob } from '../src/privacy/retention';
import { scrub } from '../src/privacy/scrub';
import { completion, startFakeGroq, streamOf, type FakeGroq } from './fake-groq';

/** The overrides `npm run ops:config -- preset dogfood-baseline` writes. */
const DOGFOOD_BASELINE = { enabled: true, rolloutPercent: 100, dogfoodCohorts: ['dogfood'], experiment: { id: 'svs_baseline', treatmentShare: 0 } };

describe('Phase 8 units', () => {
  it('scrubs obvious personal data from exported queries', () => {
    expect(scrub('mail me at riya.k@college.ac.in or call +91 98765 43210')).toBe('mail me at [email] or call [phone]');
    expect(scrub('my roll no 2021-0457-88 and https://drive.example/x')).toBe('my roll no [number] and [url]');
    expect(scrub('Take my mock interview for a TCS fresher role')).toBe('Take my mock interview for a TCS fresher role');
    expect(scrub('Interview on 12 March at 10')).toBe('Interview on 12 March at 10'); // short numbers stay
  });
  it('the dogfood-baseline preset is a valid config', () => {
    expect(validateConfig(mergeConfig(DEFAULT_SVS_CONFIG, DOGFOOD_BASELINE)).ok).toBe(true);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Phase 8 dogfood (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  const env = loadEnv({ APP_ENV: 'test', GROQ_API_KEY: 'gsk_test', DATABASE_URL: TEST_DB, ADMIN_USERS: 'df_admin' });

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
    await config.setOverrides(DOGFOOD_BASELINE, 'test', 'phase 8 preset');
    fake.setHandler((r) =>
      r.body.stream ? streamOf(['Here is how. ', 'Good luck!']) : completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' })),
    );
  });

  let n = 0;
  const login = async (opts: { cohort?: string; handle?: string } = {}) => {
    const handle = opts.handle ?? `df${++n}`;
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle } });
    const id = res.json().id as string;
    await db.query('UPDATE users SET is_test = false, cohort = $2 WHERE id = $1', [id, opts.cohort ?? 'test']); // like `npm run ops:cohort -- add`
    const v = res.cookies.find((c) => c.name === 'svs_session')!.value;
    return { cookie: { svs_session: v }, id };
  };
  const me = async (u: { cookie: Record<string, string> }) => (await app.inject({ method: 'GET', url: '/v1/me', cookies: u.cookie })).json() as Me;
  const askForCard = async (u: { cookie: Record<string, string> }) => {
    const conv = (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie })).json().id as string;
    const res = await app.inject({ method: 'POST', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie, payload: { text: 'Take my mock interview for TCS', client_msg_id: `m-${crypto.randomUUID()}` } });
    return res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as ChatStreamEvent)
      .find((e) => e.type === 'suggestion');
  };
  const eligibleEvent = async (userId: string) => {
    for (let i = 0; i < 80; i++) {
      const r = (await db.query('SELECT arm, experiment_id FROM events WHERE user_id = $1 AND event = $2', [userId, 'suggestion_eligible'])).rows[0];
      if (r) return r;
      await new Promise((x) => setTimeout(x, 25));
    }
    return null;
  };

  it('baseline pre-period: non-dogfood users get no card but are logged as eligible (control, baseline experiment)', async () => {
    const u = await login();
    expect(await askForCard(u)).toBeUndefined();
    expect(await eligibleEvent(u.id)).toEqual({ arm: 'control', experiment_id: 'svs_baseline' });
    expect((await db.query('SELECT status FROM suggestions WHERE user_id = $1', [u.id])).rows).toEqual([{ status: 'eligible_control' }]);
  });

  it('dogfood users see cards, outside any experiment, and are flagged in /v1/me', async () => {
    const u = await login({ cohort: 'dogfood' });
    expect(await me(u)).toMatchObject({ cohort: 'dogfood', is_dogfood: true, research_consent: null });
    expect(await askForCard(u)).toBeTruthy();
    expect(await eligibleEvent(u.id)).toEqual({ arm: 'treatment', experiment_id: null });
  });

  it('research consent can be granted and withdrawn', async () => {
    const u = await login({ cohort: 'dogfood' });
    expect((await app.inject({ method: 'POST', url: '/v1/me/research-consent', cookies: u.cookie, payload: { granted: true } })).json()).toEqual({ research_consent: 'granted' });
    expect((await me(u)).research_consent).toBe('granted');
    await app.inject({ method: 'POST', url: '/v1/me/research-consent', cookies: u.cookie, payload: { granted: false } });
    expect((await me(u)).research_consent).toBe('declined');
    expect((await app.inject({ method: 'POST', url: '/v1/me/research-consent', cookies: u.cookie, payload: { granted: 'yes' } })).statusCode).toBe(400);
  });

  it('Report a problem: dogfood and admins only, own references only, triaged by admins', async () => {
    const outsider = await login();
    const tester = await login({ cohort: 'dogfood' });
    const other = await login({ cohort: 'dogfood' });
    const otherSession = (await db.query<{ id: string }>("INSERT INTO voice_sessions (user_id, preset_id, entry_point, status) VALUES ($1, 'interview_practice', 'mic_button', 'ended') RETURNING id", [other.id])).rows[0]!.id;

    expect((await app.inject({ method: 'POST', url: '/v1/feedback', cookies: outsider.cookie, payload: { kind: 'bug', text: 'x' } })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/v1/feedback', cookies: tester.cookie, payload: { kind: 'bug', text: 'The coach repeated itself', screen: 'voice', voice_session_id: otherSession } });
    expect(res.statusCode).toBe(201);
    const row = (await db.query('SELECT kind, text, screen, voice_session_id, status FROM feedback_reports WHERE id = $1', [res.json().id])).rows[0];
    expect(row).toEqual({ kind: 'bug', text: 'The coach repeated itself', screen: 'voice', voice_session_id: null, status: 'open' }); // foreign session dropped
    expect((await app.inject({ method: 'POST', url: '/v1/feedback', cookies: tester.cookie, payload: { kind: 'bug', text: 'x'.repeat(1001) } })).statusCode).toBe(400);

    const admin = await login({ handle: 'df_admin' });
    expect((await app.inject({ method: 'GET', url: '/v1/admin/feedback', cookies: tester.cookie })).statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: '/v1/admin/feedback?status=open', cookies: admin.cookie })).json().reports as Array<{ id: string; text: string }>;
    expect(list.map((r) => r.text)).toContain('The coach repeated itself');
    const patch = await app.inject({ method: 'PATCH', url: `/v1/admin/feedback/${res.json().id}`, cookies: admin.cookie, payload: { status: 'triaged', triage: 'BB-30' } });
    expect(patch.json()).toEqual({ ok: true });
  });

  it('problem reports are deleted after privacy.feedbackRetentionDays', async () => {
    const u = await login({ cohort: 'dogfood' });
    await db.query("INSERT INTO feedback_reports (user_id, kind, text, created_at) VALUES ($1, 'bug', 'old', now() - interval '100 days'), ($1, 'bug', 'new', now())", [u.id]);
    const r = await new RetentionJob({ db, getConfig: () => config.get() }).run();
    expect(r!.feedback).toBeGreaterThanOrEqual(1);
    expect((await db.query('SELECT text FROM feedback_reports WHERE user_id = $1', [u.id])).rows).toEqual([{ text: 'new' }]);
  });

  it('voice from the mic button works without a card (organic baseline entry point)', async () => {
    const u = await login();
    const res = await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload: { intent: 'spoken_english', entry_point: 'mic_button' } });
    expect(res.statusCode).toBe(201);
    for (let i = 0; i < 80; i++) {
      const ev = (await db.query("SELECT props->>'entry_point' AS ep, arm FROM events WHERE user_id = $1 AND event = 'voice_session_started'", [u.id])).rows[0];
      if (ev) {
        expect(ev).toEqual({ ep: 'mic_button', arm: null }); // never eligible yet → no arm
        return;
      }
      await new Promise((x) => setTimeout(x, 25));
    }
    throw new Error('no voice_session_started event');
  });
});

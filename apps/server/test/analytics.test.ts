/**
 * Phase 6: event catalogue (P6.1), metrics (P6.2), dashboard API (P6.3), alerts (P6.4), experiment checks (P6.5),
 * power (P6.6) and the PRD decision rules (P6.7). Unit tests run anywhere; integration tests need TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  checkEventProps,
  DEFAULT_SVS_CONFIG,
  EVENT_CATALOGUE,
  EVENT_NAMES,
  FORBIDDEN_EVENT_PROP_KEYS,
  mergeConfig,
  PRD_REQUIRED_EVENTS,
  SERVER_EMITTED_EVENTS,
  type ChatStreamEvent,
  type CreateVoiceSessionResponse,
  type DeepPartial,
  type MetricsReport,
  type SvsConfig,
} from '@svs/shared';
import { AlertEvaluator } from '../src/analytics/alerts';
import { decideExperiment } from '../src/analytics/decision';
import { buildReport } from '../src/analytics/report';
import { compareArms, normalCdf, normalQuantile, percentile, powerFor, proportion, sampleSizePerArm, srm, twoProportionTest } from '../src/analytics/stats';
import { buildApp } from '../src/app';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { SpeechGateway } from '../src/voice/speech';
import { completion, startFakeGroq, streamOf, type FakeGroq } from './fake-groq';

const cfg0 = mergeConfig(DEFAULT_SVS_CONFIG, {});

describe('stats (P6.5/P6.6)', () => {
  it('normal CDF and quantile', () => {
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
  });
  it('two-proportion test and SRM', () => {
    const t = twoProportionTest(100, 1000, 130, 1000)!;
    expect(t.diff).toBeCloseTo(0.03, 10);
    expect(t.p).toBeCloseTo(0.0355, 3);
    expect(t.ci95[0]).toBeLessThan(0.03);
    expect(srm(5000, 5000, 0.5, 0.001)).toMatchObject({ chi2: 0, p_value: 1, mismatch: false });
    const bad = srm(4800, 5200, 0.5, 0.001);
    expect(bad.chi2).toBeCloseTo(16, 6);
    expect(bad.mismatch).toBe(true);
    expect(twoProportionTest(0, 0, 1, 2)).toBeNull();
  });
  it('sample size for a 2 pp lift matches the textbook value', () => {
    expect(sampleSizePerArm(0.1, 0.12)).toBe(3841);
    expect(powerFor(0.1, 0.12, 3841)).toBeCloseTo(0.8, 2);
  });
  it('percentile', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.95)).toBeCloseTo(19.5);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('event catalogue (P6.1)', () => {
  it('covers every event, matches the server-emitted list, and has no content keys', () => {
    expect(Object.keys(EVENT_CATALOGUE).sort()).toEqual([...EVENT_NAMES].sort());
    for (const name of EVENT_NAMES) expect(EVENT_CATALOGUE[name].source === 'server').toBe(SERVER_EMITTED_EVENTS.includes(name));
    const forbidden = new Set<string>(FORBIDDEN_EVENT_PROP_KEYS);
    for (const spec of Object.values(EVENT_CATALOGUE)) for (const key of Object.keys(spec.props)) expect(forbidden.has(key)).toBe(false);
    // The PRD's required set, each tagged with intent and language (the server adds arm).
    expect([...PRD_REQUIRED_EVENTS].sort()).toEqual(['suggestion_dismissed', 'suggestion_eligible', 'suggestion_shown', 'suggestion_tapped', 'voice_session_completed', 'voice_session_started']);
    for (const e of PRD_REQUIRED_EVENTS) expect(EVENT_CATALOGUE[e]).toMatchObject({ intent: 'required', language: 'required' });
  });
  it('rejects unknown, missing and mistyped props', () => {
    expect(checkEventProps('suggestion_shown', { suggestion_id: 'sg_1' })).toBeNull();
    expect(checkEventProps('suggestion_shown', {})).toMatch(/required/);
    expect(checkEventProps('suggestion_shown', { suggestion_id: 'sg_1', note: 'x' })).toMatch(/not in the catalogue/);
    expect(checkEventProps('summary_action', { voice_session_id: 'abc', action: 'teleport' })).toMatch(/one of/);
    expect(checkEventProps('answer_feedback', { message_id: 'm', thumbs: 'down', had_suggestion: 'yes' })).toMatch(/boolean/);
    expect(checkEventProps('suggestion_dismissed', { suggestion_id: 'sg 1' })).toMatch(/id/);
  });
});

/** A minimal report for the decision rules. */
function report(over: { start?: [number, number, number, number]; d7?: [number, number, number, number]; optOut?: [number, number]; thumbs?: [number, number, number, number]; srmBad?: boolean } = {}): MetricsReport {
  const [sc, scn, st, stn] = over.start ?? [30, 1000, 80, 1000];
  const [dc, dcn, dt, dtn] = over.d7 ?? [100, 500, 160, 500];
  const [on, od] = over.optOut ?? [10, 1000];
  const [tc, tcn, tt, ttn] = over.thumbs ?? [80, 1000, 82, 1000];
  const td = twoProportionTest(tc, tcn, tt, ttn)!;
  const s = (c: number, t: number) => ({ ...srm(c, t, 0.5, 0.001), mismatch: !!over.srmBad });
  return {
    version: 'metrics-v1',
    generated_at: '',
    window: { from: '', to: '', experiment_id: 'svs_v1', include_test: false },
    funnel: [],
    metrics: {
      wavl: [],
      card_start_rate: { ...proportion(200, 1000), by_intent: [] },
      eligible_start_rate: compareArms(proportion(sc, scn), proportion(st, stn)),
      tap_rate: proportion(300, 1000),
      sessions_per_user_week: { control: { sessions: 0, user_weeks: 0, value: null }, treatment: { sessions: 0, user_weeks: 0, value: null }, none: { sessions: 0, user_weeks: 0, value: null } },
      d7_voice_retention: compareArms(proportion(dc, dcn), proportion(dt, dtn)),
      d30_retention: compareArms(proportion(0, 0), proportion(0, 0)),
      opt_out_rate: proportion(on, od),
      thumbs_down: { with_card: proportion(tt, ttn), control_eligible: proportion(tc, tcn), diff: td.diff, p_value: td.p },
      cost: { svs_usd: 0, chat_usd: 0, by_use_case: {}, by_arm: { control: 0, treatment: 0, none: 0 }, wavl_learner_weeks: 0, per_wavl_usd: null, budget_per_wavl_usd: null },
    },
    experiment: { expected_treatment_share: 0.5, assignments: s(1000, 1000), eligible_users: s(1000, 1000), eligible_events: s(1500, 1500) },
    health: { use_cases: [], headroom: [], voice_start: { n: 0, p50_ms: null, p95_ms: null }, classifier: { calls: 0, errors: 0, error_rate: null } },
    alerts: [],
  };
}

describe('PRD decision rules (P6.7)', () => {
  it('ship: start rate ↑ and D7 ↑, guardrails hold', () => expect(decideExperiment(report(), cfg0).decision).toBe('ship'));
  it('iterate: start rate ↑ but D7 flat', () => expect(decideExperiment(report({ d7: [100, 500, 104, 500] }), cfg0).decision).toBe('iterate'));
  it('kill: opt-out > 5%', () => expect(decideExperiment(report({ optOut: [60, 1000] }), cfg0).decision).toBe('kill'));
  it('kill: thumbs-down rose significantly', () => expect(decideExperiment(report({ thumbs: [80, 1000, 130, 1000] }), cfg0).decision).toBe('kill'));
  it('inconclusive: no significant start-rate lift', () => expect(decideExperiment(report({ start: [30, 1000, 35, 1000] }), cfg0).decision).toBe('inconclusive'));
  it('invalid: sample-ratio mismatch, or no experiment', () => {
    expect(decideExperiment(report({ srmBad: true }), cfg0).decision).toBe('invalid');
    expect(decideExperiment({ ...report(), experiment: null }, cfg0).decision).toBe('invalid');
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Phase 6 analytics (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  const env = loadEnv({ APP_ENV: 'test', GROQ_API_KEY: 'gsk_test', DATABASE_URL: TEST_DB, ADMIN_USERS: 'an_admin' });

  beforeAll(async () => {
    db = createDb(TEST_DB)!;
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    fake = await startFakeGroq();
    config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    const getConfig = () => config.get();
    app = buildApp({
      env,
      db,
      config,
      gateway: new LlmGateway({ apiKey: 'k', baseUrl: fake.url, getConfig }),
      speech: new SpeechGateway({ apiKey: 'k', baseUrl: fake.url, getConfig }),
      limits: { chatPerMinute: 1000, loginPerMinute: 1000, eventsPerMinute: 1000 },
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
    await config.setOverrides({}, 'test', 'reset');
    fake.setHandler((r) => {
      if (r.body.stream) return streamOf(['Sure, ', 'here is how.']);
      if (r.body.response_format) return completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'en' }));
      return completion('Welcome! Tell me about yourself?');
    });
  });

  let n = 0;
  const login = async (handle = `an${++n}`) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle } });
    const v = res.cookies.find((c) => c.name === 'svs_session')!.value;
    // Analytics excludes test users by default; these behave like real ones.
    await db.query('UPDATE users SET is_test = false WHERE handle = $1', [handle]);
    return { cookie: { svs_session: v }, id: res.json().id as string };
  };
  const clientEvent = (event: string, props: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    event,
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    session_id: 'tab-1',
    app_version: '0.1.0',
    platform: 'web-mobile',
    props,
    ...over,
  });
  const post = async (u: { cookie: Record<string, string> }, events: unknown[]) =>
    (await app.inject({ method: 'POST', url: '/v1/events', cookies: u.cookie, payload: { events } })).json() as { accepted: number; rejected: Array<{ reason: string }> };
  const waitFor = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out');
  };

  it('tags client events from the referenced record, ignores spoofed tags, rejects foreign or unknown references (P6.1)', async () => {
    const a = await login();
    const b = await login();
    const conv = (await db.query<{ id: string }>('INSERT INTO conversations (user_id) VALUES ($1) RETURNING id', [a.id])).rows[0]!.id;
    const q = (await db.query<{ id: string }>("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'Mujhe interview ke liye kya padhna chahiye') RETURNING id", [conv])).rows[0]!.id;
    const ans = (await db.query<{ id: string }>("INSERT INTO messages (conversation_id, role, content, reply_to) VALUES ($1, 'assistant', 'ok', $2) RETURNING id", [conv, q])).rows[0]!.id;
    const plain = (await db.query<{ id: string }>("INSERT INTO messages (conversation_id, role, content, reply_to) VALUES ($1, 'assistant', 'ok', $2) RETURNING id", [conv, q])).rows[0]!.id;
    await db.query("INSERT INTO suggestions (id, message_id, conversation_id, user_id, intent, confidence, language, arm, status) VALUES ($1,$2,$3,$4,'mock_interview',0.95,'hinglish','treatment','shown')", [`sg_${ans}`, ans, conv, a.id]);
    const vs = (await db.query<{ id: string }>("INSERT INTO voice_sessions (user_id, preset_id, entry_point, status, intent, language, dominant_language) VALUES ($1,'viva_revision','mic_button','ended','viva_revision','en','hinglish') RETURNING id", [a.id])).rows[0]!.id;

    const shown = clientEvent('suggestion_shown', { suggestion_id: `sg_${ans}` }, { intent_type: 'pronunciation', language: 'hi' }); // spoofed tags
    const summary = clientEvent('summary_action', { voice_session_id: vs, action: 'back_to_chat' });
    const feedback = clientEvent('answer_feedback', { message_id: plain, thumbs: 'up', had_suggestion: false });
    const r = await post(a, [shown, summary, feedback, clientEvent('suggestion_tapped', { suggestion_id: 'sg_nope' })]);
    expect(r.accepted).toBe(3);
    expect(r.rejected[0]!.reason).toMatch(/unknown suggestion/);
    const rows = (await db.query('SELECT event_id, intent_type, language FROM events WHERE user_id = $1', [a.id])).rows;
    const get = (id: string) => rows.find((x) => x.event_id === id);
    expect(get(shown.event_id)).toMatchObject({ intent_type: 'mock_interview', language: 'hinglish' });
    expect(get(summary.event_id)).toMatchObject({ intent_type: 'viva_revision', language: 'hinglish' }); // dominant language
    expect(get(feedback.event_id)).toMatchObject({ intent_type: null, language: 'hinglish' }); // from the question it answered

    // Another user can't attach events to A's suggestion, session or message.
    const rb = await post(b, [
      clientEvent('suggestion_shown', { suggestion_id: `sg_${ans}` }),
      clientEvent('summary_action', { voice_session_id: vs, action: 'back_to_chat' }),
      clientEvent('answer_feedback', { message_id: plain, thumbs: 'down', had_suggestion: false }),
    ]);
    expect(rb.accepted).toBe(0);
    // A required tag that can't be resolved → rejected (privacy notice without an intent).
    expect((await post(a, [clientEvent('privacy_notice_shown', {})])).accepted).toBe(0);
  });

  it('end to end: every PRD event from a real card → voice flow carries intent, language and arm', async () => {
    await config.setOverrides({ enabled: true, rolloutPercent: 100, experiment: { id: 'svs_v1', treatmentShare: 1 } }, 'test', 'p6 e2e');
    const u = await login();
    const conv = (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie })).json().id as string;
    const res = await app.inject({ method: 'POST', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie, payload: { text: 'Take my mock interview for a TCS fresher role', client_msg_id: `m-${crypto.randomUUID()}` } });
    const card = res.body
      .split('\n\n')
      .filter((x) => x.startsWith('data: '))
      .map((x) => JSON.parse(x.slice(6)) as ChatStreamEvent)
      .find((e) => e.type === 'suggestion') as Extract<ChatStreamEvent, { type: 'suggestion' }>;
    expect(card).toBeTruthy();
    const sid = card.suggestion_id;
    const r = await post(u, [
      clientEvent('suggestion_shown', { suggestion_id: sid }),
      clientEvent('suggestion_tapped', { suggestion_id: sid }),
      clientEvent('mic_permission_granted', { suggestion_id: sid, entry_point: 'suggestion_card' }, { intent_type: 'mock_interview' }),
    ]);
    expect(r.rejected).toEqual([]);
    const vs = (await app.inject({ method: 'POST', url: '/v1/voice/sessions', cookies: u.cookie, payload: { intent: 'mock_interview', entry_point: 'suggestion_card', suggestion_id: sid, conversation_id: conv } })).json() as CreateVoiceSessionResponse;
    await app.inject({ method: 'POST', url: `/v1/voice/sessions/${vs.session_id}/end`, cookies: u.cookie, payload: {} });
    await post(u, [clientEvent('summary_action', { voice_session_id: vs.session_id, action: 'back_to_chat' })]);
    await waitFor(async () => (await db.query("SELECT 1 FROM events WHERE user_id = $1 AND event = 'voice_session_completed'", [u.id])).rows.length > 0);

    const evs = (await db.query('SELECT event, intent_type, language, arm, experiment_id FROM events WHERE user_id = $1', [u.id])).rows;
    for (const name of ['suggestion_eligible', 'suggestion_shown', 'suggestion_tapped', 'voice_session_started', 'voice_session_completed', 'summary_action']) {
      const e = evs.find((x) => x.event === name);
      expect(e, name).toBeTruthy();
      expect(e, name).toMatchObject({ intent_type: 'mock_interview', language: 'en', arm: 'treatment', experiment_id: 'svs_v1' });
    }
    expect(evs.find((x) => x.event === 'mic_permission_granted')).toMatchObject({ intent_type: 'mock_interview', arm: 'treatment' });
  });

  /** Hand-built fixture 50 days ago (outside every other test's data) with known answers. */
  it('computes every metric exactly on a known fixture (P6.2)', async () => {
    const EXP = 'exp_fixture';
    const B = Date.now() - 50 * 86_400_000;
    const at = (h: number) => new Date(B + h * 3_600_000).toISOString();
    const user = async (handle: string, arm: 'control' | 'treatment') => {
      const id = (await db.query<{ id: string }>("INSERT INTO users (handle, display_name, cohort, is_test, timezone) VALUES ($1, $1, 'fx', false, 'Asia/Kolkata') RETURNING id", [handle])).rows[0]!.id;
      await db.query('INSERT INTO experiment_assignments (user_id, experiment_id, arm) VALUES ($1, $2, $3)', [id, EXP, arm]);
      return id;
    };
    const ev = async (event: string, userId: string, arm: string, h: number, props: Record<string, unknown>, source = 'client') =>
      db.query(
        `INSERT INTO events (event_id, event, ts, source, user_id, session_id, experiment_id, arm, intent_type, language, props)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 's', $5, $6, 'mock_interview', 'en', $7)`,
        [event, at(h), source, userId, EXP, arm, JSON.stringify(props)],
      );
    const suggestion = async (userId: string, arm: string, status: string) => {
      const conv = (await db.query<{ id: string }>('INSERT INTO conversations (user_id) VALUES ($1) RETURNING id', [userId])).rows[0]!.id;
      const m = (await db.query<{ id: string }>("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', 'x') RETURNING id", [conv])).rows[0]!.id;
      await db.query("INSERT INTO suggestions (id, message_id, conversation_id, user_id, intent, confidence, language, arm, status) VALUES ($1,$2,$3,$4,'mock_interview',0.9,'en',$5,$6)", [`sg_${m}`, m, conv, userId, arm, status]);
      return { sid: `sg_${m}`, mid: m };
    };
    const [t1, t2, t3, c1, c2] = [await user('fx_t1', 'treatment'), await user('fx_t2', 'treatment'), await user('fx_t3', 'treatment'), await user('fx_c1', 'control'), await user('fx_c2', 'control')];
    const s1 = await suggestion(t1, 'treatment', 'tapped');
    const s2 = await suggestion(t2, 'treatment', 'shown');
    const s3 = await suggestion(t3, 'treatment', 'tapped');
    const s4 = await suggestion(c1, 'control', 'eligible_control');
    const s5 = await suggestion(c2, 'control', 'eligible_control');
    const vs = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
    for (const [u, arm, s] of [[t1, 'treatment', s1], [t2, 'treatment', s2], [t3, 'treatment', s3], [c1, 'control', s4], [c2, 'control', s5]] as const)
      await ev('suggestion_eligible', u, arm, 1, { suggestion_id: s.sid, confidence: 0.9, classifier_version: 'x' }, 'server');
    for (const [u, s] of [[t1, s1], [t2, s2], [t3, s3]] as const) await ev('suggestion_shown', u, 'treatment', 1.01, { suggestion_id: s.sid });
    for (const [u, s] of [[t1, s1], [t3, s3]] as const) {
      await ev('suggestion_tapped', u, 'treatment', 1.02, { suggestion_id: s.sid });
      await ev('mic_permission_granted', u, 'treatment', 1.03, { suggestion_id: s.sid, entry_point: 'suggestion_card' });
    }
    await ev('voice_session_started', t1, 'treatment', 2, { voice_session_id: vs[0], suggestion_id: s1.sid, entry_point: 'suggestion_card' }, 'server');
    await ev('voice_session_completed', t1, 'treatment', 2.2, { voice_session_id: vs[0], qualifies_for_wavl: true }, 'server');
    await ev('voice_session_started', t1, 'treatment', 72, { voice_session_id: vs[1], entry_point: 'practice_again' }, 'server'); // day 3 return
    await ev('voice_session_started', t3, 'treatment', 2, { voice_session_id: vs[2], suggestion_id: s3.sid, entry_point: 'suggestion_card' }, 'server');
    await ev('voice_session_completed', t3, 'treatment', 2.1, { voice_session_id: vs[2], qualifies_for_wavl: false }, 'server');
    await ev('voice_session_started', c1, 'control', 120, { voice_session_id: vs[3], entry_point: 'mic_button' }, 'server');
    await ev('voice_session_completed', c1, 'control', 120.2, { voice_session_id: vs[3], qualifies_for_wavl: true }, 'server');
    await ev('suggestions_opted_out', t2, 'treatment', 48, { source: 'card' });
    await ev('answer_feedback', t1, 'treatment', 3, { message_id: s1.mid, thumbs: 'down', had_suggestion: true });
    await ev('answer_feedback', t2, 'treatment', 3, { message_id: s2.mid, thumbs: 'up', had_suggestion: true });
    await ev('answer_feedback', c1, 'control', 3, { message_id: s4.mid, thumbs: 'up', had_suggestion: false });
    await ev('answer_feedback', c1, 'control', 4, { message_id: s4.mid, thumbs: 'down', had_suggestion: false }); // latest vote wins
    await db.query(
      `INSERT INTO llm_usage (at, use_case, model, status, prompt_tokens, completion_tokens, total_tokens, latency_ms, ttft_ms, user_id, audio_seconds) VALUES
        ($1, 'classifier', 'openai/gpt-oss-20b', 'ok', 600, 40, 640, 300, NULL, $2, NULL),
        ($1, 'stt', 'whisper-large-v3-turbo', 'ok', NULL, NULL, NULL, 400, NULL, $2, 4),
        ($1, 'chat', 'openai/gpt-oss-120b', 'ok', 1000, 500, 1500, 2000, 500, $2, NULL)`,
      [at(1), t1],
    );

    const cfg = mergeConfig(config.get(), { experiment: { id: EXP, treatmentShare: 0.5 } });
    const r = await buildReport(db, { from: new Date(B), to: new Date(B + 28 * 86_400_000), experimentId: EXP, includeTest: false }, cfg);
    const fT = r.funnel.filter((f) => f.arm === 'treatment').reduce((s, f) => s + f.steps.started, 0);
    const steps = (arm: string) => {
      const out: Record<string, number> = {};
      for (const f of r.funnel.filter((x) => x.arm === arm)) for (const [k, v] of Object.entries(f.steps)) out[k] = (out[k] ?? 0) + v;
      return out;
    };
    expect(fT).toBe(2);
    expect(steps('treatment')).toEqual({ eligible: 3, shown: 3, tapped: 2, permission_ok: 2, started: 2, completed_30s: 1, returned_d7: 1 });
    expect(steps('control')).toEqual({ eligible: 2, shown: 0, tapped: 0, permission_ok: 0, started: 0, completed_30s: 0, returned_d7: 0 });
    const m = r.metrics;
    expect(m.eligible_start_rate.treatment).toEqual(proportion(2, 3));
    expect(m.eligible_start_rate.control).toEqual(proportion(1, 2));
    expect(m.card_start_rate).toMatchObject({ num: 2, den: 3 });
    expect(m.tap_rate).toMatchObject({ num: 2, den: 3 });
    expect(m.opt_out_rate).toMatchObject({ num: 1, den: 3 });
    expect(m.d7_voice_retention.treatment).toEqual(proportion(1, 2));
    expect(m.d7_voice_retention.control).toEqual(proportion(0, 1));
    expect(m.wavl.filter((w) => w.arm === 'treatment').reduce((s, w) => s + w.learners, 0)).toBe(1);
    expect(m.wavl.filter((w) => w.arm === 'control').reduce((s, w) => s + w.learners, 0)).toBe(1);
    expect(m.sessions_per_user_week.treatment.sessions).toBe(3);
    expect(m.thumbs_down.with_card).toEqual(proportion(1, 2));
    expect(m.thumbs_down.control_eligible).toEqual(proportion(1, 1));
    // Cost: classifier 600·0.075/1M + 40·0.30/1M; STT billed at the 10 s minimum: 10/3600 · $0.04. Chat is separate.
    const svs = (600 * 0.075 + 40 * 0.3) / 1e6 + (10 / 3600) * 0.04;
    expect(m.cost.svs_usd).toBeCloseTo(svs, 12);
    expect(m.cost.chat_usd).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1e6, 12);
    expect(m.cost.per_wavl_usd).toBeCloseTo(svs / 2, 12);
    expect(m.cost.by_arm.treatment).toBeCloseTo(svs, 12);
    expect(r.experiment).toMatchObject({ assignments: { control: 2, treatment: 3 }, eligible_users: { control: 2, treatment: 3 } });
    expect(r.experiment!.assignments.mismatch).toBe(false);
    expect(r.health.use_cases.map((u) => u.use_case).sort()).toEqual(['chat', 'classifier', 'stt']);
    // Speech-to-text is billed by audio time, so it has no tokens-per-minute limit.
    expect(r.health.headroom.find((h) => h.model === 'whisper-large-v3-turbo')).toMatchObject({ tpm_limit: null });
    expect(r.health.headroom.find((h) => h.model === 'openai/gpt-oss-20b')).toMatchObject({ tpm_limit: 8000 });
  });

  it('alerts fire once, notify the webhook, and resolve when the rule clears (P6.4)', async () => {
    const u1 = await login();
    const u2 = await login();
    for (const u of [u1, u2])
      await db.query("INSERT INTO events (event_id, event, ts, source, user_id, session_id, props) VALUES (gen_random_uuid(), 'suggestion_shown', now() - interval '1 hour', 'client', $1, 's', '{}')", [u.id]);
    await db.query("INSERT INTO events (event_id, event, ts, source, user_id, session_id, props) VALUES ('99999999-9999-4999-8999-999999999999', 'suggestions_opted_out', now() - interval '30 minutes', 'client', $1, 's', '{}')", [u1.id]);
    // A minute back: the database clock and the evaluator's JS clock can differ by a few ms.
    await db.query("INSERT INTO llm_usage (at, use_case, model, status, total_tokens, latency_ms) VALUES (now() - interval '1 minute', 'classifier', 'fixture-model', 'ok', 150, 100)");

    const posts: Array<{ text: string }> = [];
    const over: DeepPartial<SvsConfig> = { analytics: { alerts: { minShownUsers: 2 }, groqLimits: { tokensPerMinute: 100 } } };
    const cfg = mergeConfig(config.get(), over);
    const evaluator = new AlertEvaluator({
      db,
      getConfig: () => cfg,
      webhookUrl: 'https://hooks.example.test/svs',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        posts.push(JSON.parse(init.body) as { text: string });
        return new Response('ok');
      }) as unknown as typeof fetch,
    });
    const first = (await evaluator.run())!;
    const byRule = (rule: string, key = '') => first.results.find((x) => x.rule === rule && x.key === key)!;
    // Other tests in this file also showed cards, so the rate is 1 / (users shown); far above 5% either way.
    expect(byRule('opt_out_rate')).toMatchObject({ status: 'firing', severity: 'critical' });
    expect(byRule('opt_out_rate').value!).toBeGreaterThan(0.05);
    expect(byRule('groq_headroom', 'fixture-model')).toMatchObject({ status: 'firing', severity: 'critical' });
    expect(byRule('cost_per_wavl').status).not.toBe('not_configured'); // budget proposed in Phase 7
    expect(byRule('voice_start_p95')).toMatchObject({ status: 'insufficient_data' });
    expect(first.opened.map((o) => o.rule)).toContain('opt_out_rate');
    expect(posts.some((p) => p.text.startsWith('[SVS critical] opt_out_rate'))).toBe(true);
    expect(JSON.stringify(posts)).not.toContain(u1.id); // no user ids in notifications

    const second = (await evaluator.run())!;
    expect(second.opened.map((o) => o.rule)).not.toContain('opt_out_rate'); // deduplicated while open
    expect((await db.query("SELECT count(*)::int AS n FROM alert_events WHERE rule = 'opt_out_rate' AND status = 'firing'")).rows[0]!.n).toBe(1);

    await db.query("DELETE FROM events WHERE event_id = '99999999-9999-4999-8999-999999999999'");
    const third = (await evaluator.run())!;
    expect(third.resolved).toContain('opt_out_rate');
    expect(posts.some((p) => p.text === '[SVS resolved] opt_out_rate')).toBe(true);
  });

  it('the analytics API is admin-only and returns the report with a decision (P6.3)', async () => {
    const user = await login();
    expect((await app.inject({ method: 'GET', url: '/v1/admin/analytics/report', cookies: user.cookie })).statusCode).toBe(403);
    const admin = await login('an_admin');
    const res = await app.inject({ method: 'GET', url: '/v1/admin/analytics/report', cookies: admin.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { report: MetricsReport; decision: { decision: string } | null };
    expect(body.report.version).toBe('metrics-v1');
    expect(body.report.window.experiment_id).toBe('svs_v1');
    expect(body.decision?.decision).toBeTruthy();
    const all = (await app.inject({ method: 'GET', url: '/v1/admin/analytics/report?experiment_id=all', cookies: admin.cookie })).json();
    expect(all).toMatchObject({ decision: null, report: { experiment: null, window: { experiment_id: null } } });
    expect((await app.inject({ method: 'GET', url: '/v1/admin/analytics/report?from=2026-11-10T00:00:00Z&to=2026-11-01T00:00:00Z', cookies: admin.cookie })).statusCode).toBe(400);
  });
});

/**
 * Phase 10: localization (P10.3: Hindi + the top 3 regional languages) and the ramp gate (P10.1, P10.2, P10.4).
 * Unit tests run anywhere; integration tests need TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  COPY_LANGUAGES,
  COPY_STATUS,
  DEFAULT_SVS_CONFIG,
  mergeConfig,
  suggestionCopy,
  VOICE_INTENTS,
  type ChatStreamEvent,
  type DeepPartial,
  type SvsConfig,
} from '@svs/shared';
import { buildApp } from '../src/app';
import { scriptInstruction } from '../src/chat/prompts';
import { detectLanguage, refineLanguage } from '../src/classifier/language';
import { prefilter } from '../src/classifier/prefilter';
import { validateConfig } from '../src/config/schema';
import { ConfigService } from '../src/config/service';
import { createDb, type Db } from '../src/db';
import { loadEnv } from '../src/env';
import { LlmGateway } from '../src/llm/gateway';
import { runMigrations } from '../src/migrate';
import { languageReadiness } from '../src/ops/language';
import { evaluateRamp } from '../src/ops/ramp';
import { languageOf } from '../src/voice/speech';
import { completion, startFakeGroq, streamOf, type FakeGroq } from './fake-groq';

describe('language detection (P10.3)', () => {
  it('tags each script, and splits Devanagari into Marathi or Hindi', () => {
    expect(detectLanguage('কাল আমার ইন্টারভিউ, একটা মক ইন্টারভিউ নিন')).toBe('bn');
    expect(detectLanguage('రేపు నాకు ఇంటర్వ్యూ ఉంది')).toBe('te');
    expect(detectLanguage('उद्या माझी मुलाखत आहे, सराव घ्या')).toBe('mr');
    expect(detectLanguage('उच्चार सुधारण्यासाठी कोणती पुस्तके वाचावीत?')).toBe('mr'); // suffix markers
    expect(detectLanguage('कल मेरा इंटरव्यू है, मॉक इंटरव्यू लीजिए')).toBe('hi');
    expect(detectLanguage('इंटरव्यू')).toBe('hi'); // no markers → Hindi, the larger language
    expect(detectLanguage('mujhe interview ki taiyari karni hai')).toBe('hinglish');
    expect(detectLanguage('Take my mock interview')).toBe('en');
  });
  it("corrects the classifier model's tag for languages it doesn't know", () => {
    expect(refineLanguage('other', 'আমার উচ্চারণ ঠিক করে দিন')).toBe('bn');
    expect(refineLanguage('hi', 'माझे उच्चार सुधारा, मी काही शब्द मोठ्याने बोलतो')).toBe('mr');
    expect(refineLanguage('hi', 'मेरा उच्चारण ठीक करवाइए')).toBe('hi');
    expect(refineLanguage('hinglish', 'mera interview lo')).toBe('hinglish');
  });
  it('maps Whisper language names', () => {
    expect(languageOf('', 'bengali')).toBe('bn');
    expect(languageOf('', 'telugu')).toBe('te');
    expect(languageOf('', 'marathi')).toBe('mr');
    expect(languageOf('', 'tamil')).toBe('other');
  });
  it('replies in the learner’s language and script (chat-v4)', () => {
    expect(scriptInstruction('আমার সাথে ইংরেজিতে কথা বলুন')).toMatch(/Bengali script/);
    expect(scriptInstruction('నాతో మాట్లాడండి')).toMatch(/Telugu script/);
    expect(scriptInstruction('मला इंग्रजी बोलण्याचा सराव करायचा आहे')).toMatch(/Marathi/);
    expect(scriptInstruction('मुझसे अंग्रेज़ी में बात कीजिए')).toMatch(/Hindi/);
  });
  it('lets regional practice requests reach the classifier (pf-v3)', () => {
    expect(prefilter('কাল আমার ইন্টারভিউ, একটা মক ইন্টারভিউ নিন').pass).toBe(true);
    expect(prefilter('రేపు DBMS వైవా ఉంది, నన్ను మౌఖిక ప్రశ్నలు అడగండి').pass).toBe(true);
    expect(prefilter('उद्या माझी मुलाखत आहे').pass).toBe(true);
    expect(prefilter('ভারতের রাজধানী কী?').pass).toBe(false);
    // pf-v4: one word is a topic, never a request (the model carded bare "interview" in Bengali / Telugu).
    for (const w of ['interview', 'ইন্টারভিউ', 'ఇంటర్వ్యూ', 'मुलाखत', '  viva  ']) expect(prefilter(w).pass, w).toBe(false);
    expect(prefilter('quiz me').pass).toBe(true);
    expect(prefilter('భారతదేశ రాజధాని ఏది?').pass).toBe(false);
  });
});

describe('card copy (FR-11)', () => {
  it('has complete copy in every language, in its own script, marked draft until reviewed', () => {
    const scripts: Record<string, RegExp> = { hi: /[ऀ-ॿ]/, mr: /[ऀ-ॿ]/, bn: /[ঀ-৿]/, te: /[ఀ-౿]/, en: /[A-Za-z]/ };
    for (const lang of COPY_LANGUAGES)
      for (const intent of VOICE_INTENTS) {
        const c = suggestionCopy(intent, lang);
        for (const v of Object.values(c)) {
          expect(v.length, `${lang} ${intent}`).toBeGreaterThan(2);
          expect(scripts[lang]!.test(v), `${lang}: ${v}`).toBe(true);
        }
        expect(c.title.length, `${lang} title fits the card`).toBeLessThanOrEqual(45);
      }
    expect(COPY_STATUS).toMatchObject({ en: 'reviewed', bn: 'draft', mr: 'draft', te: 'draft' });
    expect(suggestionCopy('mock_interview', 'ta').cta).toBe('Try Voice Practice'); // no Tamil copy yet → English
  });
  it('config accepts the new languages and rejects unknown copy languages', () => {
    expect(validateConfig(mergeConfig(DEFAULT_SVS_CONFIG, { classifier: { languages: ['en', 'hinglish', 'bn', 'mr', 'te'] } })).ok).toBe(true);
    expect(validateConfig(mergeConfig(DEFAULT_SVS_CONFIG, { copy: { languages: ['en', 'ta' as 'en'] } })).ok).toBe(false);
  });
});

describe('language readiness (P10.3 gate)', () => {
  const base = { language: 'bn' as const, copyStatus: 'draft' as const, mainRows: 16, reviewedMainRows: 0, cards: 10, precision: 1, recall: 0.9, ambiguousRows: 4, ambiguousCards: 0, unscored: 0 };
  const opts = { precisionTarget: 0.85, minReviewedRows: 100, prototype: false, prototypeMinRows: 10 };
  it('production: draft copy and too few reviewed rows block a language', () => {
    const r = languageReadiness(base, opts);
    expect(r.ready).toBe(false);
    expect(r.checks.filter((c) => c.status === 'fail').map((c) => c.name)).toEqual(['Card copy reviewed', '≥ 100 human-reviewed eval rows']);
  });
  it('prototype: relaxed (and reported) but precision and the ambiguous set still gate', () => {
    expect(languageReadiness(base, { ...opts, prototype: true })).toMatchObject({ ready: true });
    expect(languageReadiness({ ...base, precision: 0.6 }, { ...opts, prototype: true }).ready).toBe(false);
    expect(languageReadiness({ ...base, ambiguousCards: 1 }, { ...opts, prototype: true }).ready).toBe(false);
    expect(languageReadiness({ ...base, unscored: 3 }, { ...opts, prototype: true }).ready).toBe(false);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = TEST_DB ? describe : describe.skip;

d('Phase 10 (integration)', () => {
  let db: Db;
  let fake: FakeGroq;
  let app: FastifyInstance;
  let config: ConfigService;
  const env = loadEnv({ APP_ENV: 'test', GROQ_API_KEY: 'gsk_test', DATABASE_URL: TEST_DB });

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
    // The model only knows en/hinglish/hi/other: it answers "other" for Bengali, the server refines it.
    fake.setHandler((r) => (r.body.stream ? streamOf(['উত্তর। ']) : completion(JSON.stringify({ intent: 'mock_interview', confidence: 0.97, language: 'other' }))));
  });

  let n = 0;
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { handle: `lz${++n}` } });
    return { cookie: { svs_session: res.cookies.find((c) => c.name === 'svs_session')!.value }, id: res.json().id as string };
  };
  const ask = async (u: { cookie: Record<string, string> }, text: string) => {
    const conv = (await app.inject({ method: 'POST', url: '/v1/conversations', cookies: u.cookie })).json().id as string;
    const res = await app.inject({ method: 'POST', url: `/v1/conversations/${conv}/messages`, cookies: u.cookie, payload: { text, client_msg_id: `m-${crypto.randomUUID()}` } });
    const card = res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as ChatStreamEvent)
      .find((e) => e.type === 'suggestion') as Extract<ChatStreamEvent, { type: 'suggestion' }> | undefined;
    return { conv, card };
  };
  const reasons = async (userId: string) => {
    for (let i = 0; i < 80; i++) {
      const r = (await db.query<{ outcome: string; language: string }>('SELECT outcome, language FROM suggestion_decisions WHERE user_id = $1', [userId])).rows;
      if (r.length) return r;
      await new Promise((x) => setTimeout(x, 25));
    }
    return [];
  };

  it('Bengali cards: blocked until bn is enabled, then shown in Bengali (and stay Bengali on reload)', async () => {
    const on = { enabled: true, rolloutPercent: 100, experiment: { id: 'svs_ramp', treatmentShare: 1 } };
    await config.setOverrides(on, 'test', 'ramp on');
    const u = await login();
    expect((await ask(u, 'কাল আমার TCS-এর ইন্টারভিউ, আমার একটা মক ইন্টারভিউ নিন')).card).toBeUndefined();
    expect(await reasons(u.id)).toEqual([{ outcome: 'language_not_supported', language: 'bn' }]);

    await config.setOverrides({ ...on, classifier: { languages: ['en', 'hinglish', 'bn'] } } as DeepPartial<SvsConfig>, 'test', 'enable bn');
    const v = await login();
    const { conv, card } = await ask(v, 'কাল আমার TCS-এর ইন্টারভিউ, আমার একটা মক ইন্টারভিউ নিন');
    expect(card).toMatchObject({ language: 'bn', copy: { title: 'ভয়েসে ইন্টারভিউয়ের প্র্যাকটিস করুন', cta: 'ভয়েস প্র্যাকটিস করে দেখুন' } });
    const stored = (await app.inject({ method: 'GET', url: `/v1/conversations/${conv}/messages`, cookies: v.cookie })).json().messages[1].suggestion;
    expect(stored).toMatchObject({ language: 'bn' });

    // Copy turned off for bn → the card falls back to English copy (still allowed by the classifier).
    await config.setOverrides({ ...on, classifier: { languages: ['en', 'hinglish', 'bn'] }, copy: { languages: ['en'] } } as DeepPartial<SvsConfig>, 'test', 'bn copy off');
    const w = await login();
    expect((await ask(w, 'কাল আমার TCS-এর ইন্টারভিউ, আমার একটা মক ইন্টারভিউ নিন')).card).toMatchObject({ language: 'en', copy: { cta: 'Try Voice Practice' } });
  });

  describe('ramp gate', () => {
    const cfgAt = (o: DeepPartial<SvsConfig>) => mergeConfig(config.get(), o);

    it('a first step with little data is allowed, with warnings, not failures', async () => {
      await db.query("DELETE FROM alert_events");
      const r = await evaluateRamp(db, cfgAt({ enabled: false, rolloutPercent: 0 }), 50);
      expect(r.allowed).toBe(true);
      expect(r.checks.find((c) => c.name === 'Opt-out ≤ 5%')?.status).toBe('warn');
      expect(r.checks.find((c) => c.name === 'Target rollout')?.status).toBe('pass');
    });

    it('blocks: going down, too soon after the last step, or a critical alert firing', async () => {
      await config.setOverrides({ enabled: true, rolloutPercent: 50 }, 'test', 'ramp to 50');
      const at50 = cfgAt({ enabled: true, rolloutPercent: 50 });
      expect((await evaluateRamp(db, at50, 25)).checks.find((c) => c.name === 'Target rollout')?.status).toBe('fail');
      const soon = await evaluateRamp(db, at50, 100);
      expect(soon.allowed).toBe(false);
      expect(soon.checks.find((c) => c.name === 'Time at current step')?.status).toBe('fail');
      // 4 days later the time check passes …
      const later = await evaluateRamp(db, at50, 100, new Date(Date.now() + 4 * 86_400_000));
      expect(later.checks.find((c) => c.name === 'Time at current step')?.status).toBe('pass');
      // … but not with a critical alert firing.
      await db.query("INSERT INTO alert_events (rule, key, severity, status) VALUES ('opt_out_rate', '', 'critical', 'firing')");
      const alerted = await evaluateRamp(db, at50, 100, new Date(Date.now() + 4 * 86_400_000));
      expect(alerted.checks.find((c) => c.name === 'No critical alerts firing')).toMatchObject({ status: 'fail', detail: 'opt_out_rate' });
      expect(alerted.allowed).toBe(false);
    });

    it('fails when the opt-out guardrail is breached', async () => {
      await db.query("DELETE FROM alert_events");
      const users = await Promise.all([1, 2, 3, 4].map(() => login()));
      for (const u of users) await db.query("INSERT INTO events (event_id, event, ts, source, user_id, session_id) VALUES (gen_random_uuid(), 'suggestion_shown', now() - interval '1 day', 'client', $1, 's')", [u.id]);
      await db.query("UPDATE users SET is_test = false WHERE id = ANY($1)", [users.map((u) => u.id)]);
      await db.query("INSERT INTO events (event_id, event, ts, source, user_id, session_id) VALUES (gen_random_uuid(), 'suggestions_opted_out', now() - interval '12 hours', 'client', $1, 's')", [users[0]!.id]);
      const r = await evaluateRamp(db, cfgAt({ enabled: true, rolloutPercent: 50, analytics: { alerts: { minShownUsers: 3 } } }), 100, new Date(Date.now() + 4 * 86_400_000));
      expect(r.checks.find((c) => c.name === 'Opt-out ≤ 5%')?.status).toBe('fail');
    });
  });
});

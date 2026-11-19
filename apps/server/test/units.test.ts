import { describe, expect, it } from 'vitest';
import { DEFAULT_SVS_CONFIG, mergeConfig, type SvsConfig } from '@svs/shared';
import { bucketOf, evaluateSuggestionGate } from '../src/config/gate';
import { validateConfig } from '../src/config/schema';
import { ConfigService } from '../src/config/service';
import { validateClientEvent } from '../src/events/validate';
import { LlmError } from '../src/llm/errors';
import { Semaphore } from '../src/llm/semaphore';
import { RateLimiter } from '../src/rate-limit';
import { buildChatMessages, detectScript, HISTORY_CHAR_BUDGET } from '../src/chat/prompts';

const cfg = (o: Parameters<typeof mergeConfig>[1]): SvsConfig => mergeConfig(DEFAULT_SVS_CONFIG, o);

describe('config validation (CF-04)', () => {
  it('accepts the defaults', () => expect(validateConfig(DEFAULT_SVS_CONFIG)).toEqual({ ok: true }));
  it('rejects a threshold that would show cards everywhere', () =>
    expect(validateConfig(cfg({ classifier: { thresholds: { mock_interview: 0 } } })).ok).toBe(false));
  it('rejects rollout above 100%', () => expect(validateConfig(cfg({ rolloutPercent: 150 })).ok).toBe(false));
  it('rejects an empty kill-switch rule', () => expect(validateConfig(cfg({ killSwitch: [{}] })).ok).toBe(false));
  it('rejects unknown keys', () => expect(validateConfig({ ...DEFAULT_SVS_CONFIG, surprise: 1 } as unknown as SvsConfig).ok).toBe(false));
  it('rejects an empty model id', () => expect(validateConfig(cfg({ llm: { models: { chat: { primary: '', fallback: null } } } })).ok).toBe(false));
  it('merges objects and replaces arrays', () => {
    const m = cfg({ copy: { languages: ['en', 'hi'] }, cap: { perRollingWeek: 2 } });
    expect(m.copy.languages).toEqual(['en', 'hi']);
    expect(m.cap).toEqual({ ...DEFAULT_SVS_CONFIG.cap, perRollingWeek: 2 });
  });
});

describe('suggestion gate (architecture §10 evaluation order)', () => {
  const ctx = { userId: 'user-1', region: 'IN', language: 'hinglish', cohort: 'students' };
  it('fails closed on stale config', () => expect(evaluateSuggestionGate(cfg({ enabled: true, rolloutPercent: 100 }), ctx, { fresh: false }).reason).toBe('stale_config'));
  it('is off while disabled', () => expect(evaluateSuggestionGate(DEFAULT_SVS_CONFIG, ctx, { fresh: true })).toEqual({ allowed: false, reason: 'disabled' }));
  it('lets dogfood cohorts in while disabled and regardless of rollout', () =>
    expect(evaluateSuggestionGate(cfg({ dogfoodCohorts: ['students'] }), ctx, { fresh: true })).toEqual({ allowed: true, reason: 'dogfood' }));
  it('kill switch beats dogfood and rollout', () =>
    expect(evaluateSuggestionGate(cfg({ enabled: true, rolloutPercent: 100, dogfoodCohorts: ['students'], killSwitch: [{ language: 'hinglish' }] }), ctx, { fresh: true }).reason).toBe('kill_switch'));
  it('kill-switch rules need every set field to match', () =>
    expect(evaluateSuggestionGate(cfg({ enabled: true, rolloutPercent: 100, killSwitch: [{ region: 'IN', cohort: 'other' }] }), ctx, { fresh: true }).allowed).toBe(true));
  it('respects rollout 0% and 100%', () => {
    expect(evaluateSuggestionGate(cfg({ enabled: true, rolloutPercent: 0 }), ctx, { fresh: true }).reason).toBe('rollout');
    expect(evaluateSuggestionGate(cfg({ enabled: true, rolloutPercent: 100 }), ctx, { fresh: true }).reason).toBe('ok');
  });
  it('buckets are deterministic and roughly uniform', () => {
    expect(bucketOf('abc')).toBe(bucketOf('abc'));
    const c = cfg({ enabled: true, rolloutPercent: 10 });
    let inRollout = 0;
    for (let i = 0; i < 10000; i++) if (evaluateSuggestionGate(c, { userId: `u${i}` }, { fresh: true }).allowed) inRollout++;
    expect(inRollout).toBeGreaterThan(800);
    expect(inRollout).toBeLessThan(1200);
  });
});

describe('ConfigService staleness (CF-03)', () => {
  it('becomes stale 5 minutes after the last good load when the database fails', async () => {
    let now = 0;
    const failingDb = { query: async () => { throw new Error('down'); }, tx: async () => { throw new Error('down'); }, ping: async () => {}, close: async () => {} };
    const s = new ConfigService(failingDb, { reloadMs: 15000, now: () => now });
    await s.load();
    expect(s.isFresh()).toBe(true);
    now = 5 * 60 * 1000 + 1;
    expect(s.isFresh()).toBe(false);
    expect(s.get()).toEqual(DEFAULT_SVS_CONFIG);
  });
});

describe('client event validation (P1.7)', () => {
  const base = {
    event: 'answer_feedback',
    event_id: '3f1c2a64-8a0b-4c3e-9d7a-2b6f1e0c9a11',
    ts: '2026-11-16T10:00:00.000Z',
    session_id: 'tab-1',
    app_version: '0.1.0',
    platform: 'web-mobile',
    props: { message_id: 'b2b6b0c4-0d0e-4b8f-9a77-6d4a8b7c1e22', thumbs: 'up', had_suggestion: false },
  };
  it('accepts a well-formed event', () => expect(validateClientEvent(base).ok).toBe(true));
  it('rejects server-only events from the client (EX-05)', () => expect(validateClientEvent({ ...base, event: 'suggestion_eligible' }).ok).toBe(false));
  it('rejects content-carrying prop keys (SF-04)', () => expect(validateClientEvent({ ...base, props: { query: 'interview' } }).ok).toBe(false));
  it('rejects long free-text strings', () => expect(validateClientEvent({ ...base, props: { note: 'x'.repeat(65) } }).ok).toBe(false));
  it('rejects multi-line strings', () => expect(validateClientEvent({ ...base, props: { note: 'a\nb' } }).ok).toBe(false));
  it('rejects client-supplied user_id or arm', () => expect(validateClientEvent({ ...base, user_id: 'someone-else', arm: 'treatment' }).ok).toBe(false));
  it('rejects unknown event names and bad ids', () => {
    expect(validateClientEvent({ ...base, event: 'made_up' }).ok).toBe(false);
    expect(validateClientEvent({ ...base, event_id: 'nope' }).ok).toBe(false);
  });
  it('rejects more than 20 props', () =>
    expect(validateClientEvent({ ...base, props: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }).ok).toBe(false));
});

describe('Semaphore (per-use-case concurrency budgets)', () => {
  it('queues callers beyond the limit and rejects as busy after the wait budget', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire(100);
    await expect(s.acquire(50)).rejects.toMatchObject({ kind: 'busy' });
    const waiting = s.acquire(500);
    release();
    const r2 = await waiting;
    expect(s.inUse).toBe(1);
    r2();
    expect(s.inUse).toBe(0);
  });
  it('rejects a waiting caller that aborts', async () => {
    const s = new Semaphore(1);
    await s.acquire(100);
    const ctrl = new AbortController();
    const p = s.acquire(1000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(LlmError);
  });
});

describe('RateLimiter', () => {
  it('allows `limit` calls per window then reports retry-after', () => {
    let t = 0;
    const rl = new RateLimiter(2, 60000, () => t);
    expect(rl.take('u').ok).toBe(true);
    expect(rl.take('u').ok).toBe(true);
    expect(rl.take('u')).toEqual({ ok: false, retryAfterS: 60 });
    expect(rl.take('other').ok).toBe(true);
    t = 60000;
    expect(rl.take('u').ok).toBe(true);
  });
});

describe('reply script detection (chat-v3)', () => {
  it('treats English and romanized Hinglish as Latin, Hindi as Devanagari', () => {
    expect(detectScript('What is a deadlock?')).toBe('latin');
    expect(detectScript('Python mein list aur tuple ka difference kya hai?')).toBe('latin');
    expect(detectScript('न्यूटन का पहला नियम क्या है?')).toBe('devanagari');
    expect(detectScript('DBMS ka viva: नॉर्मलाइज़ेशन समझाओ')).toBe('devanagari');
    expect(detectScript('12345 ???')).toBe('latin');
  });
  it('adds the script instruction for the latest user message to the system prompt', () => {
    const msgs = buildChatMessages([
      { role: 'user', content: 'न्यूटन का नियम' },
      { role: 'assistant', content: 'उत्तर' },
      { role: 'user', content: 'Ab Hinglish mein batao' },
    ]);
    expect(msgs[0]!.content).toContain('Latin script only');
    expect(msgs[0]!.content).not.toContain('Reply in Hindi using Devanagari');
  });
});

describe('chat prompt history budget (LLM-11)', () => {
  it('keeps the newest turns within the character budget and always keeps the latest message', () => {
    const big = 'x'.repeat(HISTORY_CHAR_BUDGET - 10);
    const msgs = buildChatMessages([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: big },
      { role: 'user', content: 'latest question that is long enough to exceed' },
    ]);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs.at(-1)!.content).toContain('latest question');
    expect(msgs.some((m) => m.content === 'old question')).toBe(false);
  });
});

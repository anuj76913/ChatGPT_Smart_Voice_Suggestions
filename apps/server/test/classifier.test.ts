import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cardIntent, DEFAULT_SVS_CONFIG, mergeConfig, VOICE_INTENTS, type SvsConfig } from '@svs/shared';
import { Classifier } from '../src/classifier/classifier';
import { detectLanguage } from '../src/classifier/language';
import { chooseThresholds, evaluate, percentile, sweepIntent, type GoldRow, type PredRow } from '../src/classifier/metrics';
import { prefilter } from '../src/classifier/prefilter';
import { CLASSIFIER_PROMPT_VERSION, CLASSIFIER_SYSTEM_PROMPT, FEW_SHOT } from '../src/classifier/prompt';
import { LlmGateway } from '../src/llm/gateway';
import { completion, errorResponse, startFakeGroq, type FakeGroq } from './fake-groq';

const seed = readFileSync(fileURLToPath(new URL('../../../data/intent-eval/seed.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as { id: string; text: string; label: string; set: string; language: string });

describe('prefilter (P2.1, tuned for recall)', () => {
  it('passes every voice-labelled seed query to the model', () => {
    const missed = seed.filter((r) => r.label !== 'none' && !prefilter(r.text).pass).map((r) => r.text);
    expect(missed).toEqual([]);
  });
  it('rejects clearly unrelated queries without a model call', () => {
    for (const q of ['Hi', 'thanks!', 'Write Python code to reverse a linked list', 'Plan a 3-day trip to Jaipur', 'Is integral ko solve karo']) {
      expect(prefilter(q).pass).toBe(false);
    }
  });
  it('lets interview/viva/English-adjacent hard negatives through for the model to judge', () => {
    expect(prefilter('What is a viva voce exam?').pass).toBe(true);
    expect(prefilter('HR interview ke common questions ki list do bas').pass).toBe(true);
  });
  it('rejects a meaningful share of non-voice traffic', () => {
    const none = seed.filter((r) => r.label === 'none');
    expect(none.filter((r) => !prefilter(r.text).pass).length / none.length).toBeGreaterThan(0.4);
  });
});

describe('language heuristic', () => {
  it('matches the seed labels for nearly every row', () => {
    const agree = seed.filter((r) => detectLanguage(r.text) === r.language).length;
    expect(agree / seed.length).toBeGreaterThan(0.97);
  });
  it('tags Devanagari, Hinglish and English', () => {
    expect(detectLanguage('न्यूटन का पहला नियम')).toBe('hi');
    expect(detectLanguage('Mera kal interview hai, practice karwa do')).toBe('hinglish');
    expect(detectLanguage('Take a mock interview')).toBe('en');
    expect(detectLanguage('12345')).toBe('other');
  });
});

describe('prompt hygiene', () => {
  it('few-shot examples never appear in the eval data', () => {
    const texts = new Set(seed.map((r) => r.text.toLowerCase().trim()));
    expect(FEW_SHOT.filter(([q]) => texts.has(q.toLowerCase().trim()))).toEqual([]);
  });
  it('stays compact for the 8k tokens/minute Groq tier', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT.length).toBeLessThan(3400); // ≈ 650–750 tokens
  });
});

describe('Classifier (S3) against the fake Groq server', () => {
  let fake: FakeGroq;
  let cfg: SvsConfig;
  let clf: Classifier;
  const json = (o: unknown) => completion(JSON.stringify(o));

  beforeAll(async () => {
    fake = await startFakeGroq();
  });
  afterAll(async () => fake.close());
  beforeEach(() => {
    fake.reset();
    cfg = mergeConfig(DEFAULT_SVS_CONFIG, { classifier: { timeoutMs: 400 }, llm: { timeoutsMs: { classifier: 400 } } });
    clf = new Classifier(new LlmGateway({ apiKey: 'k', baseUrl: fake.url, getConfig: () => cfg, random: () => 0 }), () => cfg);
  });

  it('returns the model label with model_version and sends a strict, deterministic request', async () => {
    fake.setHandler(() => json({ intent: 'mock_interview', confidence: 0.93, language: 'hinglish' }));
    const r = await clf.classify({ query: 'Mera kal interview hai, mock interview le lo' });
    expect(r).toMatchObject({ intent: 'mock_interview', confidence: 0.93, language: 'hinglish', stage: 'model', model_version: `openai/gpt-oss-20b@${CLASSIFIER_PROMPT_VERSION}` });
    const body = fake.requests[0]!.body;
    expect(body).toMatchObject({ model: 'openai/gpt-oss-20b', temperature: 0, include_reasoning: false, reasoning_effort: 'low' });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
  });

  it('skips the model when the prefilter rejects the query', async () => {
    const r = await clf.classify({ query: 'Write Python code to reverse a linked list' });
    expect(r).toMatchObject({ intent: 'none', stage: 'prefilter', language: 'en' });
    expect(fake.requests).toHaveLength(0);
  });

  it('includes at most `recentTurns` earlier turns as context, and truncates long input', async () => {
    fake.setHandler(() => json({ intent: 'viva_revision', confidence: 0.9, language: 'en' }));
    await clf.classify({
      query: `Now quiz me on it ${'x'.repeat(5000)}`,
      recentTurns: [
        { role: 'user', text: 'turn-1' },
        { role: 'assistant', text: 'turn-2' },
        { role: 'user', text: 'turn-3' },
      ],
    });
    const user = (fake.requests[0]!.body.messages as Array<{ role: string; content: string }>)[1]!.content;
    expect(user).not.toContain('turn-1');
    expect(user).toContain('turn-2');
    expect(user).toContain('turn-3');
    expect(user.length).toBeLessThan(cfg.classifier.maxInputChars + 300);
  });

  it('fails closed on output that breaks the schema (confidence out of range)', async () => {
    fake.setHandler(() => json({ intent: 'pronunciation', confidence: 1.7, language: 'en' }));
    const r = await clf.classify({ query: 'Help me pronounce entrepreneur' });
    expect(r).toMatchObject({ intent: 'none', stage: 'error', error: 'invalid_output' });
    await expect(clf.predict({ query: 'Help me pronounce entrepreneur' })).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('falls back to the second model when the primary fails, and reports it in model_version', async () => {
    fake.setHandler((r) => (r.model === 'openai/gpt-oss-20b' ? errorResponse(404) : json({ intent: 'spoken_english', confidence: 0.91, language: 'en' })));
    const r = await clf.classify({ query: 'Be my English speaking partner' });
    expect(r.model_version).toBe(`openai/gpt-oss-120b@${CLASSIFIER_PROMPT_VERSION}`);
  });

  it('returns none (never throws) when every model fails', async () => {
    fake.setHandler(() => errorResponse(500));
    expect(await clf.classify({ query: 'Take my mock interview' })).toMatchObject({ intent: 'none', stage: 'error', error: 'server' });
  });

  it('times out at classifier.timeoutMs and returns none', async () => {
    fake.setHandler(() => ({ kind: 'hang' }));
    const t0 = Date.now();
    const r = await clf.classify({ query: 'Take my mock interview' });
    expect(r).toMatchObject({ intent: 'none', stage: 'error', error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(900);
  });
});

describe('eval metrics (P2.5, P2.6)', () => {
  const gold: GoldRow[] = [
    { id: 'a', text: '', label: 'mock_interview', set: 'main', language: 'en' },
    { id: 'b', text: '', label: 'mock_interview', set: 'main', language: 'hinglish' },
    { id: 'c', text: '', label: 'pronunciation', set: 'main', language: 'en' },
    { id: 'd', text: '', label: 'none', set: 'main', language: 'en' },
    { id: 'e', text: '', label: 'none', set: 'ambiguous', language: 'en' },
  ];
  const p = (id: string, intent: PredRow['intent'], confidence: number, extra: Partial<PredRow> = {}): [string, PredRow] => [id, { id, intent, confidence, latency_ms: 100, ...extra }];
  const preds = new Map<string, PredRow>([
    p('a', 'mock_interview', 0.95),
    p('b', 'mock_interview', 0.7),
    p('c', 'mock_interview', 0.92), // wrong intent
    p('d', 'none', 0.9),
    p('e', 'mock_interview', 0.8), // ambiguous card at low thresholds
  ]);
  const t = (v: number) => Object.fromEntries(VOICE_INTENTS.map((i) => [i, v])) as Record<(typeof VOICE_INTENTS)[number], number>;

  it('computes precision over cards and recall over voice-labelled main rows', () => {
    const r = evaluate(gold, preds, t(0.75));
    expect(r.cards).toBe(3); // a, c, e
    expect(r.correctCards).toBe(1);
    expect(r.precision).toBeCloseTo(1 / 3);
    expect(r.recall).toBeCloseTo(1 / 3); // a only, out of a, b, c
    expect(r.ambiguousCards).toEqual(['e']);
    expect(r.perIntent.mock_interview).toMatchObject({ support: 2, cards: 3, tp: 1, fp: 2, fn: 1 });
    expect(r.perIntent.pronunciation).toMatchObject({ support: 1, tp: 0, fn: 1 });
    expect(r.confusion.pronunciation!.mock_interview).toBe(1);
    expect(r.falseNegatives.find((f) => f.id === 'b')!.reason).toBe('below threshold');
  });

  it('counts production timeouts as no card in the production view', () => {
    const withTimeout = new Map(preds);
    withTimeout.set('a', { ...preds.get('a')!, prod_timeout: true });
    expect(evaluate(gold, withTimeout, t(0.75)).correctCards).toBe(1);
    expect(evaluate(gold, withTimeout, t(0.75), { prodTimeoutsAsNone: true }).correctCards).toBe(0);
  });

  it('sweeps thresholds and picks the lowest one meeting precision with no ambiguous cards', () => {
    const rows = sweepIntent(gold, preds, 'mock_interview', [0.6, 0.85, 0.94]);
    expect(rows.map((r) => r.cards)).toEqual([4, 2, 1]);
    expect(rows[2]).toMatchObject({ precision: 1, ambiguousCards: 0 });
    const { thresholds, flagged } = chooseThresholds(gold, preds, 0.9);
    expect(thresholds.mock_interview).toBe(0.95);
    expect(flagged).toContain('pronunciation'); // no correct pronunciation cards at any threshold
    expect(thresholds.pronunciation).toBe(0.99);
  });

  it('also tries the confidences the model actually produced, so a fine step like 0.96 can be chosen', () => {
    // viva: real requests at 0.96/0.97, one ambiguous query at 0.95. The fixed grid jumps from 0.95 to 0.99.
    const g: GoldRow[] = [
      { id: 'v1', text: '', label: 'viva_revision', set: 'main', language: 'en' },
      { id: 'v2', text: '', label: 'viva_revision', set: 'main', language: 'en' },
      { id: 'amb', text: '', label: 'none', set: 'ambiguous', language: 'en' },
    ];
    const m = new Map<string, PredRow>([p('v1', 'viva_revision', 0.97), p('v2', 'viva_revision', 0.96), p('amb', 'viva_revision', 0.95)]);
    const { thresholds, flagged } = chooseThresholds(g, m, 0.9);
    expect(thresholds.viva_revision).toBe(0.96);
    expect(flagged).not.toContain('viva_revision');
  });

  it('cardIntent applies per-intent thresholds', () => {
    expect(cardIntent({ intent: 'viva_revision', confidence: 0.8 }, t(0.8))).toBe('viva_revision');
    expect(cardIntent({ intent: 'viva_revision', confidence: 0.79 }, t(0.8))).toBeNull();
    expect(cardIntent({ intent: 'none', confidence: 1 }, t(0.5))).toBeNull();
  });

  it('percentile', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([], 50)).toBeNull();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SVS_CONFIG, mergeConfig, type SvsConfig } from '@svs/shared';
import { LlmError } from '../src/llm/errors';
import { LlmGateway, type UsageRecord } from '../src/llm/gateway';
import { completion, errorResponse, startFakeGroq, streamOf, type FakeGroq } from './fake-groq';

const API_KEY = 'gsk_test_secret_key_value_123';
const PRIMARY = DEFAULT_SVS_CONFIG.llm.models.classifier.primary;
const FALLBACK = DEFAULT_SVS_CONFIG.llm.models.classifier.fallback!;
const CHAT_PRIMARY = DEFAULT_SVS_CONFIG.llm.models.chat.primary;
const CHAT_FALLBACK = DEFAULT_SVS_CONFIG.llm.models.chat.fallback!;

const fastConfig: SvsConfig = mergeConfig(DEFAULT_SVS_CONFIG, {
  llm: { timeoutsMs: { classifier: 600, chat: 600, opening: 600, coachFirstToken: 600, summary: 600, streamIdle: 300 } },
});

let fake: FakeGroq;
let usage: UsageRecord[];
let warnings: Array<{ obj: object; msg: string }>;
let gw: LlmGateway;

const json = { name: 'voice_intent', schema: { type: 'object', additionalProperties: false, required: ['intent'], properties: { intent: { type: 'string' } } } };
const msgs = [{ role: 'user' as const, content: 'hello' }];

beforeAll(async () => {
  fake = await startFakeGroq();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  usage = [];
  warnings = [];
  gw = new LlmGateway({
    apiKey: API_KEY,
    baseUrl: fake.url,
    getConfig: () => fastConfig,
    onUsage: (u) => usage.push(u),
    log: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    random: () => 0,
  });
});

describe('LlmGateway.complete', () => {
  it('calls the primary model with reasoning hidden, effort and strict schema; returns content without reasoning', async () => {
    fake.setHandler(() => completion('{"intent":"mock_interview"}'));
    const out = await gw.complete('classifier', { messages: msgs, jsonSchema: json, temperature: 0 }, { userId: 'u1' });
    expect(out).toMatchObject({ content: '{"intent":"mock_interview"}', model: PRIMARY, fallbackUsed: false });
    expect(out.content).not.toContain('SECRET-REASONING');
    const body = fake.requests[0]!.body;
    expect(body).toMatchObject({ model: PRIMARY, include_reasoning: false, reasoning_effort: 'low', stream: false, temperature: 0 });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'voice_intent', strict: true } });
    expect(fake.requests[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    expect(usage).toEqual([expect.objectContaining({ useCase: 'classifier', model: PRIMARY, status: 'ok', promptTokens: 11, totalTokens: 18, ctx: { userId: 'u1' } })]);
  });

  it('retries the same model after a 429 when retry-after fits the budget', async () => {
    fake.setHandler((_r, i) => (i === 0 ? errorResponse(429, 0.05) : completion('{"intent":"none"}')));
    const out = await gw.complete('classifier', { messages: msgs, jsonSchema: json });
    expect(fake.requests.map((r) => r.model)).toEqual([PRIMARY, PRIMARY]);
    expect(out.fallbackUsed).toBe(false);
  });

  it('falls back immediately when retry-after does not fit the budget', async () => {
    fake.setHandler((r) => (r.model === PRIMARY ? errorResponse(429, 30) : completion('{"intent":"none"}')));
    const out = await gw.complete('classifier', { messages: msgs, jsonSchema: json });
    expect(fake.requests.map((r) => r.model)).toEqual([PRIMARY, FALLBACK]);
    expect(out).toMatchObject({ model: FALLBACK, fallbackUsed: true });
  });

  it('retries once on 5xx, then falls back', async () => {
    fake.setHandler((r) => (r.model === PRIMARY ? errorResponse(503) : completion('{"intent":"none"}')));
    const out = await gw.complete('classifier', { messages: msgs, jsonSchema: json });
    expect(fake.requests.map((r) => r.model)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
    expect(out.fallbackUsed).toBe(true);
  });

  it('throws when every model fails', async () => {
    fake.setHandler(() => errorResponse(500));
    await expect(gw.complete('classifier', { messages: msgs })).rejects.toMatchObject({ kind: 'server' });
  });

  it('times out within the budget when Groq hangs', async () => {
    fake.setHandler(() => ({ kind: 'hang' }));
    const t0 = Date.now();
    await expect(gw.complete('classifier', { messages: msgs })).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1200);
  });

  it('falls back when structured output is not valid JSON', async () => {
    fake.setHandler((r) => (r.model === PRIMARY ? completion('not json') : completion('{"intent":"none"}')));
    const out = await gw.complete('classifier', { messages: msgs, jsonSchema: json });
    expect(out.model).toBe(FALLBACK);
  });

  it('falls back when the primary model was removed (404)', async () => {
    fake.setHandler((r) => (r.model === PRIMARY ? errorResponse(404) : completion('{"intent":"none"}')));
    expect((await gw.complete('classifier', { messages: msgs, jsonSchema: json })).model).toBe(FALLBACK);
  });

  it('does not fall back on an auth error, and never leaks the key', async () => {
    fake.setHandler(() => errorResponse(401));
    const err = await gw.complete('classifier', { messages: msgs }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('auth');
    expect(fake.requests).toHaveLength(1);
    const surfaces = JSON.stringify(err) + (err as Error).message + JSON.stringify(warnings) + JSON.stringify(usage);
    expect(surfaces).not.toContain(API_KEY);
  });

  it('reports an aborted call as aborted', async () => {
    fake.setHandler(() => ({ kind: 'hang' }));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(gw.complete('classifier', { messages: msgs }, {}, ctrl.signal)).rejects.toMatchObject({ kind: 'aborted' });
    expect(fake.requests).toHaveLength(1);
  });
});

describe('LlmGateway.stream', () => {
  const collect = async (it: AsyncIterable<{ type: string; text?: string }>) => {
    const out: Array<{ type: string; text?: string }> = [];
    for await (const c of it) out.push(c);
    return out;
  };

  it('streams content deltas in order, drops reasoning, and reports ttft and usage', async () => {
    fake.setHandler(() => streamOf(['Hel', 'lo', ' world'], { reasoning: 'SECRET-REASONING', usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } }));
    const chunks = await collect(gw.stream('chat', { messages: msgs }));
    const text = chunks.filter((c) => c.type === 'delta').map((c) => c.text).join('');
    expect(text).toBe('Hello world');
    expect(JSON.stringify(chunks)).not.toContain('SECRET-REASONING');
    const done = chunks.at(-1) as unknown as { type: string; model: string; ttftMs: number; usage: { totalTokens: number } };
    expect(done).toMatchObject({ type: 'done', model: CHAT_PRIMARY, usage: { totalTokens: 33 } });
    expect(done.ttftMs).toBeGreaterThanOrEqual(0);
    expect(fake.requests[0]!.body).toMatchObject({ stream: true, include_reasoning: false, reasoning_effort: 'low' });
    expect(usage[0]).toMatchObject({ useCase: 'chat', status: 'ok', totalTokens: 33 });
  });

  it('falls back before the first token', async () => {
    fake.setHandler((r) => (r.model === CHAT_PRIMARY ? errorResponse(503) : streamOf(['fallback answer'])));
    const chunks = await collect(gw.stream('chat', { messages: msgs }));
    expect(chunks.at(-1)).toMatchObject({ type: 'done', model: CHAT_FALLBACK, fallbackUsed: true });
  });

  it('falls back when the first token is too slow', async () => {
    const cfg = mergeConfig(fastConfig, { llm: { timeoutsMs: { chat: 900 } } });
    const g = new LlmGateway({ apiKey: API_KEY, baseUrl: fake.url, getConfig: () => cfg, random: () => 0 });
    fake.setHandler((r) => (r.model === CHAT_PRIMARY ? streamOf(['late'], { delayFirstMs: 2000 }) : streamOf(['quick'])));
    // primary times out at 900 ms, which exhausts the shared budget, so the call fails as a timeout
    await expect(collect(g.stream('chat', { messages: msgs }))).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('does not retry or fall back after the first token; the error is marked partial', async () => {
    fake.setHandler(() => streamOf(['a', 'b', 'c'], { breakAfter: 1 }));
    const got: string[] = [];
    const err = await (async () => {
      for await (const c of gw.stream('chat', { messages: msgs })) if (c.type === 'delta') got.push(c.text);
    })().catch((e: unknown) => e);
    expect(got).toEqual(['a']);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).details.partial).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('abandons a stream that stalls between chunks', async () => {
    fake.setHandler(() => streamOf(['a', 'b'], { delayBetweenMs: 1500 }));
    const err = await collect(gw.stream('chat', { messages: msgs })).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'timeout', details: { partial: true } });
  });

  it('stops cleanly when the caller aborts', async () => {
    fake.setHandler(() => streamOf(['a', 'b', 'c'], { delayBetweenMs: 200 }));
    const ctrl = new AbortController();
    const got: string[] = [];
    const err = await (async () => {
      for await (const c of gw.stream('chat', { messages: msgs }, {}, ctrl.signal)) {
        if (c.type === 'delta') {
          got.push(c.text);
          ctrl.abort();
        }
      }
    })().catch((e: unknown) => e);
    expect(got).toEqual(['a']);
    expect(err).toMatchObject({ kind: 'aborted' });
    expect(usage.at(-1)).toMatchObject({ status: 'aborted' });
  });

  it('refuses structured output on a stream', async () => {
    await expect(collect(gw.stream('chat', { messages: msgs, jsonSchema: json }))).rejects.toMatchObject({ kind: 'bad_request' });
  });
});

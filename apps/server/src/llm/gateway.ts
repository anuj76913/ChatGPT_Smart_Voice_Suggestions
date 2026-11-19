import { readSseData, type LlmUseCase, type SvsConfig } from '@svs/shared';
import { httpError, LlmError, NO_FALLBACK, RETRY_SAME_MODEL } from './errors';
import { Semaphore } from './semaphore';

/**
 * S13 LLM Gateway: the only code that calls Groq (architecture §6.7).
 * - model + fallback, timeouts, reasoning effort and concurrency per use case, all read from config on every call
 * - at most `maxRetries` retries per model, only for 429/5xx/network, honouring retry-after, only within the time budget
 * - streaming: retries/fallback only before the first token; after that, errors surface as `partial`
 * - reasoning text is never requested (`include_reasoning: false`) and never returned
 * - token usage metered per call via `onUsage`; the API key is never logged or put in errors
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Strict structured output (architecture §6.7.2). Not combinable with streaming on Groq. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface CallContext {
  userId?: string;
  conversationId?: string;
  voiceSessionId?: string;
  arm?: string | null;
}

export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface UsageRecord extends TokenUsage {
  useCase: LlmUseCase;
  model: string;
  status: 'ok' | 'error' | 'aborted';
  errorKind?: string;
  fallbackUsed: boolean;
  latencyMs: number;
  ttftMs: number | null;
  ctx: CallContext;
}

export interface CompleteResult {
  content: string;
  model: string;
  fallbackUsed: boolean;
  usage: TokenUsage;
  latencyMs: number;
}

export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'done'; model: string; fallbackUsed: boolean; ttftMs: number; usage: TokenUsage };

export interface GatewayDeps {
  apiKey: string;
  baseUrl: string;
  getConfig: () => SvsConfig;
  fetchImpl?: typeof fetch;
  onUsage?: (u: UsageRecord) => void;
  log?: { warn: (obj: object, msg: string) => void };
  random?: () => number;
}

const BUDGET_KEY: Record<LlmUseCase, keyof SvsConfig['llm']['timeoutsMs']> = {
  chat: 'chat',
  coach: 'coachFirstToken',
  classifier: 'classifier',
  opening: 'opening',
  summary: 'summary',
};

const NO_USAGE: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };

function toUsage(u: unknown): TokenUsage {
  if (!u || typeof u !== 'object') return NO_USAGE;
  const o = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  return { promptTokens: n(o.prompt_tokens), completionTokens: n(o.completion_tokens), totalTokens: n(o.total_tokens) };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new LlmError('aborted', 'aborted'));
      },
      { once: true },
    );
  });

export class LlmGateway {
  private readonly semaphores = new Map<LlmUseCase, Semaphore>();
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;

  constructor(private readonly deps: GatewayDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.random = deps.random ?? Math.random;
  }

  /** Non-streaming call (classifier, opening line, summary). */
  async complete(useCase: LlmUseCase, req: LlmRequest, ctx: CallContext = {}, signal?: AbortSignal): Promise<CompleteResult> {
    const cfg = this.deps.getConfig();
    const start = Date.now();
    const deadline = start + cfg.llm.timeoutsMs[BUDGET_KEY[useCase]];
    const release = await this.semaphore(useCase, cfg).acquire(deadline - Date.now(), signal).catch((e) => {
      this.report({ useCase, model: cfg.llm.models[useCase].primary, status: 'error', errorKind: (e as LlmError).kind, fallbackUsed: false, latencyMs: Date.now() - start, ttftMs: null, ...NO_USAGE, ctx });
      throw e;
    });
    let lastErr: LlmError | undefined;
    try {
      const models = this.models(useCase, cfg);
      for (let mi = 0; mi < models.length; mi++) {
        const model = models[mi]!;
        const fallbackUsed = mi > 0;
        for (let attempt = 0; attempt <= cfg.llm.maxRetries; attempt++) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const t0 = Date.now();
          try {
            const json = await this.postJson(model, this.body(useCase, model, req, cfg, false), remaining, signal);
            const content = (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
            if (typeof content !== 'string') throw new LlmError('invalid_output', 'response had no content', { model });
            if (req.jsonSchema) {
              try {
                JSON.parse(content);
              } catch {
                throw new LlmError('invalid_output', 'structured output was not valid JSON', { model });
              }
            }
            const usage = toUsage((json as { usage?: unknown }).usage);
            const latencyMs = Date.now() - start;
            this.report({ useCase, model, status: 'ok', fallbackUsed, latencyMs, ttftMs: null, ...usage, ctx });
            return { content, model, fallbackUsed, usage, latencyMs };
          } catch (e) {
            const err = e instanceof LlmError ? e : new LlmError('network', 'request failed', { model });
            lastErr = err;
            this.report({ useCase, model, status: err.kind === 'aborted' ? 'aborted' : 'error', errorKind: err.kind, fallbackUsed, latencyMs: Date.now() - t0, ttftMs: null, ...NO_USAGE, ctx });
            this.deps.log?.warn({ useCase, model, kind: err.kind, status: err.details.status }, 'groq call failed');
            if (NO_FALLBACK.has(err.kind)) throw err;
            if (!RETRY_SAME_MODEL.has(err.kind) || attempt >= cfg.llm.maxRetries) break;
            const wait = err.details.retryAfterMs ?? this.backoff();
            if (Date.now() + wait >= deadline) break;
            await sleep(wait, signal);
          }
        }
        if (Date.now() >= deadline) break;
      }
      throw lastErr ?? new LlmError('timeout', 'time budget exhausted');
    } finally {
      release();
    }
  }

  /** Streaming call (chat answer, coach replies). Yields text deltas, then one `done`. */
  async *stream(useCase: LlmUseCase, req: LlmRequest, ctx: CallContext = {}, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    if (req.jsonSchema) throw new LlmError('bad_request', 'structured output cannot be streamed on Groq');
    const cfg = this.deps.getConfig();
    const start = Date.now();
    const deadline = start + cfg.llm.timeoutsMs[BUDGET_KEY[useCase]];
    const idleMs = cfg.llm.timeoutsMs.streamIdle;
    const release = await this.semaphore(useCase, cfg).acquire(deadline - Date.now(), signal);
    let lastErr: LlmError | undefined;
    try {
      const models = this.models(useCase, cfg);
      for (let mi = 0; mi < models.length; mi++) {
        const model = models[mi]!;
        const fallbackUsed = mi > 0;
        for (let attempt = 0; attempt <= cfg.llm.maxRetries; attempt++) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const t0 = Date.now();
          const ctrl = new AbortController();
          const onExternalAbort = () => ctrl.abort('external');
          signal?.addEventListener('abort', onExternalAbort, { once: true });
          if (signal?.aborted) ctrl.abort('external');
          let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ctrl.abort('first_token_timeout'), remaining);
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let ttftMs: number | null = null;
          let usage = NO_USAGE;
          try {
            const res = await this.fetchImpl(`${this.deps.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: this.headers(),
              body: JSON.stringify(this.body(useCase, model, req, cfg, true)),
              signal: ctrl.signal,
            });
            if (!res.ok || !res.body) throw await httpError(res, model);
            for await (const data of readSseData(res.body)) {
              if (data === '[DONE]') break;
              let json: Record<string, unknown>;
              try {
                json = JSON.parse(data) as Record<string, unknown>;
              } catch {
                throw new LlmError('invalid_output', 'malformed stream chunk', { model });
              }
              if (json.error) throw new LlmError('server', 'error event in stream', { model });
              const u = json.usage ?? (json.x_groq as { usage?: unknown } | undefined)?.usage;
              if (u) usage = toUsage(u);
              const delta = (json.choices as Array<{ delta?: { content?: unknown } }> | undefined)?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                if (ttftMs === null) {
                  ttftMs = Date.now() - start;
                  clearTimeout(firstTimer);
                  firstTimer = undefined;
                }
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => ctrl.abort('idle_timeout'), idleMs);
                yield { type: 'delta', text: delta };
              }
            }
            if (ttftMs === null) throw new LlmError('invalid_output', 'stream ended without content', { model });
            this.report({ useCase, model, status: 'ok', fallbackUsed, latencyMs: Date.now() - start, ttftMs, ...usage, ctx });
            yield { type: 'done', model, fallbackUsed, ttftMs, usage };
            return;
          } catch (e) {
            const err = this.mapStreamError(e, ctrl.signal, model, ttftMs !== null);
            lastErr = err;
            this.report({ useCase, model, status: err.kind === 'aborted' ? 'aborted' : 'error', errorKind: err.kind, fallbackUsed, latencyMs: Date.now() - t0, ttftMs, ...usage, ctx });
            if (err.kind !== 'aborted') this.deps.log?.warn({ useCase, model, kind: err.kind, status: err.details.status, partial: err.details.partial }, 'groq stream failed');
            if (err.details.partial || NO_FALLBACK.has(err.kind)) throw err;
            if (!RETRY_SAME_MODEL.has(err.kind) || attempt >= cfg.llm.maxRetries) break;
            const wait = err.details.retryAfterMs ?? this.backoff();
            if (Date.now() + wait >= deadline) break;
            await sleep(wait, signal);
          } finally {
            clearTimeout(firstTimer);
            clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onExternalAbort);
            ctrl.abort('done'); // releases the HTTP connection if the consumer stopped early
          }
        }
        if (Date.now() >= deadline) break;
      }
      throw lastErr ?? new LlmError('timeout', 'no first token within budget');
    } finally {
      release();
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private models(useCase: LlmUseCase, cfg: SvsConfig): string[] {
    const { primary, fallback } = cfg.llm.models[useCase];
    return fallback && fallback !== primary ? [primary, fallback] : [primary];
  }

  private semaphore(useCase: LlmUseCase, cfg: SvsConfig): Semaphore {
    let s = this.semaphores.get(useCase);
    if (!s) {
      s = new Semaphore(cfg.llm.concurrency[useCase]);
      this.semaphores.set(useCase, s);
    } else s.setMax(cfg.llm.concurrency[useCase]);
    return s;
  }

  private headers() {
    return { Authorization: `Bearer ${this.deps.apiKey}`, 'Content-Type': 'application/json' };
  }

  private body(useCase: LlmUseCase, model: string, req: LlmRequest, cfg: SvsConfig, stream: boolean) {
    return {
      model,
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_completion_tokens: req.maxTokens } : {}),
      reasoning_effort: cfg.llm.reasoningEffort[useCase],
      include_reasoning: false,
      stream,
      ...(req.jsonSchema
        ? { response_format: { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } } }
        : {}),
    };
  }

  private async postJson(model: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await this.fetchImpl(`${this.deps.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!res.ok) throw await httpError(res, model);
      try {
        return await res.json();
      } catch {
        throw new LlmError('invalid_output', 'response was not JSON', { model });
      }
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (signal?.aborted) throw new LlmError('aborted', 'aborted by caller', { model });
      if (timeout.aborted) throw new LlmError('timeout', `no response within ${timeoutMs} ms`, { model });
      throw new LlmError('network', 'network error', { model });
    }
  }

  private mapStreamError(e: unknown, signal: AbortSignal, model: string, started: boolean): LlmError {
    const reason = signal.aborted ? String(signal.reason) : null;
    let err: LlmError;
    if (reason === 'external') err = new LlmError('aborted', 'aborted by caller', { model });
    else if (reason === 'first_token_timeout') err = new LlmError('timeout', 'no first token within budget', { model });
    else if (reason === 'idle_timeout') err = new LlmError('timeout', 'stream stalled', { model });
    else if (e instanceof LlmError) err = e;
    else err = new LlmError('network', 'stream interrupted', { model });
    return started && err.kind !== 'aborted' ? new LlmError(err.kind, err.message, { ...err.details, partial: true }) : err;
  }

  private backoff() {
    return 200 + Math.floor(this.random() * 300);
  }

  private report(u: UsageRecord) {
    try {
      this.deps.onUsage?.(u);
    } catch {
      /* metering must never break a call */
    }
  }
}

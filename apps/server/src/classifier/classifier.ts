import { z } from 'zod';
import { INTENT_LABELS, MODEL_LANGUAGES, type ClassifierResult, type SvsConfig } from '@svs/shared';
import { LlmError } from '../llm/errors';
import type { CallContext, LlmGateway } from '../llm/gateway';
import { detectLanguage, refineLanguage } from './language';
import { prefilter, PREFILTER_VERSION } from './prefilter';
import { buildClassifierMessages, CLASSIFIER_JSON_SCHEMA, CLASSIFIER_PROMPT_VERSION, type RecentTurn } from './prompt';

export interface ClassifyInput {
  query: string;
  /** Up to `classifier.recentTurns` earlier turns, oldest first. */
  recentTurns?: RecentTurn[];
}

/** Server-side validation of the model output (P2.3): even strict-schema output is checked before use. */
const ModelOutput = z
  .object({
    intent: z.enum(INTENT_LABELS),
    confidence: z.number().min(0).max(1),
    language: z.enum(MODEL_LANGUAGES),
  })
  .strict();

/**
 * S3 Intent Classifier (FR-1, architecture §6.1).
 *   classify(): never throws. Prefilter miss → `none` with no Groq call; any failure or timeout → `none` (fail closed).
 *   predict(): the model step only; throws LlmError. Used by the eval harness, which needs real errors.
 */
export class Classifier {
  constructor(
    private readonly gateway: LlmGateway,
    private readonly getConfig: () => SvsConfig,
  ) {}

  private prepare(input: ClassifyInput) {
    const cfg = this.getConfig();
    const query = input.query.trim().slice(0, cfg.classifier.maxInputChars);
    const turns = (input.recentTurns ?? []).slice(-cfg.classifier.recentTurns);
    return { cfg, query, turns };
  }

  async predict(input: ClassifyInput, ctx: CallContext = {}, signal?: AbortSignal): Promise<ClassifierResult> {
    const { query, turns } = this.prepare(input);
    const res = await this.gateway.complete(
      'classifier',
      { messages: buildClassifierMessages(query, turns), temperature: 0, maxTokens: 300, jsonSchema: CLASSIFIER_JSON_SCHEMA },
      ctx,
      signal,
    );
    let parsed: z.infer<typeof ModelOutput>;
    try {
      parsed = ModelOutput.parse(JSON.parse(res.content));
    } catch {
      throw new LlmError('invalid_output', 'classifier output failed validation', { model: res.model });
    }
    return {
      intent: parsed.intent,
      confidence: parsed.confidence,
      // The model only knows en / hinglish / hi / other; regional scripts are tagged by the server (Phase 10).
      language: refineLanguage(parsed.language, query),
      model_version: `${res.model}@${CLASSIFIER_PROMPT_VERSION}`,
      latency_ms: res.latencyMs,
      stage: 'model',
    };
  }

  async classify(input: ClassifyInput, ctx: CallContext = {}): Promise<ClassifierResult> {
    const started = Date.now();
    const { cfg, query } = this.prepare(input);
    if (!query || !prefilter(query).pass) {
      return { intent: 'none', confidence: 1, language: detectLanguage(query), model_version: `prefilter@${PREFILTER_VERSION}`, latency_ms: Date.now() - started, stage: 'prefilter' };
    }
    // Hard ceiling from config (classifier.timeoutMs), on top of the gateway's own budget.
    const timeout = AbortSignal.timeout(cfg.classifier.timeoutMs);
    try {
      return await this.predict(input, ctx, timeout);
    } catch (err) {
      const kind = timeout.aborted ? 'timeout' : err instanceof LlmError ? err.kind : 'internal';
      return {
        intent: 'none',
        confidence: 0,
        language: detectLanguage(query),
        model_version: `error@${CLASSIFIER_PROMPT_VERSION}`,
        latency_ms: Date.now() - started,
        stage: 'error',
        error: kind,
      };
    }
  }
}

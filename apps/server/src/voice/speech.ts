import type { ClassifierLanguage, SvsConfig } from '@svs/shared';
import { detectLanguage } from '../classifier/language';
import { httpError, LlmError } from '../llm/errors';

/**
 * S9 Speech Gateway, MVP = speech-to-text only (decisions.md ADR-005; TTS runs in the browser).
 * Groq Whisper `whisper-large-v3-turbo` (fallback `whisper-large-v3`), `verbose_json` for language + quality signals.
 * Audio is forwarded and never stored (architecture §6.8, §13.3).
 */
export interface Transcript {
  text: string;
  language: ClassifierLanguage;
  /** Whisper's own language guess, e.g. "english", "hindi". */
  whisperLanguage: string | null;
  avgLogprob: number | null;
  noSpeechProb: number | null;
  lowQuality: boolean;
  model: string;
  latencyMs: number;
}

export interface SpeechDeps {
  apiKey: string;
  baseUrl: string;
  getConfig: () => SvsConfig;
  fetchImpl?: typeof fetch;
  onUsage?: (u: { model: string; status: 'ok' | 'error'; errorKind?: string; latencyMs: number; audioBytes: number; audioSeconds?: number | null; userId?: string; voiceSessionId?: string }) => void;
}

/** Biases Whisper toward romanized Hinglish rather than Devanagari when learners mix languages. */
const PROMPT_HINT = 'Haan, main interview ke liye ready hoon. Let me explain the concept. Mujhe thoda time chahiye.';
const STT_TIMEOUT_MS = 8000;

export class SpeechGateway {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly deps: SpeechDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async transcribe(audio: Uint8Array, mime: string, ctx: { userId?: string; voiceSessionId?: string } = {}): Promise<Transcript> {
    const cfg = this.deps.getConfig();
    const models = [cfg.stt.model, cfg.stt.fallbackModel].filter((m, i, a) => m && a.indexOf(m) === i);
    let last: LlmError | undefined;
    for (const model of models) {
      const t0 = Date.now();
      try {
        const form = new FormData();
        const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
        form.append('file', new Blob([audio], { type: mime }), `turn.${ext}`);
        form.append('model', model);
        form.append('response_format', 'verbose_json');
        form.append('temperature', '0');
        form.append('prompt', PROMPT_HINT);
        const res = await this.fetchImpl(`${this.deps.baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.deps.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(STT_TIMEOUT_MS),
        });
        if (!res.ok) throw await httpError(res, model);
        const json = (await res.json()) as { text?: string; language?: string; duration?: number; segments?: Array<{ avg_logprob?: number; no_speech_prob?: number; end?: number }> };
        const text = (json.text ?? '').trim();
        const segs = json.segments ?? [];
        const avgLogprob = segs.length ? segs.reduce((s, x) => s + (x.avg_logprob ?? 0), 0) / segs.length : null;
        const noSpeechProb = segs.length ? Math.max(...segs.map((x) => x.no_speech_prob ?? 0)) : null;
        const lowQuality =
          text.length === 0 ||
          (avgLogprob !== null && avgLogprob < cfg.voice.sttMinAvgLogprob) ||
          (noSpeechProb !== null && noSpeechProb > cfg.voice.sttMaxNoSpeechProb);
        const latencyMs = Date.now() - t0;
        // Audio length for cost per WAVL: `duration` when Groq returns it, else the last segment's end time.
        const audioSeconds = typeof json.duration === 'number' ? json.duration : segs.length ? Math.max(...segs.map((x) => x.end ?? 0)) : null;
        this.deps.onUsage?.({ model, status: 'ok', latencyMs, audioBytes: audio.byteLength, audioSeconds, ...ctx });
        return { text, language: languageOf(text, json.language ?? null), whisperLanguage: json.language ?? null, avgLogprob, noSpeechProb, lowQuality, model, latencyMs };
      } catch (e) {
        last = e instanceof LlmError ? e : new LlmError(e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'network', 'speech-to-text failed', { model });
        this.deps.onUsage?.({ model, status: 'error', errorKind: last.kind, latencyMs: Date.now() - t0, audioBytes: audio.byteLength, ...ctx });
        if (last.kind === 'auth') break;
      }
    }
    throw last ?? new LlmError('server', 'speech-to-text failed');
  }
}

/** Our language tag for a transcript: the text decides (Devanagari / romanized Hindi / English); Whisper breaks ties. */
export function languageOf(text: string, whisperLanguage: string | null): ClassifierLanguage {
  const fromText = detectLanguage(text);
  if (fromText !== 'other') return fromText;
  const w = (whisperLanguage ?? '').toLowerCase();
  const WHISPER: Record<string, ClassifierLanguage> = { english: 'en', en: 'en', hindi: 'hi', hi: 'hi', bengali: 'bn', bn: 'bn', marathi: 'mr', mr: 'mr', telugu: 'te', te: 'te' };
  return WHISPER[w] ?? 'other';
}

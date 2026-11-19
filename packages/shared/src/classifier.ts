import type { ClassifierLanguage, IntentLabel, VoiceIntent } from './intents';

/** Output of S3 `classify()` (architecture §6.1). Never throws into the chat path: failures come back as `none`. */
export interface ClassifierResult {
  intent: IntentLabel;
  confidence: number;
  language: ClassifierLanguage;
  /** `<groq-model>@<prompt-version>`, or `prefilter@<version>` when no model call was made. */
  model_version: string;
  latency_ms: number;
  /** prefilter = rejected by the keyword prefilter (no Groq call); model = Groq answered; error = timeout/invalid/etc. */
  stage: 'prefilter' | 'model' | 'error';
  /** Error kind when stage = error (reason code for funnel metrics). */
  error?: string;
}

/** The card decision for a classifier result: the voice intent to suggest, or null for no card. */
export function cardIntent(r: Pick<ClassifierResult, 'intent' | 'confidence'>, thresholds: Record<VoiceIntent, number>): VoiceIntent | null {
  if (r.intent === 'none') return null;
  return r.confidence >= thresholds[r.intent] ? r.intent : null;
}

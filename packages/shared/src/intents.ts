/** Voice-friendly learning intents the classifier can detect (FR-1). */
export const VOICE_INTENTS = [
  'mock_interview',
  'spoken_english',
  'viva_revision',
  'pronunciation',
] as const;
export type VoiceIntent = (typeof VOICE_INTENTS)[number];

/** All classifier labels, including the negative class. */
export const INTENT_LABELS = [...VOICE_INTENTS, 'none'] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

/**
 * Language tags used everywhere (queries, events, voice turns, eval rows). Phase 10 adds the top 3 regional
 * languages: bn (Bengali), mr (Marathi), te (Telugu). The server decides the tag (scripts + marker words);
 * the classifier model only reports MODEL_LANGUAGES, which stays unchanged so its prompt and eval cache stay valid.
 */
export const CLASSIFIER_LANGUAGES = ['en', 'hinglish', 'hi', 'bn', 'mr', 'te', 'other'] as const;
export type ClassifierLanguage = (typeof CLASSIFIER_LANGUAGES)[number];
/** What the classifier model itself may answer (its JSON schema; clf-v2). */
export const MODEL_LANGUAGES = ['en', 'hinglish', 'hi', 'other'] as const;
/** Phase 10 regional languages (2011 Census: most-spoken first languages after Hindi). Re-rank with `npm run analytics:languages`. */
export const REGIONAL_LANGUAGES = ['bn', 'mr', 'te'] as const;
export const LANGUAGE_NAMES: Record<ClassifierLanguage, string> = {
  en: 'English',
  hinglish: 'Hinglish',
  hi: 'Hindi',
  bn: 'Bengali',
  mr: 'Marathi',
  te: 'Telugu',
  other: 'Other',
};

/** Task presets opened by one tap on the suggestion card (FR-3, architecture §6.4). */
export const PRESET_BY_INTENT: Record<VoiceIntent, { presetId: string; label: string }> = {
  mock_interview: { presetId: 'interview_practice', label: 'Interview Practice' },
  spoken_english: { presetId: 'spoken_english', label: 'Spoken English Practice' },
  viva_revision: { presetId: 'viva_revision', label: 'Viva / Oral Revision' },
  pronunciation: { presetId: 'pronunciation', label: 'Pronunciation Practice' },
};

/** How a voice session was started (architecture §8). */
/** Phase 11 adds `preview` (Start practising after a voice preview). */
export const ENTRY_POINTS = ['suggestion_card', 'mic_button', 'practice_again', 'next_activity', 'preview'] as const;
export type EntryPoint = (typeof ENTRY_POINTS)[number];

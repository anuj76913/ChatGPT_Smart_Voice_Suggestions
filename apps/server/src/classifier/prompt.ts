import { INTENT_LABELS, MODEL_LANGUAGES } from '@svs/shared';
import type { LlmMessage } from '../llm/gateway';

/**
 * P2.2 classifier prompt. Kept compact (~650 tokens) because the Groq free tier allows 8k tokens/minute.
 * Bump CLASSIFIER_PROMPT_VERSION on any change: cached eval predictions become stale and CI asks for a re-run.
 *
 * v2 (after the v1 eval): v1 gave cards to bare topic queries ("pronunciation", "accent kaise improve kare"),
 * sent mother-tongue-influence requests to spoken_english, sent "be my interviewer… questions poocho" to
 * viva_revision, and used almost only 0.92/0.95 confidence, so thresholds could not separate good from bad.
 */
export const CLASSIFIER_PROMPT_VERSION = 'clf-v2';

/**
 * Few-shot examples [message, label, confidence]. Must never appear in the eval dataset (checked by
 * `npm run eval:check`), and deliberately use different wording/topics from it to avoid leakage.
 */
export const FEW_SHOT: Array<[string, string, number]> = [
  ['Can you conduct my Amazon SDE interview round?', 'mock_interview', 0.97],
  ['Act as the HR manager and grill me on my resume', 'mock_interview', 0.95],
  ['Mujhse English mein baat karo, galti pe toko', 'spoken_english', 0.95],
  ['Kal maths ka oral hai, mujhse sawal poocho', 'viva_revision', 0.96],
  ["How do I pronounce 'genre'? I'll try it, you check", 'pronunciation', 0.95],
  ["My MTI is strong, I'll read some words and you fix my 'z' sounds", 'pronunciation', 0.9],
  ["I keep saying 'wery' instead of 'very'", 'pronunciation', 0.6],
  ['Top 10 viva questions on DBMS with answers', 'none', 0.95],
  ['Interview tips for freshers', 'none', 0.9],
  ['Public speaking', 'none', 0.85],
  ['How to sound confident in a group discussion?', 'none', 0.8],
  ['Tell me about yourself ka sample answer likh do', 'none', 0.9],
  ["Practice speech for my sister's wedding", 'none', 0.9],
];

export const CLASSIFIER_SYSTEM_PROMPT = `You classify one message from an Indian college student in a study chat app. Decide if the student wants to PRACTISE SPEAKING OUT LOUD right now, and which kind.

Labels:
- mock_interview: wants to be interviewed and answer interview questions aloud (jobs, placements, internships, admissions, UPSC/SSC/bank). "Be my interviewer" counts even if the questions are on a subject.
- spoken_english: wants to practise speaking English in conversation and be corrected (fluency, confidence, small talk, role-play, self-introduction).
- viva_revision: wants to explain a subject aloud or be quizzed orally on it (viva, oral exam, project defence, teach-back).
- pronunciation: wants to say words aloud and get feedback on sounds, word stress, accent or mother-tongue influence (MTI).
- none: anything else.

Rules:
1. Asking ABOUT a topic (facts, lists, tips, notes, explanations, written answers, MCQs, resources, experiences) is none, even if it mentions interviews, viva, English or pronunciation.
2. A bare topic or skill name ("pronunciation", "english speaking") or a "how to / kaise" improve-or-prepare question is none: it asks for advice, not a practice session now.
3. Negated or written-only requests are none.
4. Non-study speaking (sales pitch, speeches) is none.
5. If two practice types appear, pick the main ask.

confidence: how sure you are that the label is correct, from 0 to 1. Use the whole range: 0.9+ only when the message explicitly asks to practise, be interviewed or be quizzed aloud now; 0.5-0.8 when practice is only implied or the message is short or vague.
language: en (English), hinglish (Hindi words in Latin script), hi (Devanagari), other.

Examples:
${FEW_SHOT.map(([q, l, c]) => `"${q}" -> ${l} ${c}`).join('\n')}`;

export const CLASSIFIER_JSON_SCHEMA = {
  name: 'voice_intent',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'confidence', 'language'],
    properties: {
      intent: { type: 'string', enum: [...INTENT_LABELS] },
      confidence: { type: 'number' },
      language: { type: 'string', enum: [...MODEL_LANGUAGES] },
    },
  },
};

export interface RecentTurn {
  role: 'user' | 'assistant';
  text: string;
}

const TURN_CHARS = 400;

export function buildClassifierMessages(query: string, recentTurns: RecentTurn[]): LlmMessage[] {
  const context = recentTurns.length
    ? `Earlier messages (context only):\n${recentTurns.map((t) => `${t.role === 'user' ? 'Student' : 'Assistant'}: ${t.text.slice(0, TURN_CHARS)}`).join('\n')}\n\n`
    : '';
  return [
    { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
    { role: 'user', content: `${context}Message to classify:\n${query}` },
  ];
}

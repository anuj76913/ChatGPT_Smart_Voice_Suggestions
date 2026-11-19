import type { VoiceIntent } from './intents';

/**
 * Phase 11 (PRD launch phase 4) v2 bets: Voice Preview Mode content (quiet mode needs no content).
 * Voice Learning Challenges were out of scope for the prototype and are not built (decisions.md ADR-018).
 */

// ── Voice Preview Mode ──────────────────────────────────────────────────────

/** One line of a scripted preview: the coach speaks, a sample learner answers, the coach gives feedback. */
export interface PreviewLine {
  role: 'coach' | 'learner';
  text: string;
}

/**
 * ~30 seconds per intent when read aloud at normal speed (about 75 words). The learner lines are a sample answer
 * spoken in a second voice, so the learner hears what a practice turn sounds like before using the mic.
 */
export const VOICE_PREVIEWS: Record<VoiceIntent, PreviewLine[]> = {
  mock_interview: [
    { role: 'coach', text: "Hi! I'll be your interviewer. Let's start: tell me about yourself." },
    { role: 'learner', text: "I'm a final year computer science student. I built a chatbot for our college library." },
    { role: 'coach', text: 'Good start. Add one number that shows impact, like how many students used it. Next question: what was the hardest part of that project?' },
  ],
  spoken_english: [
    { role: 'coach', text: "Hello! Let's chat in English. What did you do last weekend?" },
    { role: 'learner', text: 'I go to my cousin wedding in Indore and we danced a lot.' },
    { role: 'coach', text: 'Sounds fun! You could say: "I went to my cousin\'s wedding." Past tense: went. What was your favourite part?' },
  ],
  viva_revision: [
    { role: 'coach', text: "I'm your viva examiner for operating systems. First question: what is a deadlock?" },
    { role: 'learner', text: 'A deadlock is when two processes wait for each other forever.' },
    { role: 'coach', text: 'Correct idea. Also name the four conditions, like mutual exclusion and circular wait. Next: how can we prevent a deadlock?' },
  ],
  pronunciation: [
    { role: 'coach', text: 'Let\'s practise a few tricky words together. I\'ll say a word, and you repeat it. First word: "development".' },
    { role: 'learner', text: 'Development. Is that right? I think I said it too fast.' },
    { role: 'coach', text: 'Nice try! Slow down and stress the second part: de-VEL-op-ment. Now try "vegetable", and keep the V sound clear, with your top teeth on your lip.' },
  ],
};

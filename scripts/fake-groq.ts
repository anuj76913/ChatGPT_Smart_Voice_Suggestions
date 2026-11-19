/**
 * Standalone fake Groq server: the whole app works offline, with no key and no token spend.
 *   npm run dev:fake-groq                     (port 8790)
 *   then in .env:  GROQ_BASE_URL=http://127.0.0.1:8790   (any non-empty GROQ_API_KEY)
 *
 * Handles every use case:
 *   chat (streamed Markdown answer echoing the question) · classifier (strict JSON: interview / viva / spoken
 *   English / pronunciation keywords → that intent at 0.97, else none) · opening line · coach (streamed) ·
 *   session summary (tip + next activity) · Whisper transcription (fixed English answer).
 * Ask a chat question containing "fail" to get a 500, or "slow" for a 3 s delay before the first token.
 *
 * Drills for the runbooks (docs/runbooks/): start with FAKE_GROQ_MODE=
 *   429      every call is rate limited (retry-after 30 s)   · 5xx  every call fails with 503
 *   slow     every call waits 6 s                            · stt-down  only transcription fails
 *   classifier-down  only the classifier fails (chat keeps working, no cards)
 */
import { completion, errorResponse, startFakeGroq, streamOf, type FakeResponse } from '../apps/server/test/fake-groq';

const port = Number(process.argv[2] ?? 8790);
const mode = process.env.FAKE_GROQ_MODE ?? '';

const INTENTS: Array<[RegExp, string]> = [
  [/interview|hr round|placement|tell me about yourself|intrvw|इंटरव्यू|मुलाखत|ইন্টারভিউ|ఇంటర్వ్యూ/i, 'mock_interview'],
  [/\bviva\b|oral|quiz me|test me|sawal|pooch/i, 'viva_revision'],
  [/pronunc|pronoun|accent|how to say|kaise bol/i, 'pronunciation'],
  [/spoken english|speak english|english (bol|speak|conversation)|fluency|small talk|role ?play/i, 'spoken_english'],
];

const fake = await startFakeGroq();
fake.setHandler((req): FakeResponse => {
  const isStt = req.path.includes('/audio/transcriptions');
  if (mode === '429') return errorResponse(429, 30);
  if (mode === '5xx') return errorResponse(503);
  if (mode === 'stt-down' && isStt) return errorResponse(500);
  if (isStt)
    return { kind: 'json', body: { text: 'I am a final year student and I built a chatbot for our college library.', language: 'english', duration: 6, segments: [{ avg_logprob: -0.2, no_speech_prob: 0.01, end: 6 }] } };

  const msgs = (req.body.messages as Array<{ role: string; content: string }>) ?? [];
  const last = msgs.at(-1)?.content ?? '';
  const system = msgs.find((m) => m.role === 'system')?.content ?? '';
  const rf = req.body.response_format as { json_schema?: { name?: string } } | undefined;
  const slow = mode === 'slow' ? 6000 : 0;

  if (rf?.json_schema?.name === 'session_summary')
    return { ...completion(JSON.stringify({ tip: 'Add one number that shows the impact of your project.', next_activity_index: 1 })), delayMs: 300 + slow } as FakeResponse;
  if (rf) {
    if (mode === 'classifier-down') return errorResponse(503);
    const hit = INTENTS.find(([re]) => re.test(last));
    const language = /[ऀ-ॿ]/.test(last) ? 'hi' : /\b(mera|mujhe|kya|hai|karo|ke liye)\b/i.test(last) ? 'hinglish' : 'en';
    return { ...completion(JSON.stringify({ intent: hit?.[1] ?? 'none', confidence: hit ? 0.97 : 0.95, language })), delayMs: 200 + slow } as FakeResponse;
  }
  if (!req.body.stream) return { ...completion("Let's practise. Tell me about yourself and the project you are proudest of?"), delayMs: 200 + slow } as FakeResponse;
  // Streaming: the coach (spoken replies) or chat.
  if (/coach|interviewer|spoken|voice/i.test(system) && !/markdown/i.test(system))
    return streamOf(['Good start, and the library chatbot is a strong example. ', 'What was the hardest problem you solved in it?'], { delayFirstMs: 300 + slow, delayBetweenMs: 60 });
  if (/\bfail\b/i.test(last)) return errorResponse(500);
  const answer = [
    `**(fake Groq)** You asked: _${last.slice(0, 80)}_\n\n`,
    'Here is a structured answer:\n\n',
    '1. First, break the topic into parts.\n',
    '2. Then, practise each part out loud.\n',
    '3. Finally, review what you missed.\n\n',
    'Good luck!',
  ];
  return streamOf(answer, { delayFirstMs: (/\bslow\b/i.test(last) ? 3000 : 250) + slow, delayBetweenMs: 80 });
});

// startFakeGroq listens on a random port; proxy a fixed port to it for convenience.
const { createServer, request } = await import('node:http');
createServer((req, res) => {
  const target = new URL(fake.url);
  const p = request({ host: target.hostname, port: target.port, path: req.url?.replace(/^\/openai\/v1/, ''), method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  p.on('error', () => res.destroy());
  req.pipe(p);
}).listen(port, '127.0.0.1', () => console.log(`fake Groq listening on http://127.0.0.1:${port}${mode ? ` (mode: ${mode})` : ''}  (set GROQ_BASE_URL to this)`));

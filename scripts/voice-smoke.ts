/**
 * Live end-to-end voice session against a running server (real Groq): measures the P4 latencies.
 *   npm run smoke:voice -- <turn1.wav> [turn2.wav …] [--base http://127.0.0.1:8787] [--intent mock_interview]
 *
 * Flow: dev-login → chat message (context) → POST /v1/voice/sessions → WebSocket → one audio clip per turn → end
 *   → GET summary (Phase 5: tip from the summary model, next activity, streak) → POST recap.
 * Reports session-create time (opening line), and per turn: clip sent → transcript (Whisper) → first reply
 * sentence (coach first token) → reply done. Browser TTS isn't involved, so "first audio" ≈ first sentence + TTS start.
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import type { CreateVoiceSessionResponse, SessionSummary, VoiceServerMessage } from '@svs/shared';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const base = opt('base', 'http://127.0.0.1:8787');
const intent = opt('intent', 'mock_interview');
const clips = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!clips.length) {
  console.error('Usage: npm run smoke:voice -- <turn1.wav> [turn2.wav …]');
  process.exit(1);
}

async function main() {
  const login = await fetch(`${base}/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'voice_smoke' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const conv = (await (await fetch(`${base}/v1/conversations`, { method: 'POST', headers: { Cookie: cookie } })).json()) as { id: string };
  const chat = await fetch(`${base}/v1/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'I have a TCS Ninja interview next week, help me prepare', client_msg_id: crypto.randomUUID() }),
  });
  await chat.text();

  const t0 = performance.now();
  const res = await fetch(`${base}/v1/voice/sessions`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent, entry_point: 'suggestion_card', conversation_id: conv.id }),
  });
  if (!res.ok) throw new Error(`create failed: HTTP ${res.status} ${await res.text()}`);
  const s = (await res.json()) as CreateVoiceSessionResponse;
  const createMs = performance.now() - t0;
  console.log(`session ${s.session_id} · ${s.label}`);
  console.log(`  create: ${Math.round(createMs)} ms · opening (${s.opening.source}): "${s.opening.text}"`);

  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${s.stream.path}?token=${encodeURIComponent(s.stream.token)}`, { headers: { Cookie: cookie } });
  const queue: VoiceServerMessage[] = [];
  let wake: (() => void) | null = null;
  ws.on('message', (d) => {
    queue.push(JSON.parse(String(d)) as VoiceServerMessage);
    wake?.();
  });
  const next = async <T extends VoiceServerMessage['type']>(types: T[], ms = 30000): Promise<Extract<VoiceServerMessage, { type: T }>> => {
    const end = Date.now() + ms;
    for (;;) {
      const i = queue.findIndex((m) => (types as string[]).includes(m.type));
      if (i >= 0) return queue.splice(i, 1)[0] as Extract<VoiceServerMessage, { type: T }>;
      if (Date.now() > end) throw new Error(`timeout waiting for ${types.join('|')}`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 200);
      });
    }
  };
  await next(['ready']);
  ws.send(JSON.stringify({ type: 'metrics', start_latency_ms: Math.round(createMs) }));

  const rows: string[] = [];
  for (const [i, clip] of clips.entries()) {
    const audio = readFileSync(clip);
    const sent = performance.now();
    ws.send(JSON.stringify({ type: 'turn', mime: 'audio/wav' }));
    ws.send(audio);
    const t = await next(['transcript.final', 'transcript.empty', 'error']);
    const tTranscript = performance.now() - sent;
    if (t.type !== 'transcript.final') {
      console.log(`  turn ${i + 1}: ${t.type}${t.type === 'error' ? ` ${t.code}` : ''}`);
      continue;
    }
    const first = await next(['reply.sentence']);
    const tFirst = performance.now() - sent;
    const done = await next(['reply.done']);
    const tDone = performance.now() - sent;
    // Drop this turn's remaining sentences so the next turn measures its own first sentence.
    for (let k = queue.length - 1; k >= 0; k--) if (queue[k]!.type === 'reply.sentence') queue.splice(k, 1);
    console.log(`  turn ${i + 1}: STT ${Math.round(tTranscript)} ms · first reply sentence ${Math.round(tFirst)} ms · reply done ${Math.round(tDone)} ms`);
    console.log(`    you   (${t.language}${t.low_quality ? ', low quality' : ''}): "${t.text}"`);
    console.log(`    coach: "${done.text}"`);
    void first;
    rows.push(`${Math.round(tTranscript)},${Math.round(tFirst)},${Math.round(tDone)}`);
  }
  ws.send(JSON.stringify({ type: 'end' }));
  const ended = await next(['session.ended']);
  console.log(`  ended: ${JSON.stringify(ended.stats)}`);
  ws.close();

  const tSummary = performance.now();
  const sumRes = await fetch(`${base}/v1/voice/sessions/${s.session_id}/summary`, { headers: { Cookie: cookie } });
  if (!sumRes.ok) throw new Error(`summary failed: ${sumRes.status}`);
  const sum = (await sumRes.json()) as SessionSummary;
  console.log(`  summary (${Math.round(performance.now() - tSummary)} ms after end; built in the background):`);
  console.log(`    tip (${sum.language}): ${sum.tip ?? '(none)'}${sum.encouragement ? ` · encouragement: ${sum.encouragement}` : ''}`);
  console.log(`    next activity: ${sum.next_activity.label} · streak ${sum.streak.current}/${sum.streak.goal}${sum.streak.credited ? ' (credited)' : ''}`);
  const recap = await fetch(`${base}/v1/voice/sessions/${s.session_id}/recap`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  console.log(`  recap: ${recap.status} ${JSON.stringify(await recap.json())}`);
}

main().catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

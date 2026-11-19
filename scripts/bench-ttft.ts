/**
 * P1.10 baseline text time-to-first-token (TTFT) with Smart Voice Suggestions OFF.
 * This is the reference for the PRD rule "text replies get no slower" (FR-1, Phase 3 perf test).
 *
 *   npm run bench:ttft -- [--base http://127.0.0.1:8787] [--n 10] [--out docs/phase1/ttft-baseline.md]
 *
 * Needs the server running with a real GROQ_API_KEY. Each prompt goes to a fresh conversation,
 * so history length doesn't skew the numbers.
 */
import { writeFileSync } from 'node:fs';
import { readSseData, type ChatStreamEvent } from '@svs/shared';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const base = arg('base', 'http://127.0.0.1:8787');
const n = Number(arg('n', '10'));
const out = arg('out', 'docs/phase1/ttft-baseline.md');
const paceMs = Number(arg('pace-ms', '0'));
const svsLabel = arg('svs', 'off (Phase 1 has no suggestion path)');

const PROMPTS = [
  'Explain normalization in DBMS with an example',
  'Mera kal TCS ka interview hai, kya kya padhna chahiye?',
  'What is the difference between TCP and UDP?',
  'Give me 5 tips to improve my spoken English',
  'Newton ke teen laws simple language mein samjhao',
  'How do I prepare for a project viva in 3 days?',
  'Write a short self-introduction for a fresher interview',
  'What is a deadlock in operating systems?',
  'Python mein list aur tuple ka difference kya hai?',
  'Summarize the causes of the French Revolution in 5 points',
];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : NaN;
};

async function main() {
  const login = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: 'bench_ttft' }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };

  const rows: Array<{ prompt: string; clientTtft: number | null; serverTtft: number | null; total: number; ok: boolean; chars: number; card: string }> = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && paceMs) await new Promise((r) => setTimeout(r, paceMs));
    const prompt = PROMPTS[i % PROMPTS.length]!;
    const convRes = await fetch(`${base}/v1/conversations`, { method: 'POST', headers: { Cookie: cookie } });
    if (!convRes.ok) throw new Error(`create conversation failed: HTTP ${convRes.status} ${await convRes.text()}`);
    const conv = (await convRes.json()) as { id: string };
    const t0 = performance.now();
    const res = await fetch(`${base}/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: prompt, client_msg_id: crypto.randomUUID() }),
    });
    if (res.status === 429) {
      console.log('rate limited; waiting 60s…');
      await new Promise((r) => setTimeout(r, 60000));
      i--;
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`send failed: HTTP ${res.status} ${await res.text()}`);
    let clientTtft: number | null = null;
    let serverTtft: number | null = null;
    let ok = false;
    let chars = 0;
    let card = '—';
    for await (const data of readSseData(res.body!)) {
      const e = JSON.parse(data) as ChatStreamEvent;
      if (e.type === 'answer.delta') {
        clientTtft ??= performance.now() - t0;
        chars += e.text.length;
      }
      if (e.type === 'suggestion') card = e.intent;
      if (e.type === 'answer.complete') {
        ok = true;
        serverTtft = e.ttft_ms;
      }
    }
    const total = performance.now() - t0;
    rows.push({ prompt, clientTtft, serverTtft, total, ok, chars, card });
    console.log(`${String(i + 1).padStart(2)}. ${ok ? '✔' : '✖'} ttft ${clientTtft?.toFixed(0) ?? '—'} ms · total ${total.toFixed(0)} ms · ${prompt}`);
  }

  const okRows = rows.filter((r) => r.ok && r.clientTtft !== null);
  const c = okRows.map((r) => r.clientTtft!);
  const s = okRows.map((r) => r.serverTtft ?? NaN).filter((x) => !Number.isNaN(x));
  const t = okRows.map((r) => r.total);
  const fmt = (x: number) => (Number.isNaN(x) ? '—' : `${Math.round(x)} ms`);
  const summary = [
    `| Metric | p50 | p90 | max |`,
    `|---|---|---|---|`,
    `| Client TTFT (request → first token at client) | ${fmt(pct(c, 50))} | ${fmt(pct(c, 90))} | ${fmt(Math.max(...c))} |`,
    `| Server TTFT (S2 → first Groq token) | ${fmt(pct(s, 50))} | ${fmt(pct(s, 90))} | ${fmt(Math.max(...s))} |`,
    `| Total answer time | ${fmt(pct(t, 50))} | ${fmt(pct(t, 90))} | ${fmt(Math.max(...t))} |`,
  ].join('\n');

  const report = `# Text Time-to-First-Token Benchmark

> Reference for the PRD rule "text replies get no slower" (FR-1). Phase 3 must show TTFT with the suggestion path on is not significantly worse than this.

- **Measured:** ${new Date().toISOString()}
- **Server:** ${base}
- **Suggestions:** ${svsLabel}
- **Chat model:** primary \`openai/gpt-oss-120b\` (reasoning effort low), fallback \`openai/gpt-oss-20b\`
- **Runs:** ${rows.length} (${okRows.length} succeeded), each in a fresh conversation, sequential

## Summary
${summary}

## Runs
| # | Prompt | Client TTFT | Server TTFT | Total | Chars | Card | OK |
|---|---|---|---|---|---|---|---|
${rows.map((r, i) => `| ${i + 1} | ${r.prompt} | ${fmt(r.clientTtft ?? NaN)} | ${fmt(r.serverTtft ?? NaN)} | ${fmt(r.total)} | ${r.chars} | ${r.card} | ${r.ok ? '✔' : '✖'} |`).join('\n')}
`;
  writeFileSync(out, report);
  console.log(`\n${summary}\n\nReport written to ${out}`);
}

main().catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

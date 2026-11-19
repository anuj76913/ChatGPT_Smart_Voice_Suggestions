import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Fake Groq server for tests (P1.2). Simulates success, 429 + retry-after, 5xx, hangs (timeouts),
 * invalid JSON, slow first tokens and streams that break mid-way, without calling the real API.
 */
export type FakeResponse =
  | { kind: 'json'; status?: number; body: unknown; headers?: Record<string, string>; delayMs?: number }
  | {
      kind: 'stream';
      chunks: string[];
      reasoning?: string;
      delayFirstMs?: number;
      delayBetweenMs?: number;
      usage?: Record<string, number>;
      /** Destroy the connection after this many content chunks. */
      breakAfter?: number;
    }
  | { kind: 'hang' }
  | { kind: 'text'; status: number; text: string; headers?: Record<string, string> };

export interface RecordedRequest {
  /** Request path, e.g. /chat/completions or /audio/transcriptions. */
  path: string;
  model: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

export const completion = (content: string, usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }): FakeResponse => ({
  kind: 'json',
  body: { id: 'cmpl-1', choices: [{ index: 0, message: { role: 'assistant', content, reasoning: 'SECRET-REASONING' } }], usage },
});

export const errorResponse = (status: number, retryAfterS?: number): FakeResponse => ({
  kind: 'json',
  status,
  body: { error: { message: `fake error ${status}`, type: 'fake' } },
  headers: retryAfterS !== undefined ? { 'retry-after': String(retryAfterS) } : undefined,
});

export const streamOf = (chunks: string[], extra: Partial<Extract<FakeResponse, { kind: 'stream' }>> = {}): FakeResponse => ({
  kind: 'stream',
  chunks,
  ...extra,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeGroq() {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let handler: (req: RecordedRequest, index: number) => FakeResponse = () => completion('ok');

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const ct = req.headers['content-type'] ?? '';
    // Whisper uploads are multipart: record the model field and the file size, never parse the audio.
    const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]+)`).exec(raw.toString('latin1'))?.[1];
    const body = (
      ct.includes('multipart/form-data')
        ? { _multipart: true, model: field('model'), response_format: field('response_format'), _bytes: raw.length }
        : raw.length
          ? JSON.parse(raw.toString('utf8'))
          : {}
    ) as Record<string, unknown>;
    const recorded: RecordedRequest = { path: req.url ?? '', model: String(body.model), body, authorization: req.headers.authorization };
    requests.push(recorded);
    const r = handler(recorded, requests.length - 1);

    if (r.kind === 'hang') return; // never respond
    if (r.kind === 'text') {
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      return res.end(r.text);
    }
    if (r.kind === 'json') {
      if (r.delayMs) await wait(r.delayMs);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      return res.end(JSON.stringify(r.body));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (r.reasoning) send({ choices: [{ index: 0, delta: { reasoning: r.reasoning } }] });
    if (r.delayFirstMs) await wait(r.delayFirstMs);
    for (const [i, text] of r.chunks.entries()) {
      if (r.breakAfter !== undefined && i >= r.breakAfter) {
        await wait(50); // let the chunks already written reach the client first
        res.socket?.destroy();
        return;
      }
      if (i > 0 && r.delayBetweenMs) await wait(r.delayBetweenMs);
      if (res.destroyed) return;
      send({ choices: [{ index: 0, delta: { content: text } }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { usage: r.usage ?? { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } });
    res.end('data: [DONE]\n\n');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler(fn: (req: RecordedRequest, index: number) => FakeResponse) {
      handler = fn;
    },
    reset() {
      requests.length = 0;
      handler = () => completion('ok');
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type FakeGroq = Awaited<ReturnType<typeof startFakeGroq>>;

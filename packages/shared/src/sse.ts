/**
 * Minimal Server-Sent Events reader for fetch() response bodies (works in Node ≥18 and browsers).
 * Yields the `data:` payload of each event (multi-line data joined with "\n"). Comments and other fields are ignored.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = parseBlock(block);
        if (data !== null) yield data;
      }
    }
    buffer += decoder.decode();
    const tail = parseBlock(buffer.trim());
    if (tail !== null) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseBlock(block: string): string | null {
  const lines = block
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''));
  return lines.length ? lines.join('\n') : null;
}

/** Formats one SSE event carrying a JSON payload. */
export const sseEvent = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

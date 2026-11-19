export type LlmErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'bad_request'
  | 'auth'
  | 'not_found'
  | 'invalid_output'
  | 'busy'
  | 'aborted';

/** Error from the Groq gateway. Never contains the API key or request content. */
export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly details: { status?: number; retryAfterMs?: number; model?: string; partial?: boolean } = {},
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Kinds worth retrying on the *same* model (if the time budget allows). */
export const RETRY_SAME_MODEL = new Set<LlmErrorKind>(['rate_limited', 'server', 'network']);

/** Kinds that must not fall back to another model. */
export const NO_FALLBACK = new Set<LlmErrorKind>(['auth', 'aborted']);

/** Maps an HTTP error response from Groq to an LlmError (reads at most a short error message). */
export async function httpError(res: Response, model: string): Promise<LlmError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) message += `: ${body.error.message.slice(0, 200)}`;
  } catch {
    /* ignore non-JSON bodies */
  }
  const retryAfter = res.headers.get('retry-after');
  const retryAfterMs = retryAfter && !Number.isNaN(Number(retryAfter)) ? Math.ceil(Number(retryAfter) * 1000) : undefined;
  const s = res.status;
  const kind: LlmErrorKind =
    s === 429 ? 'rate_limited' : s === 401 || s === 403 ? 'auth' : s === 404 ? 'not_found' : s >= 500 ? 'server' : 'bad_request';
  return new LlmError(kind, message, { status: s, retryAfterMs, model });
}

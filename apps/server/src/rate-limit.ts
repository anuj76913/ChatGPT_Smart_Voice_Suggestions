/**
 * Fixed-window in-memory rate limiter keyed by user id or IP (P1.4 per-user rate limiting).
 * Single-instance MVP; move to a shared store (e.g. Postgres/Redis) when the server runs on more than one node.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.sweep(t);
      return { ok: true };
    }
    if (w.count >= this.limit) {
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) };
    }
    w.count += 1;
    return { ok: true };
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

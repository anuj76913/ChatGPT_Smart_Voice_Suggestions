import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived stream token scoped to one voice session and one user (architecture §13.3, edge-case SEC-05).
 * The WebSocket also requires the session cookie; the token stops a cookie alone from opening someone's stream
 * and expires quickly so a leaked URL is useless.
 */
const TTL_MS = 5 * 60 * 1000;

export function signStreamToken(secret: string, sessionId: string, userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ s: sessionId, u: userId, e: now + TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyStreamToken(secret: string, token: string | undefined, sessionId: string, userId: string, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { s: string; u: string; e: number };
    return p.s === sessionId && p.u === userId && p.e > now;
  } catch {
    return false;
  }
}

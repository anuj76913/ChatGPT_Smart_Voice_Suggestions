import { MAX_EVENTS_PER_BATCH, type ClassifierLanguage, type ClientEventInput, type EventName, type EventPropValue, type IntentLabel } from '@svs/shared';
import { api, ApiError } from './api';
import { APP_VERSION, currentPlatform, TAB_SESSION_ID } from './session';

/**
 * C7 Event Logger: batches client events and sends them to POST /v1/events.
 * - flushes every 5s, at 20 queued events, and when the page is hidden (keepalive request)
 * - retries network / 5xx failures with backoff; drops events the server rejects (4xx)
 * - never sends content: only ids, enums, numbers and booleans (the server enforces this too)
 */
const FLUSH_MS = 5000;
const FLUSH_AT = 20;
const MAX_QUEUE = 500;

class EventLogger {
  private queue: ClientEventInput[] = [];
  private inflight = false;
  private backoffMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') void this.flush(true);
    };
    document.addEventListener('visibilitychange', flushOnHide);
    window.addEventListener('pagehide', () => void this.flush(true));
  }

  log(
    event: EventName,
    fields: { props?: Record<string, EventPropValue>; intent_type?: IntentLabel | null; language?: ClassifierLanguage | null } = {},
  ) {
    this.queue.push({
      event,
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      session_id: TAB_SESSION_ID,
      app_version: APP_VERSION,
      platform: currentPlatform(),
      intent_type: fields.intent_type ?? null,
      language: fields.language ?? null,
      props: fields.props ?? {},
    });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.queue.length >= FLUSH_AT) void this.flush();
  }

  async flush(keepalive = false) {
    if (this.inflight || this.queue.length === 0) return;
    if (this.backoffMs > 0 && !keepalive) {
      this.backoffMs = Math.max(0, this.backoffMs - FLUSH_MS);
      return;
    }
    this.inflight = true;
    const batch = this.queue.splice(0, MAX_EVENTS_PER_BATCH);
    try {
      await api.postEvents(batch, keepalive);
      this.backoffMs = 0;
    } catch (err) {
      const retryable = !(err instanceof ApiError) || err.status >= 500 || err.status === 429;
      if (retryable) {
        this.queue.unshift(...batch); // keep order; event_id makes the retry idempotent server-side
        this.backoffMs = Math.min(60000, (this.backoffMs || FLUSH_MS) * 2);
      }
    } finally {
      this.inflight = false;
    }
  }
}

export const events = new EventLogger();

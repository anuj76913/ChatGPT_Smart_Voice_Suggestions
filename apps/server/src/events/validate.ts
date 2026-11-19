import { z } from 'zod';
import {
  checkEventProps,
  CLASSIFIER_LANGUAGES,
  EVENT_NAMES,
  FORBIDDEN_EVENT_PROP_KEYS,
  INTENT_LABELS,
  MAX_EVENT_PROP_STRING,
  MAX_EVENT_PROPS,
  SERVER_EMITTED_EVENTS,
  type ClientEventInput,
} from '@svs/shared';

const forbidden = new Set<string>(FORBIDDEN_EVENT_PROP_KEYS);

const PropValue = z.union([
  z
    .string()
    .max(MAX_EVENT_PROP_STRING, `string props are limited to ${MAX_EVENT_PROP_STRING} chars (no free text)`)
    .refine((s) => !/[\r\n]/.test(s), 'string props must be single-line identifiers'),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** One client event (architecture §12.1–12.2). Server-only fields are not accepted from the client. */
export const ClientEventSchema = z
  .object({
    event: z.enum(EVENT_NAMES).refine((e) => !SERVER_EMITTED_EVENTS.includes(e), 'this event can only be emitted by the server'),
    event_id: z.uuid(),
    ts: z.iso.datetime({ offset: true }),
    session_id: z.string().min(1).max(64),
    intent_type: z.enum(INTENT_LABELS).nullable().optional(),
    language: z.enum(CLASSIFIER_LANGUAGES).nullable().optional(),
    app_version: z.string().min(1).max(32),
    platform: z.enum(['web-mobile', 'web-desktop']),
    props: z
      .record(z.string().min(1).max(40), PropValue)
      .optional()
      .refine((p) => !p || Object.keys(p).length <= MAX_EVENT_PROPS, `at most ${MAX_EVENT_PROPS} props`)
      .refine((p) => !p || Object.keys(p).every((k) => !forbidden.has(k.toLowerCase())), 'props must not carry content (text, query, transcript, …)'),
  })
  .strict();

export type ValidationResult = { ok: true; event: ClientEventInput } | { ok: false; reason: string };

export function validateClientEvent(input: unknown): ValidationResult {
  const r = ClientEventSchema.safeParse(input);
  if (r.success) {
    // P6.1: props must match the event catalogue (only known keys, typed ids / enums / numbers / booleans).
    const bad = checkEventProps(r.data.event, r.data.props ?? {});
    if (bad) return { ok: false, reason: bad };
    return { ok: true, event: r.data as ClientEventInput };
  }
  return { ok: false, reason: r.error.issues.map((i) => `${i.path.join('.') || 'event'}: ${i.message}`).join('; ') };
}

import { CLASSIFIER_LANGUAGES, ENTRY_POINTS, PRESET_BY_INTENT, VOICE_INTENTS } from './intents';
import type { EventName } from './events';

/**
 * P6.1 Event catalogue as data (architecture §12.2): who emits each event, which props it may carry (ids, enums,
 * numbers, booleans only), and whether intent / language must be known.
 *
 * The server validates every client event against this spec (unknown or mistyped props are rejected), then fills
 * `intent_type` and `language` from the record the event refers to (suggestion, voice session or message), so they
 * can't be spoofed (edge-case EX-05). `arm` and `experiment_id` always come from the server's assignment.
 */
export type PropSpec =
  | { type: 'id'; required?: boolean }
  | { type: 'enum'; values: readonly string[]; required?: boolean }
  | { type: 'int'; min?: number; max?: number; required?: boolean }
  | { type: 'number'; required?: boolean }
  | { type: 'bool'; required?: boolean };

export interface EventSpec {
  source: 'client' | 'server';
  /** `required`: stored events must have it (the server derives it from the referenced record). */
  intent: 'required' | 'optional';
  language: 'required' | 'optional';
  props: Record<string, PropSpec>;
  /** Part of the PRD's required instrumentation set (context.md §4.15). */
  prd?: true;
}

const id = (required = false): PropSpec => ({ type: 'id', required });
const bool = (required = false): PropSpec => ({ type: 'bool', required });
const int = (required = false, min = 0, max = 10_000_000): PropSpec => ({ type: 'int', required, min, max });
const oneOf = (values: readonly string[], required = false): PropSpec => ({ type: 'enum', values, required });

export const SUMMARY_ACTIONS = ['practice_again', 'next_activity', 'back_to_chat'] as const;
export const MIC_PROBLEMS = ['denied', 'blocked', 'busy', 'no_mic', 'unsupported'] as const;
export const OPT_SOURCES = ['card', 'settings'] as const;
export const VOICE_SETTINGS = ['speed', 'accent', 'quiet'] as const;
export const SETTING_VALUES = ['slow', 'normal', 'fast', 'en-IN', 'hi-IN', 'on', 'off'] as const;
/** Mirrors VoiceEndReason (voice.ts). */
export const END_REASONS = ['user', 'cap', 'network', 'superseded', 'error', 'continue_in_text', 'idle'] as const;
const PRESET_IDS = VOICE_INTENTS.map((i) => PRESET_BY_INTENT[i].presetId);

export const EVENT_CATALOGUE: Record<EventName, EventSpec> = {
  suggestion_eligible: {
    source: 'server',
    intent: 'required',
    language: 'required',
    prd: true,
    props: { suggestion_id: id(true), confidence: { type: 'number', required: true }, classifier_version: id(true), dogfood: bool() },
  },
  suggestion_shown: { source: 'client', intent: 'required', language: 'required', prd: true, props: { suggestion_id: id(true) } },
  suggestion_tapped: { source: 'client', intent: 'required', language: 'required', prd: true, props: { suggestion_id: id(true) } },
  suggestion_dismissed: {
    source: 'client',
    intent: 'required',
    language: 'required',
    prd: true,
    props: { suggestion_id: id(true), consecutive_count: { type: 'int', min: 0, max: 100 }, paused: bool() },
  },
  suggestions_opted_out: { source: 'client', intent: 'optional', language: 'optional', props: { source: oneOf(OPT_SOURCES, true), suggestion_id: id() } },
  suggestions_opted_in: { source: 'client', intent: 'optional', language: 'optional', props: { source: oneOf(OPT_SOURCES, true) } },
  privacy_notice_shown: { source: 'client', intent: 'required', language: 'optional', props: { suggestion_id: id(), entry_point: oneOf(ENTRY_POINTS) } },
  privacy_notice_ack: { source: 'client', intent: 'required', language: 'optional', props: { suggestion_id: id(), entry_point: oneOf(ENTRY_POINTS) } },
  mic_permission_denied: {
    source: 'client',
    intent: 'required',
    language: 'optional',
    props: { permanent: bool(true), reason: oneOf(MIC_PROBLEMS), suggestion_id: id(), entry_point: oneOf(ENTRY_POINTS) },
  },
  mic_permission_granted: { source: 'client', intent: 'required', language: 'optional', props: { suggestion_id: id(), entry_point: oneOf(ENTRY_POINTS) } },
  voice_session_started: {
    source: 'server',
    intent: 'required',
    language: 'required',
    prd: true,
    props: {
      voice_session_id: id(true),
      preset_id: oneOf(PRESET_IDS, true),
      entry_point: oneOf(ENTRY_POINTS, true),
      opening_source: oneOf(['llm', 'template'], true),
      opening_ms: int(),
      suggestion_id: id(),
    },
  },
  voice_session_completed: {
    source: 'server',
    intent: 'required',
    language: 'required',
    prd: true,
    props: {
      voice_session_id: id(true),
      preset_id: oneOf(PRESET_IDS, true),
      duration_s: int(true),
      questions: int(true),
      user_turns: int(true),
      end_reason: oneOf(END_REASONS, true),
      dominant_language: oneOf(CLASSIFIER_LANGUAGES),
      qualifies_for_wavl: bool(true),
      start_latency_ms: int(),
      coach_prompt: id(),
    },
  },
  voice_setting_changed: {
    source: 'client',
    intent: 'optional',
    language: 'optional',
    props: { setting: oneOf(VOICE_SETTINGS, true), value: oneOf(SETTING_VALUES), voice_session_id: id() },
  },
  noisy_room_hint_shown: { source: 'client', intent: 'required', language: 'required', props: { voice_session_id: id(true) } },
  voice_session_network_drop: {
    source: 'client',
    intent: 'required',
    language: 'required',
    props: { voice_session_id: id(true), resumed: bool(true), continued_in_text: bool(true) },
  },
  summary_action: {
    source: 'client',
    intent: 'required',
    language: 'required',
    props: { voice_session_id: id(true), action: oneOf(SUMMARY_ACTIONS, true) },
  },
  voice_preview_started: { source: 'client', intent: 'required', language: 'required', props: { suggestion_id: id(true) } },
  voice_preview_ended: {
    source: 'client',
    intent: 'required',
    language: 'required',
    props: { suggestion_id: id(true), seconds: int(true, 0, 600), outcome: oneOf(['finished', 'stopped', 'started_practice'], true) },
  },
  answer_feedback: {
    source: 'client',
    intent: 'optional',
    language: 'required',
    props: { message_id: id(true), thumbs: oneOf(['up', 'down'], true), had_suggestion: bool(true) },
  },
};

/** The PRD's required instrumentation set (each tagged with intent type, language and arm). */
export const PRD_REQUIRED_EVENTS = (Object.keys(EVENT_CATALOGUE) as EventName[]).filter((e) => EVENT_CATALOGUE[e].prd);

/** Validates props against the spec. Returns null when valid, else a reason (never echoes values). */
export function checkEventProps(event: EventName, props: Record<string, unknown>): string | null {
  const spec = EVENT_CATALOGUE[event];
  for (const key of Object.keys(props)) if (!(key in spec.props)) return `props.${key}: not in the catalogue for ${event}`;
  for (const [key, p] of Object.entries(spec.props)) {
    const v = props[key];
    if (v === undefined || v === null) {
      if (p.required) return `props.${key}: required for ${event}`;
      continue;
    }
    switch (p.type) {
      case 'id':
        if (typeof v !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,64}$/.test(v)) return `props.${key}: must be an id`;
        break;
      case 'enum':
        if (typeof v !== 'string' || !p.values.includes(v)) return `props.${key}: must be one of ${p.values.join('|')}`;
        break;
      case 'int':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < (p.min ?? -Infinity) || v > (p.max ?? Infinity)) return `props.${key}: must be an integer`;
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return `props.${key}: must be a number`;
        break;
      case 'bool':
        if (typeof v !== 'boolean') return `props.${key}: must be a boolean`;
        break;
    }
  }
  return null;
}


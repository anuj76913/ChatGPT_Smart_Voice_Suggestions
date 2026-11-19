import type { ClassifierLanguage, IntentLabel } from './intents';

export const ARMS = ['control', 'treatment'] as const;
export type Arm = (typeof ARMS)[number];

/** Event catalogue (architecture §12.2). */
export const EVENT_NAMES = [
  'suggestion_eligible',
  'suggestion_shown',
  'suggestion_tapped',
  'suggestion_dismissed',
  'suggestions_opted_out',
  'suggestions_opted_in',
  'privacy_notice_shown',
  'privacy_notice_ack',
  'mic_permission_denied',
  'mic_permission_granted',
  'voice_session_started',
  'voice_session_completed',
  'voice_setting_changed',
  'noisy_room_hint_shown',
  'voice_session_network_drop',
  'summary_action',
  // Phase 11 v2 bets
  'voice_preview_started',
  'voice_preview_ended',
  'answer_feedback',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/**
 * Events that must be emitted by the server, never trusted from the client,
 * because the key metrics depend on them (edge-case EX-05).
 */
export const SERVER_EMITTED_EVENTS: readonly EventName[] = [
  'suggestion_eligible',
  'voice_session_started',
  'voice_session_completed',
];

export type EventPropValue = string | number | boolean | null;
export type Platform = 'web-mobile' | 'web-desktop';

/**
 * What the client sends to POST /v1/events. The server adds user_id, experiment_id, arm and cohort,
 * so the client can't spoof them (edge-case EX-05).
 */
export interface ClientEventInput {
  event: EventName;
  event_id: string;
  ts: string;
  session_id: string;
  intent_type?: IntentLabel | null;
  language?: ClassifierLanguage | null;
  app_version: string;
  platform: Platform;
  props?: Record<string, EventPropValue>;
}

/** Standard stored envelope (architecture §12.1). Never contains query or transcript text. */
export interface EventEnvelope {
  event: EventName;
  event_id: string;
  ts: string;
  user_id: string;
  session_id: string;
  /** null until the user has an experiment assignment (Phase 3). */
  experiment_id: string | null;
  arm: Arm | null;
  intent_type: IntentLabel | null;
  language: ClassifierLanguage | null;
  app_version: string;
  platform: Platform;
  props: Record<string, EventPropValue>;
}

/** Prop keys that would carry free text. Events with these keys are rejected (P1.7, edge-case SF-04). */
export const FORBIDDEN_EVENT_PROP_KEYS = [
  'text',
  'query',
  'prompt',
  'transcript',
  'content',
  'message',
  'answer',
  'body',
  'utterance',
  'reply',
] as const;
export const MAX_EVENT_PROP_STRING = 64;
export const MAX_EVENT_PROPS = 20;
export const MAX_EVENTS_PER_BATCH = 50;

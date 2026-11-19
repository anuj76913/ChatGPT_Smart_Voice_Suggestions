import type { SuggestionCardPayload } from './copy';

/**
 * Chat API contract (architecture §9.1). Shared by the server (S1/S2) and the web client (C1).
 * Responses to POST /v1/conversations/:id/messages are Server-Sent Events whose `data:` is one ChatStreamEvent.
 */

export type ChatStreamEvent =
  | { type: 'message.accepted'; user_message_id: string; replay: boolean }
  | { type: 'answer.delta'; message_id: string; text: string }
  | { type: 'answer.complete'; message_id: string; ttft_ms: number | null }
  | { type: 'answer.error'; message_id: string | null; code: AnswerErrorCode; retryable: boolean }
  /** Smart Voice Suggestion card (Phase 3). Only for treatment users, only after answer.complete, before stream.end. */
  | ({ type: 'suggestion'; message_id: string } & SuggestionCardPayload)
  | { type: 'stream.end' };

export type AnswerErrorCode = 'llm_unavailable' | 'rate_limited' | 'in_progress' | 'aborted' | 'internal';

export interface SendMessageRequest {
  text: string;
  /** Client-generated id; resending the same id never creates a second message (idempotency). */
  client_msg_id: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'complete' | 'aborted' | 'error';
  created_at: string;
  /** Assistant messages only: the card shown under this answer, if it is still visible (shown or tapped). */
  suggestion?: (SuggestionCardPayload & { status: 'shown' | 'tapped' }) | null;
  /** Set for the recap a voice session leaves in the chat (no answer to rate, no card). */
  kind?: 'voice_recap';
}

/** messages.model value that marks a voice-session recap (not a model answer). */
export const VOICE_RECAP_MODEL = 'voice-recap';

/** GET/PUT /v1/me/voice-preferences (FR-4, FR-10). */
export interface VoicePreferences {
  suggestions_enabled: boolean;
  paused_until: string | null;
  voice_speed: 'slow' | 'normal' | 'fast';
  voice_accent: 'en-IN' | 'hi-IN';
  /** FR-6: the first-use privacy notice was acknowledged (shown once per account). */
  privacy_notice_seen: boolean;
  /** Phase 11 quiet / whisper mode (used only when the v2.quietMode flag is on). */
  voice_quiet: boolean;
}

export interface Me {
  id: string;
  handle: string;
  display_name: string;
  is_admin: boolean;
  cohort: string | null;
  /** In a dogfood cohort (config dogfoodCohorts): sees cards, can report problems, is asked for research consent. */
  is_dogfood: boolean;
  /** P8.2: may this participant's queries be reviewed to improve the classifier? null = not asked yet. */
  research_consent: 'granted' | 'declined' | null;
}

/** POST /v1/feedback (dogfood "Report a problem"). */
export interface FeedbackReportRequest {
  kind: 'bug' | 'idea' | 'other';
  text: string;
  screen?: string;
  voice_session_id?: string;
  message_id?: string;
}

export interface ClientConfig {
  ttl_seconds: number;
  copy_languages: string[];
  max_message_chars: number;
  /** Phase 11 v2 feature flags the UI needs (the server still enforces them). */
  features: { preview_mode: boolean; quiet_mode: boolean };
}

export const MAX_MESSAGE_CHARS = 4000;

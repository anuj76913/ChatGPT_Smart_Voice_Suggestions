import type { EntryPoint, ClassifierLanguage, VoiceIntent } from './intents';

/**
 * Voice session contract (architecture §9.3 + §6.8 as built in Phase 4).
 * REST creates/ends sessions; a WebSocket carries one audio clip per spoken turn up and text events down.
 * The browser speaks replies with speechSynthesis, so audio only ever flows client → server → Groq Whisper.
 */

export interface CreateVoiceSessionRequest {
  intent: VoiceIntent;
  entry_point: EntryPoint;
  conversation_id?: string;
  suggestion_id?: string;
  /** With entry_point "next_activity": which of the preset's next activities to focus on (FR-9). */
  next_activity_index?: number;
}

export interface VoiceSettings {
  speed: 'slow' | 'normal' | 'fast';
  accent: 'en-IN' | 'hi-IN';
  /** Phase 11 quiet / whisper mode (only when the v2.quietMode flag is on). */
  quiet?: boolean;
}

export interface CreateVoiceSessionResponse {
  session_id: string;
  preset_id: string;
  label: string;
  opening: { text: string; language: ClassifierLanguage; source: 'llm' | 'template' };
  settings: VoiceSettings;
  stream: { path: string; token: string };
  limits: { max_duration_s: number; warn_before_end_s: number; max_turn_s: number; end_of_speech_silence_ms: number; reconnect_ms: number; silence_nudge_ms: number; silence_pause_ms: number };
}

export type VoiceEndReason = 'user' | 'cap' | 'network' | 'superseded' | 'error' | 'continue_in_text' | 'idle';

export interface VoiceSessionStats {
  session_id: string;
  duration_s: number;
  questions_practised: number;
  user_turns: number;
  dominant_language: ClassifierLanguage | null;
  qualifies_for_wavl: boolean;
  end_reason: VoiceEndReason;
  /** Streak after this session (P5.3). `credited` = this session counted for today. */
  streak: StreakInfo;
}

export interface StreakInfo {
  current: number;
  goal: number;
  credited: boolean;
}

/** GET /v1/voice/sessions/:id/summary (FR-8, FR-9; design-spec §6). */
export interface SessionSummary {
  session_id: string;
  preset_id: string;
  label: string;
  intent: VoiceIntent;
  duration_s: number;
  questions_practised: number;
  /** Under the WAVL minimum (30 s): shown as a short session with no streak credit (edge-case SU-02). */
  short_session: boolean;
  qualifies_for_wavl: boolean;
  /** Exactly one actionable tip in the dominant language, or null (no answers, or the model failed: SU-03/SU-04). */
  tip: string | null;
  /** Shown instead of a tip when the learner didn't answer anything (SU-03). */
  encouragement: string | null;
  language: ClassifierLanguage;
  next_activity: { index: number; label: string };
  streak: StreakInfo;
}

/** Client → server JSON messages (binary frames are audio clips, one per turn). */
export type VoiceClientMessage =
  | { type: 'hello'; last_turn_id?: string | null }
  /** Sent just before each binary audio frame: its MIME type (webm/opus on Chrome, mp4 on Safari). */
  | { type: 'turn'; mime: string }
  | { type: 'settings'; speed?: VoiceSettings['speed']; accent?: VoiceSettings['accent']; quiet?: boolean }
  | { type: 'metrics'; start_latency_ms: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end'; reason?: 'user' | 'idle' };

/** Server → client messages. */
export type VoiceServerMessage =
  | { type: 'ready'; session_id: string; resumed: boolean; missed: Array<{ turn_id: string; role: 'user' | 'assistant'; text: string }> }
  | { type: 'transcript.final'; turn_id: string; text: string; language: ClassifierLanguage; low_quality: boolean }
  | { type: 'transcript.empty' }
  /** The transcript was the coach's own voice picked up by the mic (speaker echo): dropped; listen again. */
  | { type: 'transcript.echo' }
  | { type: 'reply.sentence'; text: string; language: ClassifierLanguage }
  | { type: 'reply.done'; turn_id: string; text: string; question: boolean }
  | { type: 'hint.noisy_room' }
  | { type: 'limit.warning'; seconds_left: number }
  | { type: 'busy' }
  | { type: 'error'; code: 'stt_failed' | 'coach_failed' | 'audio_too_large' | 'bad_message' | 'too_many_turns' }
  | { type: 'session.ended'; stats: VoiceSessionStats };

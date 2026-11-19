-- Phase 1 schema: every entity from architecture §8, plus config, events and LLM usage metering.
-- Privacy rule (PRD / architecture §13.3): no audio is ever stored, so there is no audio column anywhere.

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle           text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  region           text NOT NULL DEFAULT 'IN',
  tier             text,
  primary_language text,
  cohort           text,
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',
  is_test          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voice_prefs (
  user_id                uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  suggestions_enabled    boolean NOT NULL DEFAULT true,
  privacy_notice_seen_at timestamptz,
  consecutive_dismissals integer NOT NULL DEFAULT 0 CHECK (consecutive_dismissals >= 0),
  paused_until           timestamptz,
  voice_speed            text NOT NULL DEFAULT 'normal',
  voice_accent           text NOT NULL DEFAULT 'en-IN',
  streak_current         integer NOT NULL DEFAULT 0 CHECK (streak_current >= 0),
  streak_last_day        date,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_assignments (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experiment_id text NOT NULL,
  arm           text NOT NULL CHECK (arm IN ('control', 'treatment')),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, experiment_id)
);

CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_updated_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order. created_at alone can tie (a user message and its reply placeholder share one transaction).
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL DEFAULT '',
  client_msg_id   text,
  reply_to        uuid REFERENCES messages(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming', 'complete', 'aborted', 'error')),
  model           text,
  ttft_ms         integer,
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_seq_idx ON messages (conversation_id, seq);
-- Idempotency (P1.4): one user message per client_msg_id per conversation.
CREATE UNIQUE INDEX messages_client_msg_id_uniq ON messages (conversation_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX messages_reply_to_idx ON messages (reply_to) WHERE reply_to IS NOT NULL;

CREATE TABLE suggestions (
  id              text PRIMARY KEY, -- derived from (conversation_id, message_id): idempotent
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent          text NOT NULL,
  confidence      real,
  language        text,
  arm             text CHECK (arm IN ('control', 'treatment')),
  status          text NOT NULL CHECK (status IN ('eligible_control', 'shown', 'tapped', 'dismissed', 'opted_out', 'ignored', 'late')),
  evaluated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suggestions_user_time_idx ON suggestions (user_id, evaluated_at DESC);

CREATE TABLE voice_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  suggestion_id      text REFERENCES suggestions(id) ON DELETE SET NULL,
  preset_id          text,
  entry_point        text NOT NULL CHECK (entry_point IN ('suggestion_card', 'mic_button', 'practice_again', 'next_activity')),
  status             text NOT NULL DEFAULT 'creating',
  started_at         timestamptz,
  ended_at           timestamptz,
  end_reason         text,
  dominant_language  text,
  qualifies_for_wavl boolean NOT NULL DEFAULT false
);
CREATE INDEX voice_sessions_user_started_idx ON voice_sessions (user_id, started_at DESC);

-- Finalized turns only, and only as the existing Voice Mode policy allows. No audio column.
CREATE TABLE voice_turns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('user', 'assistant')),
  transcript     text NOT NULL,
  language       text,
  stt_confidence real,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_turns_session_idx ON voice_turns (session_id, at);

CREATE TABLE session_summaries (
  session_id          uuid PRIMARY KEY REFERENCES voice_sessions(id) ON DELETE CASCADE,
  duration_s          integer NOT NULL,
  questions_practised integer NOT NULL,
  tip                 text,
  next_activity       text,
  streak_after        integer,
  language            text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- S7 runtime config: a single row of overrides deep-merged onto the defaults, plus an audit trail.
CREATE TABLE svs_config (
  id         integer PRIMARY KEY CHECK (id = 1),
  overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,
  version    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
INSERT INTO svs_config (id) VALUES (1);

CREATE TABLE svs_config_audit (
  id            bigserial PRIMARY KEY,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  reason        text NOT NULL,
  version       integer NOT NULL,
  old_overrides jsonb NOT NULL,
  new_overrides jsonb NOT NULL
);

-- S12 analytics events (MVP analytics store, decisions.md ADR-003). IDs and enums only, never content.
CREATE TABLE events (
  event_id      uuid PRIMARY KEY,
  event         text NOT NULL,
  ts            timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL CHECK (source IN ('client', 'server')),
  user_id       uuid NOT NULL,
  session_id    text NOT NULL,
  experiment_id text,
  arm           text,
  cohort        text,
  intent_type   text,
  language      text,
  app_version   text,
  platform      text,
  props         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_event_ts_idx ON events (event, ts);
CREATE INDEX events_user_ts_idx ON events (user_id, ts);

-- S13 metering: one row per Groq call (cost per WAVL, Groq health). No prompt or completion text.
CREATE TABLE llm_usage (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  use_case          text NOT NULL,
  model             text NOT NULL,
  status            text NOT NULL,
  error_kind        text,
  fallback_used     boolean NOT NULL DEFAULT false,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  latency_ms        integer,
  ttft_ms           integer,
  user_id           uuid,
  conversation_id   uuid,
  voice_session_id  uuid,
  arm               text
);
CREATE INDEX llm_usage_at_idx ON llm_usage (at);
CREATE INDEX llm_usage_use_case_at_idx ON llm_usage (use_case, at);

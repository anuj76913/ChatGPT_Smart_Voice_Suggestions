-- Phase 6: analytics, experiment checks and alerting (architecture §11–12).

-- Billed audio length per Whisper call, for cost per WAVL (Groq bills at least 10 s per request).
ALTER TABLE llm_usage ADD COLUMN audio_seconds real;

-- Intent and opening language on the session row, so client events that only carry a voice_session_id
-- can be tagged with intent and language server-side (P6.1, edge-case EX-05).
ALTER TABLE voice_sessions ADD COLUMN intent text, ADD COLUMN language text;
UPDATE voice_sessions SET intent = CASE preset_id
    WHEN 'interview_practice' THEN 'mock_interview'
    WHEN 'spoken_english' THEN 'spoken_english'
    WHEN 'viva_revision' THEN 'viva_revision'
    WHEN 'pronunciation' THEN 'pronunciation'
  END
WHERE intent IS NULL;

-- Experiment and funnel queries filter on experiment + event + time.
CREATE INDEX events_experiment_event_ts_idx ON events (experiment_id, event, ts);
CREATE INDEX events_suggestion_id_idx ON events ((props->>'suggestion_id')) WHERE props ? 'suggestion_id';
CREATE INDEX events_voice_session_id_idx ON events ((props->>'voice_session_id')) WHERE props ? 'voice_session_id';
CREATE INDEX suggestions_message_idx ON suggestions (message_id);

-- P6.4 alerts. One open row per (rule, key); it is resolved when the rule clears. No content, only numbers.
CREATE TABLE alert_events (
  id          bigserial PRIMARY KEY,
  rule        text NOT NULL,
  key         text NOT NULL DEFAULT '',
  severity    text NOT NULL CHECK (severity IN ('warning', 'critical')),
  status      text NOT NULL CHECK (status IN ('firing', 'resolved')),
  value       double precision,
  threshold   double precision,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  fired_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX alert_events_open_idx ON alert_events (rule, key) WHERE status = 'firing';
CREATE INDEX alert_events_fired_idx ON alert_events (fired_at DESC);
CREATE INDEX suggestion_decisions_message_idx ON suggestion_decisions (message_id);

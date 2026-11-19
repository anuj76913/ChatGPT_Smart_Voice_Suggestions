-- Phase 4: per-session stats kept on the session row (summary/tip arrive in Phase 5).
ALTER TABLE voice_sessions
  ADD COLUMN start_latency_ms    integer,
  ADD COLUMN opening_source      text,
  ADD COLUMN duration_s          integer,
  ADD COLUMN questions_practised integer NOT NULL DEFAULT 0,
  ADD COLUMN user_turns          integer NOT NULL DEFAULT 0;

-- Finding a user's live session quickly (one active session per user, edge-case VS-08).
CREATE INDEX voice_sessions_user_active_idx ON voice_sessions (user_id) WHERE status = 'active';

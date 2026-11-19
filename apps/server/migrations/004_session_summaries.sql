-- Phase 5: summary details and the "Back to Chat" recap link.
ALTER TABLE session_summaries
  ADD COLUMN next_activity_index integer,
  ADD COLUMN tip_source          text,   -- llm | none (no answers) | failed (both models failed)
  ADD COLUMN recap_message_id    uuid REFERENCES messages(id) ON DELETE SET NULL;

-- Which next activity a follow-up session focuses on (FR-9).
ALTER TABLE voice_sessions ADD COLUMN focus text;

-- Streak credit given by this session (P5.3), so the summary can show it and re-ending never double-counts.
ALTER TABLE voice_sessions ADD COLUMN streak_after integer, ADD COLUMN streak_credited boolean NOT NULL DEFAULT false;

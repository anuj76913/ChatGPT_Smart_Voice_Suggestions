-- Phase 8: internal dogfood.

-- P8.2 research consent: dogfood participants choose whether their queries may be reviewed and labelled to extend
-- the classifier eval set. Only queries from users with 'granted' are ever exported (scripts/dogfood/export-queries.ts).
ALTER TABLE users
  ADD COLUMN research_consent    text CHECK (research_consent IN ('granted', 'declined')),
  ADD COLUMN research_consent_at timestamptz;

-- P8.3 "Report a problem" from dogfood participants. Free text the participant chose to send; kept for
-- privacy.feedbackRetentionDays, then deleted by the retention job.
CREATE TABLE feedback_reports (
  id               bigserial PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL CHECK (kind IN ('bug', 'idea', 'other')),
  text             text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  screen           text,
  voice_session_id uuid,
  message_id       uuid,
  app_version      text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'closed')),
  triage           text
);
CREATE INDEX feedback_reports_created_idx ON feedback_reports (created_at DESC);

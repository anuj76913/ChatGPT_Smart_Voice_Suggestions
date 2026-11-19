-- Phase 11 v2 bets (each behind its own config flag).

-- New voice entry points: `preview` (Start practising after a voice preview), `challenge` (a 7-day challenge day).
ALTER TABLE voice_sessions DROP CONSTRAINT IF EXISTS voice_sessions_entry_point_check;
ALTER TABLE voice_sessions ADD CONSTRAINT voice_sessions_entry_point_check
  CHECK (entry_point IN ('suggestion_card', 'mic_button', 'practice_again', 'next_activity', 'preview', 'challenge'));

-- Whisper / low-volume mode preference.
ALTER TABLE voice_prefs ADD COLUMN quiet_mode boolean NOT NULL DEFAULT false;

-- Voice Learning Challenges: one active enrollment per user and challenge; one row per completed day.
CREATE TABLE challenge_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  completed_at timestamptz,
  UNIQUE (user_id, challenge_id)
);
CREATE TABLE challenge_days (
  enrollment_id    uuid NOT NULL REFERENCES challenge_enrollments(id) ON DELETE CASCADE,
  day              integer NOT NULL CHECK (day BETWEEN 1 AND 31),
  voice_session_id uuid REFERENCES voice_sessions(id) ON DELETE SET NULL,
  completed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, day)
);
ALTER TABLE voice_sessions ADD COLUMN challenge_enrollment_id uuid REFERENCES challenge_enrollments(id) ON DELETE SET NULL,
                           ADD COLUMN challenge_day integer;

-- Voice Learning Challenges were out of scope for the prototype: remove them (added in 008).
-- Sessions that were started as a challenge day are kept as ordinary mic-button sessions.
UPDATE voice_sessions SET entry_point = 'mic_button' WHERE entry_point = 'challenge';
ALTER TABLE voice_sessions DROP COLUMN IF EXISTS challenge_enrollment_id, DROP COLUMN IF EXISTS challenge_day;
DROP TABLE IF EXISTS challenge_days;
DROP TABLE IF EXISTS challenge_enrollments;
ALTER TABLE voice_sessions DROP CONSTRAINT IF EXISTS voice_sessions_entry_point_check;
ALTER TABLE voice_sessions ADD CONSTRAINT voice_sessions_entry_point_check
  CHECK (entry_point IN ('suggestion_card', 'mic_button', 'practice_again', 'next_activity', 'preview'));
DELETE FROM events WHERE event IN ('challenge_joined', 'challenge_day_completed');
-- Stored runtime config must stay valid now that the v2.challenges setting no longer exists.
UPDATE svs_config SET overrides = overrides #- '{v2,challenges}' WHERE overrides #> '{v2,challenges}' IS NOT NULL;

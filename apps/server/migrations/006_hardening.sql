-- Phase 7 hardening.

-- P7.4 session revocation: the cookie carries (user id, epoch). Logging out bumps the epoch, which invalidates
-- every cookie issued before it (stolen cookies stop working; all of the user's devices are signed out).
ALTER TABLE users ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;

-- P7.3 transcript retention: the purge job deletes finalized voice turns (and summary tips derived from them)
-- older than privacy.voiceTranscriptRetentionDays.
CREATE INDEX voice_turns_at_idx ON voice_turns (at);
CREATE INDEX session_summaries_created_idx ON session_summaries (created_at) WHERE tip IS NOT NULL;

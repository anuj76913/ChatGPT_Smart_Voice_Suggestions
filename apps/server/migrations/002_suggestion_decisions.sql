-- Phase 3: one row per suggestion decision (every answered chat message), for funnel debugging and
-- reason-code metrics (architecture §6.2 "Reason codes for every `no`"). IDs, enums and numbers only, never text.
CREATE TABLE suggestion_decisions (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  user_id           uuid NOT NULL,
  conversation_id   uuid NOT NULL,
  message_id        uuid NOT NULL,
  -- shown | eligible_control | late | answer_failed | stale_config | disabled | kill_switch | rollout | opted_out |
  -- paused | conv_cap | weekly_cap | conv_has_voice | prefilter | not_voice_friendly | low_confidence | classifier_error | error
  outcome           text NOT NULL,
  arm               text,
  intent            text,
  confidence        real,
  language          text,
  classifier_stage  text,
  classifier_ms     integer,
  decision_ms       integer
);
CREATE INDEX suggestion_decisions_at_idx ON suggestion_decisions (at);
CREATE INDEX suggestion_decisions_outcome_idx ON suggestion_decisions (outcome, at);

-- Cap checks scan a conversation's suggestions.
CREATE INDEX suggestions_conversation_idx ON suggestions (conversation_id);

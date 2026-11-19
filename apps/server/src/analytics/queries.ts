/**
 * P6.2 metric definitions as versioned SQL (architecture §12.3, METRICS_VERSION in @svs/shared).
 * Every query takes the same window parameters:
 *   $1 from (timestamptz, inclusive) · $2 to (exclusive) · $3 experiment id, or NULL for all traffic (incl. dogfood)
 *   $4 include test users (users.is_test)
 * "Local day" uses each learner's time zone (users.timezone). Events carry no content, so neither do these queries.
 * Changing what any query means requires bumping METRICS_VERSION and noting it in docs/phase6/metrics.md.
 */

const BASE = `
  pop  AS (SELECT id, timezone FROM users WHERE (NOT is_test OR $4::boolean)),
  arms AS (SELECT user_id, arm FROM experiment_assignments WHERE experiment_id = $3::text)`;

const inExperiment = (alias: string) => `($3::text IS NULL OR ${alias}.experiment_id = $3::text)`;

/** Card-level funnel, one row per (arm, intent, language). Unit = an eligible suggestion. */
export const Q_FUNNEL = `
WITH ${BASE},
elig AS (
  SELECT DISTINCT ON (e.props->>'suggestion_id')
         e.props->>'suggestion_id' AS sid, e.user_id, COALESCE(e.arm, 'none') AS arm, e.intent_type, e.language, pop.timezone
    FROM events e JOIN pop ON pop.id = e.user_id
   WHERE e.event = 'suggestion_eligible' AND ${inExperiment('e')} AND e.ts >= $1 AND e.ts < $2
   ORDER BY e.props->>'suggestion_id', e.ts),
f AS (
  SELECT el.arm, el.intent_type, el.language,
         EXISTS (SELECT 1 FROM events x WHERE x.event = 'suggestion_shown' AND x.props->>'suggestion_id' = el.sid) AS shown,
         EXISTS (SELECT 1 FROM events x WHERE x.event = 'suggestion_tapped' AND x.props->>'suggestion_id' = el.sid) AS tapped,
         EXISTS (SELECT 1 FROM events x WHERE x.event = 'mic_permission_granted' AND x.props->>'suggestion_id' = el.sid
                    AND x.props->>'entry_point' = 'suggestion_card') AS permission_ok,
         st.vsid IS NOT NULL AS started,
         EXISTS (SELECT 1 FROM events x WHERE x.event = 'voice_session_completed' AND x.props->>'voice_session_id' = st.vsid
                    AND (x.props->>'qualifies_for_wavl')::boolean) AS completed_30s,
         EXISTS (SELECT 1 FROM events y WHERE y.event = 'voice_session_started' AND y.user_id = el.user_id
                    AND (y.ts AT TIME ZONE el.timezone)::date - (st.ts AT TIME ZONE el.timezone)::date BETWEEN 1 AND 7) AS returned_d7
    FROM elig el
    LEFT JOIN LATERAL (
      SELECT x.props->>'voice_session_id' AS vsid, x.ts FROM events x
       WHERE x.event = 'voice_session_started' AND x.props->>'suggestion_id' = el.sid AND x.props->>'entry_point' = 'suggestion_card'
       ORDER BY x.ts LIMIT 1) st ON true)
SELECT arm, intent_type AS intent, language,
       count(*)::int AS eligible,
       count(*) FILTER (WHERE shown)::int AS shown,
       count(*) FILTER (WHERE tapped)::int AS tapped,
       count(*) FILTER (WHERE permission_ok)::int AS permission_ok,
       count(*) FILTER (WHERE started)::int AS started,
       count(*) FILTER (WHERE completed_30s)::int AS completed_30s,
       count(*) FILTER (WHERE started AND returned_d7)::int AS returned_d7
  FROM f GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;

/** WAVL: distinct learners per ISO week (local time) with ≥1 completed session that qualifies (≥30 s, learning preset). */
export const Q_WAVL = `
WITH ${BASE}
SELECT to_char(e.ts AT TIME ZONE pop.timezone, 'IYYY-"W"IW') AS week, COALESCE(a.arm, 'none') AS arm, count(DISTINCT e.user_id)::int AS learners
  FROM events e JOIN pop ON pop.id = e.user_id LEFT JOIN arms a ON a.user_id = e.user_id
 WHERE e.event = 'voice_session_completed' AND (e.props->>'qualifies_for_wavl')::boolean AND e.ts >= $1 AND e.ts < $2
 GROUP BY 1, 2 ORDER BY 1, 2`;

/** Card-level start rate and tap rate (treatment): per shown card, did a session start from it / was it tapped. */
export const Q_CARD_START = `
WITH ${BASE},
shown AS (
  SELECT DISTINCT ON (e.props->>'suggestion_id') e.props->>'suggestion_id' AS sid, e.intent_type
    FROM events e JOIN pop ON pop.id = e.user_id
   WHERE e.event = 'suggestion_shown' AND ${inExperiment('e')} AND e.ts >= $1 AND e.ts < $2
   ORDER BY e.props->>'suggestion_id', e.ts)
SELECT s.intent_type AS intent, count(*)::int AS shown,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events x WHERE x.event = 'voice_session_started'
                          AND x.props->>'suggestion_id' = s.sid AND x.props->>'entry_point' = 'suggestion_card'))::int AS started,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events x WHERE x.event = 'suggestion_tapped' AND x.props->>'suggestion_id' = s.sid))::int AS tapped
  FROM shown s GROUP BY 1 ORDER BY 1`;

/** Primary A/B metric: eligible users who start ≥1 voice session after their first eligibility, by arm. */
export const Q_ELIGIBLE_START = `
WITH ${BASE},
el AS (
  SELECT e.user_id, min(e.ts) AS first_ts FROM events e JOIN pop ON pop.id = e.user_id
   WHERE e.event = 'suggestion_eligible' AND ${inExperiment('e')} AND e.ts >= $1 AND e.ts < $2 GROUP BY 1)
SELECT COALESCE(a.arm, 'none') AS arm, count(*)::int AS den,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events x WHERE x.event = 'voice_session_started'
                          AND x.user_id = el.user_id AND x.ts >= el.first_ts AND x.ts < $2))::int AS num
  FROM el LEFT JOIN arms a ON a.user_id = el.user_id GROUP BY 1`;

/** Sessions per user per week: sessions started ÷ learner-weeks with ≥1 session. */
export const Q_SESSIONS_PER_WEEK = `
WITH ${BASE}
SELECT COALESCE(a.arm, 'none') AS arm, count(*)::int AS sessions,
       count(DISTINCT (e.user_id, to_char(e.ts AT TIME ZONE pop.timezone, 'IYYY-IW')))::int AS user_weeks
  FROM events e JOIN pop ON pop.id = e.user_id LEFT JOIN arms a ON a.user_id = e.user_id
 WHERE e.event = 'voice_session_started' AND e.ts >= $1 AND e.ts < $2 GROUP BY 1`;

/** D7 voice retention: first-ever voice session in the window (and ≥8 days ago), another session on local days 1–7. */
export const Q_D7 = `
WITH ${BASE},
firsts AS (SELECT e.user_id, min(e.ts) AS first_ts FROM events e JOIN pop ON pop.id = e.user_id WHERE e.event = 'voice_session_started' GROUP BY 1)
SELECT COALESCE(a.arm, 'none') AS arm, count(*)::int AS den,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events x WHERE x.event = 'voice_session_started' AND x.user_id = f.user_id
                          AND (x.ts AT TIME ZONE p.timezone)::date - (f.first_ts AT TIME ZONE p.timezone)::date BETWEEN 1 AND 7))::int AS num
  FROM firsts f JOIN pop p ON p.id = f.user_id LEFT JOIN arms a ON a.user_id = f.user_id
 WHERE f.first_ts >= $1 AND f.first_ts < $2 AND f.first_ts <= now() - interval '8 days'
 GROUP BY 1`;

/**
 * D30 retention proxy (the PRD uses the existing app-level pipeline): users whose day-30–36 return window closed
 * inside the report window (first activity + 37 days in [from, to)), active again on local days 30–36.
 * (A cohort that both starts in a 4-week window and is 37 days old can't exist, so D30 is read by maturity date.)
 */
export const Q_D30 = `
WITH ${BASE},
act AS (
  SELECT c.user_id, m.created_at AS ts FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user'
  UNION ALL
  SELECT user_id, ts FROM events WHERE event = 'voice_session_started'),
firsts AS (SELECT user_id, min(ts) AS first_ts FROM act GROUP BY 1)
SELECT COALESCE(a.arm, 'none') AS arm, count(*)::int AS den,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act x WHERE x.user_id = f.user_id
                          AND (x.ts AT TIME ZONE p.timezone)::date - (f.first_ts AT TIME ZONE p.timezone)::date BETWEEN 30 AND 36))::int AS num
  FROM firsts f JOIN pop p ON p.id = f.user_id LEFT JOIN arms a ON a.user_id = f.user_id
 WHERE f.first_ts + interval '37 days' >= $1 AND f.first_ts + interval '37 days' < LEAST($2::timestamptz, now())
 GROUP BY 1`;

/** Opt-out rate: users shown a card in the window who later turned suggestions off (any source). */
export const Q_OPT_OUT = `
WITH ${BASE},
sh AS (
  SELECT e.user_id, min(e.ts) AS first_ts FROM events e JOIN pop ON pop.id = e.user_id
   WHERE e.event = 'suggestion_shown' AND ${inExperiment('e')} AND e.ts >= $1 AND e.ts < $2 GROUP BY 1)
SELECT count(*)::int AS den,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events x WHERE x.event = 'suggestions_opted_out'
                          AND x.user_id = sh.user_id AND x.ts >= sh.first_ts AND x.ts < $2))::int AS num
  FROM sh`;

/** Thumbs-down (latest vote per answer): answers that showed a card vs control answers that were eligible for one. */
export const Q_THUMBS = `
WITH ${BASE},
fb AS (
  SELECT DISTINCT ON (e.props->>'message_id') e.props->>'message_id' AS mid, e.props->>'thumbs' AS thumbs
    FROM events e JOIN pop ON pop.id = e.user_id
   WHERE e.event = 'answer_feedback' AND e.ts >= $1 AND e.ts < $2
   ORDER BY e.props->>'message_id', e.ts DESC)
SELECT CASE WHEN s.status = 'eligible_control' THEN 'control_eligible' ELSE 'with_card' END AS grp,
       count(*)::int AS den, count(*) FILTER (WHERE fb.thumbs = 'down')::int AS num
  FROM fb JOIN suggestions s ON s.message_id::text = fb.mid
 WHERE s.status IN ('shown', 'tapped', 'dismissed', 'opted_out', 'ignored', 'eligible_control')
   AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM arms a WHERE a.user_id = s.user_id))
 GROUP BY 1`;

/** Groq usage by use case, model and arm (cost is priced in TypeScript from config). $5 = minimum billed STT seconds. */
export const Q_COST = `
WITH ${BASE}
SELECT u.use_case, u.model, COALESCE(a.arm, 'none') AS arm,
       COALESCE(sum(u.prompt_tokens), 0)::float8 AS prompt_tokens,
       COALESCE(sum(u.completion_tokens), 0)::float8 AS completion_tokens,
       COALESCE(sum(CASE WHEN u.use_case = 'stt' AND u.status = 'ok' THEN GREATEST(COALESCE(u.audio_seconds, 0), $5::float8) ELSE 0 END), 0)::float8 AS audio_seconds
  FROM llm_usage u
  LEFT JOIN users usr ON usr.id = u.user_id
  LEFT JOIN arms a ON a.user_id = u.user_id
 WHERE u.at >= $1 AND u.at < $2 AND (usr.id IS NULL OR NOT usr.is_test OR $4::boolean)
 GROUP BY 1, 2, 3`;

/** SRM inputs: all-time assignments, plus eligible users and eligible events in the window, by arm. */
export const Q_EXPERIMENT = `
WITH ${BASE}
SELECT 'assignments' AS what, ea.arm, count(*)::int AS n
  FROM experiment_assignments ea JOIN pop ON pop.id = ea.user_id WHERE ea.experiment_id = $3::text GROUP BY 1, 2
UNION ALL
SELECT 'eligible_users', e.arm, count(DISTINCT e.user_id)::int
  FROM events e JOIN pop ON pop.id = e.user_id
 WHERE e.event = 'suggestion_eligible' AND e.experiment_id = $3::text AND e.ts >= $1 AND e.ts < $2 GROUP BY 1, 2
UNION ALL
SELECT 'eligible_events', e.arm, count(*)::int
  FROM events e JOIN pop ON pop.id = e.user_id
 WHERE e.event = 'suggestion_eligible' AND e.experiment_id = $3::text AND e.ts >= $1 AND e.ts < $2 GROUP BY 1, 2`;

/** Groq health per use case ($1/$2 only). Rows are per model attempt; ttft is set for streaming use cases. */
export const Q_HEALTH = `
SELECT use_case, count(*)::int AS calls,
       count(*) FILTER (WHERE status <> 'ok')::int AS errors,
       count(*) FILTER (WHERE error_kind = 'rate_limited')::int AS rate_limited,
       count(*) FILTER (WHERE error_kind = 'server')::int AS server_errors,
       count(*) FILTER (WHERE error_kind = 'timeout')::int AS timeouts,
       count(*) FILTER (WHERE fallback_used)::int AS fallbacks,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p95_ms,
       COALESCE(sum(total_tokens), 0)::int AS tokens
  FROM llm_usage WHERE at >= $1 AND at < $2 GROUP BY 1 ORDER BY 1`;

/** Token peak per model per minute in the window, and requests so far today (UTC, Groq's daily limit). */
export const Q_HEADROOM = `
SELECT m.model, COALESCE(p.peak, 0)::int AS peak_tpm, COALESCE(d.n, 0)::int AS requests_today
  FROM (SELECT DISTINCT model FROM llm_usage WHERE at >= LEAST($1::timestamptz, date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) m
  LEFT JOIN (SELECT model, max(t) AS peak FROM (
               SELECT model, date_trunc('minute', at) AS minute, sum(total_tokens) AS t FROM llm_usage
                WHERE at >= $1 AND at < $2 AND total_tokens IS NOT NULL GROUP BY 1, 2) x GROUP BY 1) p ON p.model = m.model
  LEFT JOIN (SELECT model, count(*) AS n FROM llm_usage WHERE at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY 1) d ON d.model = m.model
 ORDER BY 1`;

/** Voice start latency (session request → first audible audio, reported by the client) for sessions started in the window. */
export const Q_VOICE_START = `
SELECT count(start_latency_ms)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY start_latency_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY start_latency_ms) AS p95_ms
  FROM voice_sessions WHERE started_at >= $1 AND started_at < $2 AND start_latency_ms IS NOT NULL`;

/** Classifier outcome after fallback (one row per decision that reached the model). */
export const Q_CLASSIFIER = `
SELECT count(*)::int AS calls, count(*) FILTER (WHERE classifier_stage = 'error')::int AS errors
  FROM suggestion_decisions WHERE at >= $1 AND at < $2 AND classifier_stage IN ('model', 'error')`;

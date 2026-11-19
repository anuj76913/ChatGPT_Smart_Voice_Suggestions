# Metric Definitions (`metrics-v1`)

> The versioned definitions behind the dashboard, the alerts and the analysis script (implementation-plan P6.2, architecture §12.3).
> Source of truth: the SQL in [apps/server/src/analytics/queries.ts](../../apps/server/src/analytics/queries.ts). If any query's meaning changes, bump `METRICS_VERSION` in `packages/shared/src/metrics.ts` and record the change here.

## Conventions
- **Window:** `[from, to)`. The dashboard defaults to the last 28 days.
- **Scope:** an experiment id (default: `experiment.id` from config), or `all` (all traffic, dogfood included, no arm comparison).
- **Arm:** the user's row in `experiment_assignments` for that experiment. Users without one count as `none` (dogfood, or never eligible).
- **Population:** users with `is_test = false`. Age isn't collected, so the PRD's 18–24 filter can't be applied. The experiment population is "users with ≥1 `suggestion_eligible`", which the eligibility-based metrics use.
- **Local day:** the learner's own time zone (`users.timezone`). This is used for D7, D30 and ISO weeks.
- **Statistics:** two-sided two-proportion z-test, with a 95% CI on the difference (treatment − control). SRM uses a chi-square test with 1 degree of freedom against `experiment.treatmentShare`.

## Metrics
| Metric | Definition | PRD target |
|---|---|---|
| **WAVL** (North Star) | Distinct learners per ISO week (local time) with ≥1 `voice_session_completed` where `qualifies_for_wavl` (≥30 s, learning preset). "Learner-weeks" = the sum over weeks | +25% relative |
| **Card-level start rate** | Of cards shown (distinct `suggestion_shown.suggestion_id`), the share with a `voice_session_started` from that card (`entry_point = suggestion_card`) | ≥15% |
| **Eligible-user start rate** (primary A/B) | Users with ≥1 `suggestion_eligible` in the window who start ≥1 voice session (any entry point) after their first eligibility, before `to`. By arm | ↑ |
| Card tap rate | Cards tapped ÷ cards shown (treatment). Feeds the "taps ↑" iterate rule | — |
| **Sessions per user per week** | `voice_session_started` count ÷ learner-weeks with ≥1 session, by arm | +20% relative |
| **D7 voice retention** (primary) | Users whose **first-ever** voice session is in the window and ≥8 days ago, who start another session on local days 1–7 after it. By arm | +5 pp |
| D30 retention (proxy) | Users whose day 30–36 return window closed inside the report window (first activity + 37 days in `[from, to)`), active again (chat message or voice session) on local days 30–36. The PRD uses the existing app-level pipeline; this is a stand-in | No drop |
| **Opt-out rate** (guardrail) | Users shown a card in the window who later sent `suggestions_opted_out` (card or Settings) ÷ users shown a card | ≤5% |
| **Text satisfaction** (guardrail) | Thumbs-down rate (each user's latest vote per answer) on answers that showed a card, vs control answers that were eligible for one (`suggestions.status = eligible_control`). Two-proportion test | No significant rise |
| **Cost per WAVL** | SVS Groq spend (classifier, opening, coach, summary, speech-to-text) ÷ WAVL learner-weeks. Tokens × list price per model. Speech-to-text = billed seconds (at least 10 s per call) × hourly price. Chat is the existing product and reported separately | Within budget (not set yet) |

## Card funnel (dashboard)
Unit: one eligible suggestion (`suggestion_eligible`), sliced by arm, intent and language. Control stops at "eligible" (shadow impressions).

`eligible → shown → tapped → mic allowed (mic_permission_granted from the card) → started (from the card) → completed ≥30 s → returned within 7 days (another session on local days 1–7)`

## Groq health (dashboard + alerts)
Per use case: calls, error / 429 / 5xx / timeout / fallback rates, p50 and p95 latency, p95 time to first token (chat, coach), and tokens. Per model: peak tokens per minute in the window, and requests today (UTC) against the org limits in `analytics.groqLimits`. Speech-to-text models have no token limit.

## Event tagging (P6.1)
Every client event is checked against the catalogue in [packages/shared/src/event-catalogue.ts](../../packages/shared/src/event-catalogue.ts): known props only, each typed, required props present. The server then sets `intent_type` and `language` from the record the event refers to, and the user can't override them:

| Reference prop | Tags from |
|---|---|
| `suggestion_id` | the suggestion's classified intent and query language |
| `voice_session_id` | the session's intent and dominant language (else its opening language) |
| `message_id` | the answer's suggestion or decision row, else the language of the question it answered |

`arm` and `experiment_id` always come from the server's assignment. A reference to a record that doesn't exist, or belongs to another user, is rejected.

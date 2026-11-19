# Runbook: Groq outage or rate limiting

**Signals:** alerts `groq_server_errors`, `groq_rate_limited`, `groq_latency_p95`, `groq_fallback`, or `groq_headroom` (close to the org's per-model limits); Groq's status page; learners report missing answers.

## What already happens automatically
| Use case | On failure |
|---|---|
| chat | One retry within the time budget, then the fallback model; if both fail, the learner sees an error with **Retry**. Chat depends on Groq, so this is a chat incident too |
| classifier | Fallback model, then **no card** (fails closed). Chat is unaffected (chaos tests: 429 storm, 5xx, timeouts) |
| opening line | Static template (no LLM needed), so sessions still start |
| coach | Fallback model, then "Sorry, can you say that again?"; after 3 failures in a row the session ends with `error` |
| summary | Fallback model, then a summary without a tip |

## 1. Triage (5 minutes)
- Dashboard → Groq health: which use cases and models? Is it 429 (our limits) or 5xx/timeouts (Groq)?
- `groq_headroom` firing means **we** are at the org limit (tokens/min, requests/day). Go to step 3.

## 2. Groq is failing (5xx / timeouts)
- If one model is affected: swap that use case to its fallback as primary (see the [model swap runbook](groq-model-swap.md)).
- If everything is affected: **turn suggestions off** (`npm run ops:config -- disable --reason "Groq outage"`). That cuts classifier, coach and summary load, and voice can't work without Groq anyway. Chat keeps trying.

## 3. We are rate limited (429 / headroom)
- Cut SVS load first: `npm run ops:config -- rollout <lower> --reason "429s"`. Classifier calls scale with rollout; chat doesn't.
- Raise the org tier with Groq (the [capacity plan](../phase7/capacity-plan.md) has the numbers). Then update `analytics.groqLimits` so the headroom alert matches the new limits.

## 4. Recover
Re-enable step by step (rollout 10 → 50 → 100) while watching the error rate and p95.

## Drill
`FAKE_GROQ_MODE=429 npx tsx scripts/fake-groq.ts 8790`, then start the API with `GROQ_BASE_URL=http://127.0.0.1:8790`. Chat shows an error with Retry, cards never appear, and the dashboard's 429 column fills. Repeat with `5xx` and `classifier-down` (chat works, no cards).

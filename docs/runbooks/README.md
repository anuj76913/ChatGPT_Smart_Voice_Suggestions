# Runbooks: Smart Voice Suggestions

> On-call procedures for the MVP (implementation-plan P7.7). Each one says what triggers it, what to do first, how to check that it worked, and how to practise it.

| Runbook | Use when |
|---|---|
| [Kill switch](kill-switch.md) | Turn suggestions off (everywhere, or for one region / language / cohort) without a release |
| [Groq model swap or deprecation](groq-model-swap.md) | A Groq model is deprecated, degraded, or replaced |
| [Groq outage](groq-outage.md) | `groq_server_errors` / `groq_rate_limited` / `groq_latency_p95` alerts, or Groq's status page shows an incident |
| [Speech outage](speech-outage.md) | Whisper (speech-to-text) fails or is slow; voice sessions break while chat works |
| [Opt-out spike](opt-out-spike.md) | `opt_out_rate` alert (guardrail ≤ 5%) |
| [Ramp a rollout step](ramp.md) | Phase 10: stepping 10% → 50% → 100% with guardrail, cost and capacity checks; enabling card languages |

## Tools every runbook uses
- **`npm run ops:config -- <command> --reason "…"`** changes runtime config straight in the database. It validates the change, writes an audit row, and works even if the API is down. All servers apply it within `CONFIG_RELOAD_MS` (15 s). `show` prints the current state; `audit` prints recent changes. Pass `--dry-run` to preview a change.
- **Admin API** (needs an `ADMIN_USERS` handle): `GET /v1/admin/config`, `PUT /v1/admin/config/overrides`, `GET /v1/admin/analytics/report`, `POST /v1/admin/analytics/alerts/evaluate`.
- **Dashboard:** `/#/admin/analytics` shows the alerts, Groq health and the funnel.
- **Drills without real outages:** run `FAKE_GROQ_MODE=<429|5xx|slow|stt-down|classifier-down> npx tsx scripts/fake-groq.ts 8790`, then start the API with `GROQ_BASE_URL=http://127.0.0.1:8790`.

## Ground rules
- **Chat must keep working.** Every failure in the suggestion path fails closed (no card); the chaos tests in `apps/server/test/hardening.test.ts` prove it. If chat itself is down, that's an incident in the existing chat product first.
- **Always pass `--reason`.** The audit log is how we reconstruct what happened.
- During the A/B test, a kill-switch use is a **guardrail event**: note it in the experiment log, because it affects the analysis window.

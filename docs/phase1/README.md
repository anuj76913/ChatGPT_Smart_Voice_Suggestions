# Phase 1 Status: Foundation (chat, Groq gateway, data, config, events)

> Tracks implementation-plan.md Phase 1 (W2–W3).
> **Status:** ✅ done and verified · 🟡 done with a known gap · ⬜ not started.

## Tasks
| Task | Status | Where | Verified by |
|---|---|---|---|
| **P1.1** S13 LLM Gateway (Groq) | ✅ | `apps/server/src/llm/` | 17 gateway tests against the fake Groq server, plus live Groq runs. Covers: retries on 429/5xx that honour retry-after within the budget; fallback before the first token, none after; timeouts and stalled streams; abort; strict JSON schema; `include_reasoning:false`; per-use-case concurrency; token metering to `llm_usage`; key never in errors or logs |
| **P1.2** Fake Groq server | ✅ | `apps/server/test/fake-groq.ts`, `npm run dev:fake-groq` | Simulates 429 + retry-after, 5xx, hangs, invalid JSON, slow first token, broken streams, reasoning chunks |
| **P1.3** S2 Chat Service | ✅ | `apps/server/src/chat/` | Streams `openai/gpt-oss-120b` (fallback `-20b`) at low reasoning effort; stores conversations and messages; reasoning is never shown or stored; prompt `chat-v3` |
| **P1.4** S1 BFF | 🟡 | `apps/server/src/app.ts`, `auth.ts`, `chat/routes.ts` | Dev login with a signed httpOnly cookie (ADR-010), per-user rate limits, SSE protocol, `client_msg_id` idempotency (replay / in-progress / regenerate). **Gap:** the rate limiter is in-memory, so it's single-instance only |
| **P1.5** DB schema + migrations | ✅ | `apps/server/migrations/001_init.sql`, `npm run db:migrate` | Every §8 entity plus `svs_config`, `svs_config_audit`, `events`, `llm_usage`. **No audio column.** Migrations run on start locally |
| **P1.6** S7 Config & Kill Switch | ✅ | `apps/server/src/config/` | zod validation after merge (rejects threshold 0, rollout >100%, empty rules, unknown keys); reload every 15s; audit log; kill switch by region/language/cohort; order fresh → enabled/dogfood → kill switch → rollout; stale config >5 min fails closed |
| **P1.7** S12 Events + C7 Logger | ✅ | `apps/server/src/events/`, `apps/web/src/lib/events.ts` | Validates each event separately; rejects content keys, long or multi-line strings, and server-only events; the server sets user/arm/cohort; idempotent on `event_id`; client batches, retries and flushes on page hide |
| **P1.8** C1 Chat UI | ✅ | `apps/web/src/components/` | Login, conversation list (sidebar on desktop, drawer on mobile), streamed Markdown answers, Stop, Retry (same `client_msg_id`), 👍/👎 → `answer_feedback`, empty `.suggestion-slot` under each answer for Phase 3 |
| **P1.9** C8 Config Cache | ✅ | `apps/web/src/lib/client-config.ts`, `GET /v1/config/client` | 60s TTL in memory and localStorage; not authoritative for anything server-side |
| **P1.10** TTFT baseline | ✅ | [ttft-baseline.md](ttft-baseline.md), `npm run bench:ttft` | Real Groq, 10 prompts: **TTFT p50 435 ms / p90 911 ms**, total p50 1.4s |

## Exit criteria
| Criterion | Status |
|---|---|
| Chat streams answers end-to-end **in staging** on Groq | 🟡 Verified **locally** end-to-end on real Groq (server + Vite proxy + browser client). **Staging doesn't exist yet: hosting (ADR-009) is undecided** |
| Gateway tests pass against the fake server | ✅ |
| Config change applies within ≤1 min, with an audit entry | ✅ Same instance: at once. Other instances: next reload (15s). Tested |
| Test event reaches the analytics store with the full envelope | ✅ Integration test + live check (`events` table) |
| TTFT baseline recorded | ✅ [ttft-baseline.md](ttft-baseline.md) |

## Findings during Phase 1
1. **Reply language bug (fixed).** Prompt v1 answered an English question ("What is a deadlock…?") in Hindi, and v2 still answered romanized Hinglish in Devanagari. v3 adds a **server-side script detector**: it checks the script of the latest message and adds a one-line instruction. Live check: 5/5 replies now match the learner's script (English, 3× Hinglish, Hindi). There are unit tests for the detector.
2. **Groq usage in streams** arrives in the final chunk (`x_groq.usage`). Live runs recorded token counts for 100% of completed calls.
3. **Message ordering:** a user message and its reply placeholder are created in the same transaction, so they share `created_at`. Ordering now uses a `seq` identity column.
4. **Key hygiene:** a new Groq key was found in `.env.example` (a committed template). It was moved to `.env` and the template was reset. Keys belong only in `.env`.

## How to run
```bash
npm run db:local:start        # if the machine rebooted
npm run dev                   # server :8787 + web :5173 → http://localhost:5173
```
No key, or want zero token spend? Run `npm run dev:fake-groq` and set `GROQ_BASE_URL=http://127.0.0.1:8790` in `.env`.

### Runtime config (admin)
Sign in as a handle listed in `ADMIN_USERS` (local default: `admin`), then:
```bash
# view effective config, overrides, audit log and how the gate treats you
curl -b "svs_session=<cookie>" http://127.0.0.1:8787/v1/admin/config
# replace overrides (validated; audited; applies at once)
curl -X PUT -b "svs_session=<cookie>" -H 'content-type: application/json' \
  -d '{"overrides":{"killSwitch":[{"language":"hinglish"}]},"reason":"kill switch drill"}' \
  http://127.0.0.1:8787/v1/admin/config/overrides
```

## API added in Phase 1
| Method & path | Purpose |
|---|---|
| `POST /v1/auth/dev-login` · `POST /v1/auth/logout` · `GET /v1/me` | Dev auth (ADR-010) |
| `POST /v1/conversations` · `GET /v1/conversations` · `GET /v1/conversations/:id/messages` | Conversations |
| `POST /v1/conversations/:id/messages` | SSE: `message.accepted` → `answer.delta`* → `answer.complete` \| `answer.error` → `stream.end` (`suggestion` reserved for Phase 3) |
| `POST /v1/events` | Batched client events |
| `GET /v1/config/client` | Client-safe config |
| `GET /v1/admin/config` · `PUT /v1/admin/config/overrides` | Runtime config (admins) |
| `GET /healthz` · `GET /readyz` | Liveness / readiness (database, Groq key, config freshness) |

## Tests
- `npm test` → 64 tests:
  - shared config: 6
  - server units: 29
  - gateway: 17
  - integration against PostgreSQL + fake Groq: 12. These are auto-skipped if `TEST_DATABASE_URL` isn't set; CI runs them with a Postgres service.

## Carried into later phases
- Hosting (ADR-009): needed to meet the "staging" exit criterion and before Phase 7.
- Shared rate limiting (Postgres or Redis) before running more than one server instance.
- Real authentication to replace dev login before any public traffic (ADR-010).

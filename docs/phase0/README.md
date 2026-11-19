# Phase 0 Status: Decisions, Setup and Long-Lead Work

> Tracks the tasks for implementation-plan.md Phase 0 (W1).
> **Status:** ✅ done in the repo · 🟡 started, needs a person to finish · ⬜ not started.

| Task | Status | What was done | What's left (owner) |
|---|---|---|---|
| **P0.1** Tech stack | ✅ | Responsive website (React + Vite + TS), Node.js + TS (Fastify), PostgreSQL: [decisions.md](../decisions.md) ADR-001–003 | Hosting (ADR-009) and auth (ADR-010) are still open; needed in Phase 1 |
| **P0.2** Speech approach | ✅ | Groq Whisper STT + browser TTS: ADR-005, with the turn-taking design and risks | Verify `hi-IN` voice availability on the target Android devices (Phase 4 spike) |
| **P0.3** Classifier approach | ✅ | Rules prefilter + Groq `openai/gpt-oss-20b`: ADR-006 | — |
| **P0.4** Proposed constants | 🟡 | All adopted as **defaults** in ADR-008 and in `packages/shared/src/config.ts` | Product to confirm or change each one before the listed phase. **Content moderation (edge-case Q4) is still open** |
| **P0.5** Groq setup | 🟡 | Dev key in `.env`; `npm run groq:check` passes. The Llama models weren't available to the key (Enterprise-tier), so every use case moved to `openai/gpt-oss-120b` / `-20b` (ADR-004 update). Strict-JSON classifier smoke test passed | **Rotate the dev key** (it was shared in chat); create staging/prod keys; record rate limits ([groq-setup.md](groq-setup.md)) (**you**) |
| **P0.6** Legal / T&S kickoff | 🟡 | Review packet with data flows, Groq questions, draft privacy and mic copy (en + hi), DPDP and safety questions: [legal-review.md](legal-review.md) | Send to Legal / T&S; target sign-off before W11 (**you → Legal**) |
| **P0.7** Labelled dataset kickoff | 🟡 | Guidelines ([labelling-guidelines.md](labelling-guidelines.md)); **200 synthetic seed rows** (`data/intent-eval/seed.jsonl`); validator + agreement (kappa) tools; CI validation | Human labellers: review the seed, calibrate (kappa ≥0.80), grow to ≥1,000 real rows by end of W4 (**labellers**) |
| **P0.8** Repo, CI, environments, secrets | ✅ | npm-workspaces monorepo (`apps/web`, `apps/server`, `packages/shared`, `scripts`); CI workflow; `.env.example`; git-ignored secrets; `/healthz` + `/readyz`; tests pass | Push to GitHub and add branch protection + CODEOWNERS (needs the team's GitHub usernames) (**you**). Local DB done: `npm run db:local:init` created a project-only PostgreSQL on 127.0.0.1:5433 (no system password needed) |
| **P0.9** Design | 🟡 | Spec for every P0 screen (mobile + desktop), states, copy, accessibility: [design-spec.md](design-spec.md); tokens in `apps/web/src/styles.css` | Visual design + sign-off table in the spec (**design, product**) |

## Exit criteria (from the implementation plan)
| Criterion | Status |
|---|---|
| Stack and speech provider decided and written into architecture.md | ✅ |
| Groq keys work from staging; model IDs verified | 🟡 needs keys; run `npm run groq:check`. Staging needs hosting (ADR-009) |
| Labelling on pace for ≥1,000 labels by end of W4 | 🟡 seed + tooling ready; human labelling not started |
| Legal / T&S review formally started, target before W11 | 🟡 packet ready to send |

## Verified in this repo (2026-11-16)
- `npm run typecheck`: passes (shared, server, web, scripts).
- `npm test`: 10 tests pass (6 config-vs-PRD checks, 4 health/readiness checks).
- `npm run build`: server bundle (tsup) and web build (Vite) succeed.
- `npm run dataset:validate`: 200 rows, schema valid, no duplicates.
- `npm audit`: 0 vulnerabilities.
- The built server serves `/healthz` → 200 and `/readyz` → 503 `not_configured` until `.env` has `DATABASE_URL` and `GROQ_API_KEY`.
- PostgreSQL 18 on localhost:5432 is accepting connections.

## Local environment: done (2026-11-16)
- `npm run db:check` → connected to `svs_dev` (PostgreSQL 18.4, project-local cluster on port 5433).
- `npm run groq:check` → key accepted, all configured models available, strict-JSON smoke test passed.
- `/readyz` → 200 `ready` (database ok, groq ok).

After a reboot: `npm run db:local:start`, then `npm run dev` (server :8787 + web :5173 → open http://localhost:5173).

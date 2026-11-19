# Smart Voice Suggestions MVP

Context-aware voice practice for Bharat Learners. When a learner types a study task where speaking beats typing (mock interview, spoken English, viva revision, pronunciation), the chat offers a one-tap voice practice session below the normal text answer.

- Product context: [docs/context.md](docs/context.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Plan: [docs/implementation-plan.md](docs/implementation-plan.md)
- Edge cases: [docs/edge-case.md](docs/edge-case.md)
- Decisions: [docs/decisions.md](docs/decisions.md)
- Phase 0 status: [docs/phase0/README.md](docs/phase0/README.md)

## Team demo
```
npm run db:local:start      # (first time: npm run db:local:init)
npm run demo:setup          # turn on every feature for the demo
npm run demo                # or: npm run demo:offline (no Groq key / limits)
```
Open http://localhost:5173 in Chrome and follow **[docs/DEMO.md](docs/DEMO.md)**. Sign in as `admin` for the analytics dashboard.

## Stack
| Layer | Choice |
|---|---|
| Client | Responsive website, React + Vite + TypeScript (`apps/web`) |
| Server | Node.js + TypeScript, Fastify (`apps/server`) |
| Database | PostgreSQL |
| LLM | Groq (chat, intent classifier, coach, summary) |
| Speech | Groq Whisper (speech-to-text) + browser speech synthesis (text-to-speech) |

## Repository layout
```
apps/web          React client: chat, suggestion card, voice session, summary (C1–C8)
apps/server       Fastify server: gateway, Groq client, decision engine, voice orchestrator (S1–S13)
packages/shared   Shared types and config defaults (intents, presets, constants, event names)
scripts/          groq-check, db-check, dataset validate / agreement
data/intent-eval  Labelled classifier dataset (JSONL)
docs/             Product, architecture, plan, edge cases, decisions, phase outputs
```

## Getting started
Requirements: Node.js ≥22, PostgreSQL (running locally), a Groq API key.

```bash
npm install
cp .env.example .env            # fill in GROQ_API_KEY
npm run db:local:init           # project-only PostgreSQL on 127.0.0.1:5433; writes DATABASE_URL into .env
npm run db:check
npm run groq:check
npm run dev                     # server http://127.0.0.1:8787, web http://localhost:5173
```
After a reboot, start the database again with `npm run db:local:start` (`db:local:stop` / `db:local:status` also exist). It uses the PostgreSQL binaries already installed (override the folder with `PG_BIN`) and never touches the system PostgreSQL service or its password.

## Scripts
| Command | What it does |
|---|---|
| `npm run dev` | Run server and web together (watch mode) |
| `npm run typecheck` | Type-check every workspace and the scripts |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Bundle the server (tsup) and build the web app (Vite) |
| `npm run groq:check` | Verify the Groq key, every configured model, and a strict-JSON classifier call |
| `npm run db:check` | Verify the PostgreSQL connection |
| `npm run dataset:validate` | Validate the labelled intent dataset (`-- --gate` checks the Phase 2 targets) |
| `npm run dataset:agreement -- a.jsonl b.jsonl` | Inter-labeller agreement (Cohen's kappa) |
| `npm run db:migrate` | Apply pending SQL migrations (also runs automatically on server start locally) |
| `npm run db:local:init` / `start` / `stop` / `status` | Project-only PostgreSQL (dev + test databases) |
| `npm run dev:fake-groq` | Fake Groq on :8790 for UI work without a key (set `GROQ_BASE_URL`) |
| `npm run bench:ttft` | Measure text time-to-first-token against a running server (P1.10) |
| `npm run eval:classifier` | Live classifier eval on Groq: both models, resumable (`--write-thresholds`, `--report-only`, `--limit N`) |
| `npm run eval:check` | Offline CI gate: precision ≥85%, no ambiguous cards, predictions not stale |
| `npm run smoke:voice -- a.wav b.wav` | Live voice session against a running server: STT and coach latency per turn |

Status by phase: [Phase 0](docs/phase0/README.md) · [Phase 1](docs/phase1/README.md) · [Phase 2](docs/phase2/README.md) · [Phase 3](docs/phase3/README.md) · [Phase 4](docs/phase4/README.md) · [Phase 5](docs/phase5/README.md) · [Phase 6](docs/phase6/README.md) · [Phase 7](docs/phase7/README.md) · [Phase 8](docs/phase8/README.md) · Phase 9 skipped (no A/B) · [Phase 10](docs/phase10/README.md) · [Phase 11](docs/phase11/README.md) · [Runbooks](docs/runbooks/README.md)

## Rules worth knowing
- Secrets only in `.env` (git-ignored) or the platform secret store. The Groq key is used only by the server.
- Config defaults live in `packages/shared/src/config.ts` and mirror architecture §10. Don't hard-code caps, thresholds, timeouts or model IDs elsewhere.
- Analytics events never contain query text, transcripts or audio.

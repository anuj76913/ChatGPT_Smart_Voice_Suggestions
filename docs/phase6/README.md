# Phase 6 Status: Analytics, Experiment and Dashboards

> Tracks implementation-plan.md Phase 6. The goal: everything needed to measure the PRD metrics and run the A/B test credibly.
> **Status:** ✅ done and verified · 🟡 done, with a known gap · ⬜ not started.

## Tasks
| Task | Status | Where | Verified by |
|---|---|---|---|
| **P6.1** Event catalogue + schema tests | ✅ | `packages/shared/src/event-catalogue.ts`, `apps/server/src/events/context.ts` | Every event has a spec: who emits it, typed props (ids / enums / ints / booleans only), and whether intent and language are required. Client events with unknown, missing or mistyped props are rejected. **The server sets `intent_type` and `language` from the referenced suggestion, voice session or message**, ignoring client values, and rejects references to other users' records. New event `mic_permission_granted` (funnel step "mic allowed"). Tests: catalogue ⇔ event list ⇔ server-emitted list, no content keys, spoofed tags overwritten, foreign references rejected, and an **end-to-end card → voice flow where every PRD event carries intent, language and arm** |
| **P6.2** Metric definitions as versioned queries | ✅ | `apps/server/src/analytics/queries.ts` (`metrics-v1`), [metrics.md](metrics.md) | WAVL, both start-rate views, tap rate, sessions per user per week, D7, D30 (proxy), opt-out, thumbs-down vs control-eligible, cost per WAVL (Groq list prices in config, at least 10 s billed per Whisper call). **Exact values asserted on a hand-built fixture** (funnel, rates, cost to 12 decimals, SRM counts) |
| **P6.3** Funnel dashboard | ✅ | `apps/web/src/components/AnalyticsDashboard.tsx` at `/#/admin/analytics`; `GET /v1/admin/analytics/report` | Admin-only (403 otherwise). Shows the PRD decision with every check, headline tiles, the funnel (eligible → shown → tapped → mic allowed → started → completed ≥30 s → returned within 7 days) filtered by arm / intent / language with a table view, metrics by arm, SRM, Groq health and headroom, and alerts. Rendered with headless Chrome at desktop (light and dark) and 390 px mobile with no horizontal overflow ([screenshot, synthetic data](dashboard-synthetic.png)) |
| **P6.4** Alerts | ✅ | `apps/server/src/analytics/alerts.ts`, `alert_events`, `POST /v1/admin/analytics/alerts/evaluate` | Rules: opt-out >5% (warning from 4%), thumbs-down significantly up, classifier errors, voice start p95 >2 s, cost per WAVL over budget, Groq 429 / 5xx / fallback rates, p95 latency or TTFT per use case, token and request headroom per model. All thresholds are in config, and each rule needs a minimum sample. Runs every 5 minutes (one instance at a time, advisory lock). Opens one alert per (rule, key), notifies once, resolves when the rule clears. Optional `ALERT_WEBHOOK_URL` (Slack-compatible, no user ids). Tested: fire → dedupe → resolve → webhook |
| **P6.5** Experiment validation | 🟡 | `npm run analytics:aa`, SRM in every report | Synthetic A/A over 200k ids: 50.04% split (SRM p = 0.72), 10% holdout split fine, assignment stable, experiments independent (p = 0.67), **A/A false-positive rate 5.25%** over 2,000 simulations, SRM false alarms 4 / 2,000. The report checks SRM on assignments, eligible users and eligible events, so eligibility is symmetric across arms. **Gap:** no A/A on real staging traffic yet (there's no staging environment, ADR-009) |
| **P6.6** Power calculation | ✅ | `npm run analytics:power`, [power.md](power.md) | 10% → 12% needs 3,841 per arm (unit-tested). Tables for start rate (+2 pp) and D7 (+5 pp), and how to size the rollout once the pre-period gives baselines. **The control arm's D7 sample is the likely constraint** |
| **P6.7** Analysis notebook | ✅ | `apps/server/src/analytics/decision.ts`, `npm run analytics:report` | The PRD rules as code: invalid (SRM) → kill (opt-out >5% or thumbs-down up) → ship (start ↑ and D7 ↑) → iterate (start ↑, D7 flat) → inconclusive. Also reports the ramp targets (card start ≥15%, D7 +5 pp, WAVL +25%). Outputs markdown. Unit-tested for each outcome, and the four synthetic scenarios give the expected decision ([example](analysis-synthetic.md)) |

## Synthetic "staging" data
`npm run analytics:seed -- --scenario ship|iterate|kill|aa` writes 4,000 synthetic users with chats, suggestions, sessions, events and Groq usage into a separate **`svs_analytics`** database. The dev database is never touched (the script refuses `svs_dev` / `svs_test`). It is deterministic per seed.

| Scenario | Decision from `npm run analytics:report` |
|---|---|
| ship | **SHIP**: start +38.5 pp (p < 0.0001), D7 +24.4 pp (p = 0.036), opt-out 2.1% |
| iterate | **ITERATE**: start +39.4 pp, D7 +12.4 pp but not significant (p = 0.22) |
| kill | **KILL**: opt-out 7.6% |
| aa | **INCONCLUSIVE**: start +0.4 pp (p = 0.60) |

The live API answered on that data in **~1.1 s**, and the alert run fired `voice_start_p95` (2,020 ms; the seed adds a slow tail on purpose).

## Exit criteria
| Criterion | Status |
|---|---|
| Every metric computes from staging test data | ✅ on synthetic data (fixture with exact values plus a 4,000-user seed). 🟡 no real staging environment yet |
| A/A / SRM check passes | ✅ synthetic A/A (`analytics:aa`); SRM is part of every report |
| Alerts fire in a test | ✅ integration test (fire, dedupe, resolve, webhook) plus a live run |
| Power calculation documented | ✅ [power.md](power.md) |

## How to use it
1. `npm run db:migrate` (applies `005_analytics`).
2. Dashboard: sign in with a handle listed in `ADMIN_USERS`, then open **Analytics** in the sidebar (or `/#/admin/analytics`).
3. Try it on synthetic data:
   - `npm run analytics:seed`
   - start the API on that database: `DATABASE_URL=<…>/svs_analytics npm run dev:server`
   - `npm run analytics:report -- --out report.md` writes the PRD decision as markdown.
4. Before the A/B test: run `npm run analytics:aa` and `npm run analytics:power -- --baselines <pre-period> --eligible-per-week <n>`.

## Known gaps / next
- **No staging environment** (hosting is still open, ADR-009), so nothing has run on real traffic. Phase 8's pre-period is the first real check.
- **D30 is a proxy** (chat or voice activity on local days 30–36). The PRD uses the existing app-level pipeline.
- **Report queries are written for clarity, not scale.** They use correlated `EXISTS` over `events`, taking ~1.1 s for 4k users and ~12k events. Before the A/B test, move them to the analytics warehouse or materialize daily rollups (Phase 7 performance pass).
- **The cost budget per WAVL isn't set** (`analytics.costBudgetPerWavlUsd = null`); the alert reports "not configured". Set it in the Phase 7 capacity plan.
- **The age filter (18–24) can't be applied:** age isn't collected. Region and tier exist on `users` but aren't used yet, because all current users are India.
- Alerts go to logs, the `alert_events` table, the dashboard and an optional webhook. There's no paging integration.

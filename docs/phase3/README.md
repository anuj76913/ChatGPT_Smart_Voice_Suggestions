# Phase 3 Status: Suggestion Engine, Card and User Controls

> Tracks implementation-plan.md Phase 3 (W4–W5). FR-2, FR-4, FR-5 and the kill-switch NFR.
> **Status:** ✅ done and verified · 🟡 done, with a known gap · ⬜ not started.

## Tasks
| Task | Status | Where | Verified by |
|---|---|---|---|
| **P3.1** S5 Prefs & Counters | ✅ | `voice_prefs` + `suggestions` tables, `apps/server/src/suggestions/` | Impressions are counted from `suggestions` rows (`shown/tapped/dismissed/opted_out/ignored/eligible_control`; `late` never counts). Caps are re-checked under a **per-user Postgres advisory lock**, and a test with two tabs racing for the last weekly slot gets exactly one card |
| **P3.2** S6 Experiment Assignment | ✅ | `suggestions/experiment.ts` | Deterministic hash of (experiment, user) → arm; the first assignment is persisted and never moves (tested: changing the split doesn't change an existing user). Dogfood cohorts always get treatment and are outside the experiment (no assignment row) |
| **P3.3** S4 Decision Engine | ✅ | `suggestions/engine.ts` | The §6.2 pipeline, cheapest check first: gate (fresh config → enabled/dogfood → kill switch → rollout) → opt-out → pause → conversation cap → organic-voice-in-conversation → weekly cap → arm → classify → threshold → copy. Every decision writes a reason-code row to `suggestion_decisions`. `suggestion_id = sg_<assistant message id>` (idempotent) |
| **P3.4** BFF wiring | ✅ | `chat/routes.ts` `deliverSuggestion()` | The decision runs **in parallel** with the answer. The card is sent only after `answer.complete` and within 500 ms; later → dropped and stored as `late` (not counted). Failed or stopped answer → no card, no impression. Kill switch re-checked just before sending (DE-21) |
| **P3.5** S11 Copy catalog | ✅ | `packages/shared/src/copy.ts` | Per-intent titles, why-line, "Try Voice Practice", dismiss/opt-out labels, headphone hint (design-spec §8). The server sends the copy; English fallback (UI-12) |
| **P3.6** C2 Suggestion Card | ✅ | `apps/web/src/components/SuggestionCard.tsx` | Renders only under a completed answer. `suggestion_shown` fires once at ≥50% visible for ≥1 s (UI-04). Dismiss has a 4 s undo (counts only when the window ends, or on leaving). Polite screen-reader announcement; 48px targets; reading order title → why → hint → CTA → dismiss → opt-out. Cards reappear when a conversation is reopened, and dismissed ones stay hidden (UI-07) |
| **P3.7** Actions + APIs | ✅ | `suggestions/routes.ts` | `POST /v1/suggestions/:id/dismiss` (counts once per card; 3 in a row → 14-day pause, counter reset), `POST …/tap` (resets the counter), `GET/PUT /v1/me/voice-preferences` (opt-out takes effect at once and marks the card; opt-in clears an active pause). Ownership enforced (404 for other users' cards) |
| **P3.8** C6 Settings | ✅ | `apps/web/src/components/Settings.tsx` | Suggestions switch (`role=switch`), voice speed, voice; logs `suggestions_opted_in/out` and `voice_setting_changed`. The card's opt-out shows a toast linking to Settings |
| **P3.9** Tests | ✅ | `apps/server/test/suggestions.test.ts` (18 tests) + live run | Every decision branch, the rolling-window boundary (an impression exactly 7×24h old frees a slot), tab race, pause, tap reset, dismiss idempotency, ownership, opt-out/in, control vs treatment, dogfood, kill switch (incl. mid-stream), classifier outage, answer failure, late decision, and **first token not delayed** by a slow classifier |

## Exit criteria
| Criterion | Status |
|---|---|
| FR-2, FR-4, FR-5 acceptance criteria pass | ✅ Integration tests (above) + a live Groq run: a real Hinglish interview request got the card after `answer.complete` |
| Kill switch by region/language/cohort hides cards within ≤1 min, no release | ✅ Same instance: immediately. Other instances: next 15 s reload. Also re-checked just before sending |
| TTFT unchanged vs baseline (no significant difference) | ✅ See below: **p ≈ 0.43** |
| Control users never see a card but generate `suggestion_eligible` | ✅ Tested: control gets `eligible_control` (counts toward caps) and a server-emitted `suggestion_eligible` with `arm=control` |
| End-to-end card **in staging** for treatment users | 🟡 Verified **locally** on real Groq; staging still waits on hosting (ADR-009) |

## TTFT with the suggestion path on (P3.9 perf test)
Real Groq, 10 prompts each; the suggestion path ran on every message (dogfood cohort). Reports: [ttft-svs-on.md](ttft-svs-on.md) vs [Phase 1 baseline](../phase1/ttft-baseline.md).

| | p50 | p90 | max |
|---|---|---|---|
| Baseline (Phase 1, SVS off) | 435 ms | 911 ms | 1022 ms |
| SVS on (Phase 3) | 498 ms | 596 ms | 823 ms |

Mann-Whitney U on the 10 + 10 client TTFTs: **z = −0.79, p ≈ 0.43**, so no significant difference. The median moved +70 ms, within free-tier noise at n = 10. Re-run with larger samples on the paid tier before Phase 8 (P7.1).

What the suggestion path did during that run (from `suggestion_decisions`): 6/10 prompts rejected by the prefilter in ~10 ms; 4/10 classified by Groq in 0.56–1.7 s, in parallel with the answer, all correctly judged "advice, not practice" (no card). The extra live request "Mera kal TCS ka interview hai, mock interview le lo please" → `mock_interview` 0.97 → card shown.

## How to see it locally
Suggestions ship **disabled** by default. To show cards to local dev users (already applied to the local dev database during this phase):
```bash
# sign in as admin (ADMIN_USERS), then:
curl -X PUT -b "svs_session=<admin cookie>" -H 'content-type: application/json' \
  -d '{"overrides":{"dogfoodCohorts":["local"]},"reason":"local dogfood"}' http://127.0.0.1:8787/v1/admin/config/overrides
```
Then `npm run dev`, sign in with any handle, and ask e.g. *"Take my mock interview for a TCS fresher role"*. Turn it off with `{"overrides":{}}`. For an A/B-style setup instead: `{"enabled":true,"rolloutPercent":100}` (50/50 arms).

Reason codes per message (no text):
```sql
SELECT outcome, count(*) FROM suggestion_decisions GROUP BY 1 ORDER BY 2 DESC;
```

## Known gaps / carried forward
- **"Try Voice Practice" records the tap but doesn't open a session yet.** The card says voice practice is coming soon. The voice session is Phase 4.
- **The UI wasn't checked in a real browser or with a screen reader** in this phase (typecheck, build and server tests only). Do a manual pass, and the full TalkBack/VoiceOver audit is P7.2.
- **Refusal detection (DE-18) isn't implemented.** A card can appear under a safety refusal if the classifier says "practice". Low likelihood; revisit with moderation (edge-case Q4).
- The daily voice-minute budget (edge-case Q5) is deferred to Phase 7.
- Rate limiting is still in-memory (single instance).

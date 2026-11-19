# Phase 7 Status: Hardening and Launch Readiness

> Tracks implementation-plan.md Phase 7 (W9–W10): meet every non-functional requirement and pass the gates needed to start dogfood.
> **Status:** ✅ done and verified · 🟡 done, with a known gap · ⛔ blocked (outside engineering) · ⬜ not started.

## Tasks
| Task | Status | Evidence |
|---|---|---|
| **P7.1** Performance | 🟡 | **Decision pre-checks:** p95 **1.7 ms** single, **5.1 ms** at 25 concurrent (budget ≤ 20 ms) on the 4,000-user synthetic database, through every check to the arm (`npm run bench:decision`). **TTFT with SVS on vs off:** no significant difference (Phase 3: p50 498 vs 435 ms, Mann-Whitney p ≈ 0.43); the chat path hasn't changed since. **Turn latency:** first coach sentence 0.62–1.37 s live (Phases 4–5). Web bundle ≈ 117 KB gzipped. **Gap:** voice start < 2 s p90 on a mid-range Android phone over 4G needs a device (BB-17) |
| **P7.2** Accessibility audit | 🟡 | **Browser walkthrough of 13 screens** (login → chat → card → settings → privacy → voice session → end → summary → recap → mic denied, plus dark mode, desktop and the dashboard): **0 axe WCAG 2.2 AA violations, no target under 44 px, no browser errors**, on the production build ([results](a11y-results.md)). It found and fixed the voice-session crash (BB-01) and the landmark / heading / target-size issues (BB-10). Nothing is conveyed by colour alone (icons + labels); contrast is checked by axe in light and dark. **Gap:** TalkBack / VoiceOver walkthroughs by a person |
| **P7.3** Privacy sign-off | ⛔ / ✅ | Engineering side done ([privacy.md](privacy.md)): a **canary test** proves query, answer, transcript and API key never reach logs or analytics / metering tables, and **transcript retention** is enforced (proposed 30 days; purge job, tested). **Blocked:** Legal / T&S approval of the privacy copy, Groq's data terms, and the retention period |
| **P7.4** Security review | ✅ / 🟡 | ([security.md](security.md)) Auth on every route (inventory test), session revocation on logout, Origin check, security headers + CSP, errors without internals, per-session turn limit, keys never logged (canary). **Open:** TLS / host headers (hosting undecided), real authentication before any public deployment (BB-13), reviewer sign-off |
| **P7.5** Chaos / fault injection | ✅ | Tests: Groq **429 storm** and **5xx / timeouts** on the classifier (chat answers normally, no card, no 30 s wait), **config store stale**, **prefs store down**, **event store down** (ingestion fails cleanly, voice still starts), **speech provider down** (learner told, session ends after 3 failures), plus the earlier network-drop and chat-fallback tests. Offline drills via `FAKE_GROQ_MODE` |
| **P7.6** Capacity plan | ⛔ | ([capacity-plan.md](capacity-plan.md)) **The current Groq key can't serve dogfood**: gpt-oss-120b would need 6.8× its tokens/day limit, mostly because chat shares the model. A/B scale needs ~2,000×. **Action: upgrade the Groq tier before Phase 8.** Cost: ≈ $0.0017 per voice session, ≈ $0.011 per WAVL; budget proposed at $0.05 |
| **P7.7** Runbooks | ✅ | [docs/runbooks/](../runbooks/README.md): kill switch, Groq model swap, Groq outage, speech outage, opt-out spike. New `npm run ops:config` (validated, audited, works without the API), drilled on the synthetic database: kill / unkill, invalid rollout rejected, audit trail |
| **P7.8** Bug bash | ✅ | ([bug-bash.md](bug-bash.md)) 11 fixed (1 P0, 9 P1, 1 P2), 11 open: **no open P0 code bugs**; open P0s are capacity (commercial) and auth before public deploy |

## Exit criteria
| Criterion | Status |
|---|---|
| No open P0 bugs | ✅ for code. ⛔ BB-05 Groq capacity (needs a tier upgrade); BB-13 auth before any public deployment |
| Performance sign-off | 🟡 server-side budgets met; device voice-start pending |
| Accessibility sign-off | 🟡 automated audit clean; screen-reader walkthrough pending |
| Privacy sign-off | ⛔ engineering done; Legal / T&S pending |
| Security sign-off | 🟡 checklist done; reviewer, TLS / hosting, real auth pending |
| Runbooks reviewed | 🟡 written and drilled; needs on-call review |
| Capacity confirmed for Phase 8–9 | ⛔ not confirmed: tier upgrade required |

**Phase 8 can't start until the Groq tier is upgraded and Legal signs off.** Everything else is a person-or-device check listed above.

## New tools
| Command | Purpose |
|---|---|
| `npm run bench:decision` | Pre-check latency (p95 ≤ 20 ms budget) on the synthetic database |
| `npm run audit:a11y` | Browser walkthrough with axe + target sizes + screenshots (needs the offline stack; see the script header) |
| `npm run capacity:plan -- --scenario dogfood\|ab10\|ramp100 [--measured]` | Groq load and cost vs limits |
| `npm run ops:config -- <show\|kill\|unkill\|disable\|enable\|rollout\|model\|merge\|audit>` | Runbook config changes |
| `FAKE_GROQ_MODE=429\|5xx\|slow\|stt-down\|classifier-down npx tsx scripts/fake-groq.ts` | Outage drills; with no mode it's a full offline Groq for local UI work |

## Changes worth knowing
- **Users sign in once more** after this release: session cookies now carry an epoch (migration `006_hardening`).
- The fake Groq server now supports the whole app (cards, voice, summary) offline.
- Config gained `privacy.*`, `voice.maxTurnsPerMinute` and the full Groq limits. The cost budget is set to a proposed $0.05 per WAVL.

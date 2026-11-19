# A/B Test Analysis Plan: Smart Voice Suggestions (P8.5)

> **Status: DRAFT. Not frozen.** Fill the ⟨blanks⟩ from the real baseline report (`docs/phase8/baseline-report.md`, P8.4), have the data analyst and product owner sign it, record that in `docs/phase8/gate-attestations.json` (`analysis_plan_frozen`), then **change nothing after the test starts**. Any later change is a new test.

## 1. Question and hypotheses
Does showing a context-aware voice-practice card under learning answers (treatment) increase voice use and voice habit, compared with no card (control), without hurting text chat?
- **H1 (primary):** treatment raises the **eligible-user voice start rate**.
- **H2 (primary):** treatment raises **D7 voice retention**.
- Both are needed to ship (PRD).

## 2. Design
| Item | Value |
|---|---|
| Unit | User; deterministic hash of (user id, experiment id), persisted (`experiment_assignments`) |
| Experiment id | `svs_v1` (new id: assignments from the `svs_baseline` pre-period don't carry over) |
| Split | 50 / 50 (`experiment.treatmentShare = 0.5`) |
| Rollout | ⟨10%⟩ of the target population. Increase if the baseline report's sizing needs it (see §5) |
| Population | India · Tier-2/3 · ≥ 1 eligible learning query (`suggestion_eligible` in either arm). Age 18–24 is not collected: documented limitation |
| Excluded | Dogfood cohorts (no assignment, `experiment_id` null), test accounts (`is_test`), admins |
| Duration | ⟨4⟩ weeks of enrolment + 7 days for the last D7 cohorts to mature, then analysis (W17) |
| Config | `npm run ops:config -- preset ab-test --rollout ⟨10⟩ --reason "Phase 9 start"` |
| Voice entry for control | The mic button (practice picker) is available to **both** arms; only the card differs |

## 3. Metrics (definitions: `metrics-v1`, docs/phase6/metrics.md)
| Role | Metric | Baseline (pre-period) | Minimum detectable effect |
|---|---|---|---|
| Primary | Eligible-user voice start rate | ⟨x.x%⟩ | +2 pp (PRD) |
| Primary | D7 voice retention | ⟨x.x%⟩ | +5 pp (PRD target), or ⟨larger⟩ if power requires (§5) |
| Secondary | Sessions per user per week | ⟨x.xx⟩ | +20% relative |
| Secondary | WAVL (per assigned user) | ⟨x⟩ per week | +25% relative |
| Reported | Card-level start rate (treatment only) | n/a | ≥ 15% target |
| Guardrail | Opt-out rate (users shown a card) | n/a | ≤ 5% |
| Guardrail | Thumbs-down on answers with a card vs control-eligible answers | ⟨x.x%⟩ | No significant rise (two-sided α 0.05) |
| Guardrail | Cost per WAVL | n/a | ≤ budget (`analytics.costBudgetPerWavlUsd`) |

## 4. Analysis
- Two-sided two-proportion z-tests, α = 0.05 for each primary metric. Ship requires **both**, so no multiplicity correction is applied to the ship decision. Secondary metrics are descriptive (95% CIs) and can't make the decision on their own.
- **SRM first:** chi-square on assignments and eligible users vs 50/50, alarm at p < 0.001. If it fails, the result is invalid until explained.
- Decision rules, coded in `apps/server/src/analytics/decision.ts` and run by `npm run analytics:report`:
  - **Kill:** opt-out > 5%, or thumbs-down significantly up
  - **Ship:** start rate ↑ and D7 ↑ (both significant), guardrails hold
  - **Iterate:** start rate ↑ but D7 not significant
  - otherwise **Inconclusive**
- **Segments (exploratory, not decision-making):** intent, language (English / Hinglish), new vs returning voice users.

## 5. Sample size
From the baseline report (`npm run analytics:baseline`): new eligible users per week ⟨n⟩; first-time voice users per week ⟨n⟩.
| Test | Needed per arm | Expected per arm at ⟨rollout⟩ × ⟨weeks⟩ | Power |
|---|---|---|---|
| Start rate +2 pp | ⟨n⟩ | ⟨n⟩ | ⟨≥ 80%⟩ |
| D7 +⟨5⟩ pp | ⟨n⟩ | ⟨n⟩ | ⟨≥ 80%⟩ |

If D7 can't reach 80% power within an acceptable rollout and duration, say so here **before** starting, and choose either a larger minimum detectable effect or a longer test. Don't extend after peeking.

## 6. Monitoring and stopping
- **Daily:** guardrail review on the dashboard (`/#/admin/analytics`) and alerts (opt-out, thumbs-down, Groq health, cost).
- **Stop early only for a guardrail breach** (kill switch, see docs/runbooks/opt-out-spike.md). No early stopping for success, and no peeking-based decisions (P9.3).
- **Mid-test SRM check** in week 2.
- Every config change during the test (kill switch, thresholds) is logged with its reason (`ops:config` audit) and noted in the analysis.

## 7. Sign-off
| Role | Name | Date |
|---|---|---|
| Data analyst | ⟨ ⟩ | ⟨ ⟩ |
| Product owner | ⟨ ⟩ | ⟨ ⟩ |

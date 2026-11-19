# Experiment analysis: svs_v1

> Generated 2026-11-17T04:09:48.799Z by `npm run analytics:report` · metrics metrics-v1 · data: 127.0.0.1:5433/svs_analytics
> Window 2026-10-20T04:09:47.571Z → 2026-11-17T04:09:47.571Z

## Decision: **SHIP**

- Voice start rate and D7 voice retention both rose significantly, and the guardrails hold. Go to Phase 10 (ramp).

| Check | Result | Detail |
|---|---|---|
| Sample ratio (SRM) | ✅ pass | assignments p=0.8376, eligible users p=0.8355 (alarm below 0.001) |
| Guardrail: opt-out rate ≤ 5% | ✅ pass | 2.11% (24/1137 users shown a card) |
| Guardrail: no significant rise in thumbs-down | ✅ pass | with card 8.22% vs control-eligible 9.71% (-1.49 pp, p=0.3434) |
| Primary: eligible-user voice start rate ↑ | ✅ pass | treatment 41.12% vs control 2.60% (+38.52 pp, 95% CI +35.55 pp … +41.49 pp, p=<0.0001) |
| Primary: D7 voice retention ↑ | ✅ pass | treatment 40.17% vs control 15.79% (+24.39 pp, p=0.0356; n=229/19) |
| Target: card-level start rate ≥ 15% | ✅ pass | 24.62% (535/2173) |
| Target: D7 voice retention +5 pp | ✅ pass | +24.39 pp |
| Target: WAVL +25% (per assigned user) | ✅ pass | 1148.9% (learner-weeks 466 treatment / 37 control, split 0.5) |

## Metrics by arm

| Metric | Control | Treatment | Difference | p |
|---|---|---|---|---|
| Eligible-user voice start rate (primary) | 2.60% (30/1155) | 41.12% (479/1165) | +38.52 pp | <0.0001 |
| D7 voice retention (primary) | 15.79% (3/19) | 40.17% (92/229) | +24.39 pp | 0.0356 |
| D30 retention (proxy) | 60.48% (75/124) | 56.80% (71/125) | -3.68 pp | 0.5551 |
| Thumbs-down (control-eligible → with card) | 9.71% (659) | 8.22% (657) | -1.49 pp | 0.3434 |
| Sessions per user per week | 1.02 | 1.16 | | |

## Treatment-only and overall

- **Card-level start rate:** 24.62% (535/2173; PRD target ≥ 15%)
  - mock_interview: 25.03% (212/847)
  - pronunciation: 27.50% (55/200)
  - spoken_english: 23.56% (164/696)
  - viva_revision: 24.19% (104/430)
- **Card tap rate:** 30.19% (656/2173)
- **Opt-out rate:** 2.11% (24/1137; guardrail ≤ 5%)
- **Cost:** SVS $2.041 (chat $1.939) over 555 WAVL learner-weeks = **$0.00368 per WAVL** (budget not set)
  - by use case: opening $0.037 · coach $0.670 · summary $0.227 · stt $0.838 · classifier $0.269 · chat $1.939

### WAVL by ISO week

| Week | Control | Treatment | Not in experiment |
|---|---|---|---|
| 2026-W43 | 1 | 34 | 5 |
| 2026-W44 | 7 | 76 | 10 |
| 2026-W45 | 10 | 107 | 7 |
| 2026-W46 | 11 | 189 | 17 |
| 2026-W47 | 8 | 60 | 13 |

## Funnel (treatment, unit = eligible suggestion)

| Step | Count | % of previous |
|---|---|---|
| eligible | 2279 |  |
| shown | 2173 | 95.35% |
| tapped | 656 | 30.19% |
| permission_ok | 582 | 88.72% |
| started | 535 | 91.92% |
| completed_30s | 399 | 74.58% |
| returned_d7 | 144 | 36.09% |

## Experiment health

| Count | Control | Treatment | SRM p | Mismatch |
|---|---|---|---|---|
| Assignments | 1185 | 1195 | 0.8376 | no |
| Eligible users | 1155 | 1165 | 0.8355 | no |
| Eligible events | 2253 | 2279 | 0.6993 | no |

## Groq health

Voice start p50 1098 ms · p95 1700 ms (n=828)

| Use case | Calls | Errors | 429 | Fallback | p95 ms | TTFT p95 ms |
|---|---|---|---|---|---|---|
| chat | 4532 | 0.97% | 0.97% | 0.00% | 3860 | 864 |
| classifier | 4532 | 1.04% | 1.04% | 0.00% | 1335 | — |
| coach | 3370 | 1.07% | 1.07% | 0.00% | 1551 | 1066 |
| opening | 828 | 1.69% | 1.69% | 0.00% | 581 | — |
| stt | 3370 | 0.83% | 0.83% | 0.00% | 865 | — |
| summary | 714 | 1.12% | 1.12% | 0.00% | 2431 | — |

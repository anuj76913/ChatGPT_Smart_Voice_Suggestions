# Baseline Pre-period Report: SYNTHETIC EXAMPLE (P8.4)

> **Synthetic data** (`npm run analytics:seed -- --scenario baseline`), to show the report. The real one goes to `docs/phase8/baseline-report.md` after the 2-week pre-period.

> Generated 2026-11-17T08:30:43.070Z by `npm run analytics:baseline` · metrics metrics-v1 · data: 127.0.0.1:5433/svs_analytics · experiment `svs_baseline` (treatment share 0: no cards)
> Window 2026-11-03 → 2026-11-17 (14 days). Pre-period rollout: 100% of the target population.

## Baselines

| Metric | Baseline | Sample |
|---|---|---|
| Eligible-user voice start rate (voice from the mic button, no cards) | 3.07% | 72/2346 eligible users |
| D7 voice retention (first-time voice users) | 30.77% | 8/26 |
| WAVL per week | 30.7 | 3 weeks |
| Sessions per user per week | 1.08 | 137 sessions |
| Thumbs-down rate on eligible answers | 7.90% | 107/1355 votes |
| New eligible users per week (at 100% rollout) | 1,173 | |
| New first-time voice users per week (at 100%, no cards) | 13.0 | |

## PRD targets against these baselines

| PRD target | Means |
|---|---|
| Voice start rate ≥ 15% (card-level, treatment) | Absolute; the baseline eligible-user rate is 3.07% |
| D7 voice retention +5 pp | 30.77% → 35.77% |
| WAVL +25% relative | 30.7 → 38.3 per week (scaled to the experiment population) |
| Sessions per user per week +20% | 1.08 → 1.29 |
| Opt-out ≤ 5%, no significant rise in thumbs-down | Guardrails; thumbs-down baseline above |

## A/B sizing: 10% rollout, 50/50, 4 weeks

| Test | Baseline | Needed per arm | Expected per arm | Power | Rollout for 80% power |
|---|---|---|---|---|---|
| Start rate +2 pp | 3.07% | 1,531 | 235 | 19% | 66% |
| D7 retention +5 pp (control arm limits it) | 30.77% | 1,393 | 3 | 3% | > 100%: extend the test or accept a larger detectable effect |

Freeze the chosen rollout and duration in [analysis-plan.md](analysis-plan.md) before Phase 9 (P8.5). Never change them after the test starts.

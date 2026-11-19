# A/B Test Power Calculation (P6.6)

> PRD (context.md §4.15): detect a **2 pp lift** in voice start rate at **95% confidence, 80% power**, over **4 weeks**, at **10% of eligible users**, split 50/50.
> Reproduce with `npm run analytics:power` (code: [scripts/analytics/power.ts](../../scripts/analytics/power.ts), maths in [apps/server/src/analytics/stats.ts](../../apps/server/src/analytics/stats.ts)).

## Formula
Users per arm for a two-sided two-proportion test, with equal arms:

n = (z₁₋α/₂ · √(2·p̄·(1−p̄)) + z_power · √(p₁(1−p₁) + p₂(1−p₂)))² / (p₂ − p₁)², where p̄ = (p₁ + p₂)/2.

A unit test checks the textbook value: 10% → 12% needs **3,841 users per arm**.

## Primary metric: eligible-user voice start rate, +2 pp
The baseline isn't known until the 2-week pre-period (Phase 8), so the table covers a range. The last three columns assume **20,000 new eligible users per week**, an illustrative figure: 10% rollout split 50/50 gives 1,000 per arm per week.

| Baseline | Treatment | Users per arm | Total users | Reached in 4 wk at 10%? | Weeks needed | Power after 4 wk |
|---|---|---|---|---|---|---|
| 3.0% | 5.0% | 1,506 | 3,012 | yes (4,000) | 1.5 | 100% |
| 5.0% | 7.0% | 2,213 | 4,426 | yes (4,000) | 2.2 | 96% |
| 10.0% | 12.0% | 3,841 | 7,682 | yes (4,000) | 3.8 | 82% |
| 15.0% | 17.0% | 5,274 | 10,548 | no (4,000) | 5.3 | 68% |
| 20.0% | 22.0% | 6,510 | 13,020 | no (4,000) | 6.5 | 59% |

## Secondary primary: D7 voice retention, +5 pp
D7 only counts **first-time voice users**, a much smaller group than eligible users. A +5 pp target needs:

| Baseline | Treatment | Users per arm |
|---|---|---|
| 15.0% | 20.0% | 906 |
| 20.0% | 25.0% | 1,094 |
| 25.0% | 30.0% | 1,251 |

Each control user who starts voice organically, and each treatment user who starts from a card, counts once. At a 10% card start rate and low organic voice use, **the control arm's first-time voice users will be the binding constraint**. The synthetic run shows the effect: 229 treatment vs 19 control. **Check the control arm's D7 sample before the test.** If it falls short, extend the test or accept a larger minimum detectable effect for D7.

## Decision rule for Phase 8 → 9
1. Measure in the pre-period: the baseline eligible-user start rate, the baseline D7 among first-time voice users, and new eligible users per week.
2. Run `npm run analytics:power -- --baselines <measured> --eligible-per-week <measured>` (add `--mde 0.05` for D7).
3. If 10% × 4 weeks doesn't reach the sample, **raise `rolloutPercent` or the duration before Phase 9** (implementation-plan P6.6). Never extend the test after peeking at results.

## Other notes
- The test is per user. Assignment is a deterministic hash, so repeat visits don't add sample but don't bias it either.
- Two primary metrics, both required to "ship", means no multiplicity correction is needed for the ship decision (an AND of tests is conservative). Guardrails use their own fixed thresholds.
- The A/A validation (`npm run analytics:aa`) confirmed a 5.25% false-positive rate across 2,000 simulated A/A tests (expected 5% ± 1.5%).

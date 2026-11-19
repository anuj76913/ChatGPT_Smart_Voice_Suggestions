# Runbook: Ramp a rollout step (Phase 10)

**Use when:** increasing who gets voice suggestions, for example 10% → 50% → 100% of India. In this prototype there is no A/B test: everyone in the rollout gets cards (experiment `svs_ramp`, treatment share 1).

## 1. Check the next step
```
npm run ops:ramp -- status
```
It lists the current step and every check for the next one (50%, then 100%):

| Check | Fails when | Warns when |
|---|---|---|
| Target rollout | Not higher than now, or outside 1–100 | — |
| Time at current step | Less than `ramp.minHoursPerStep` (72 h) since the last rollout change | — |
| No critical alerts firing | Any critical alert is open (`alert_events`) | — |
| Opt-out ≤ 5% (PRD guardrail) | Above 5% over `ramp.windowDays` (7) | Fewer than `analytics.alerts.minShownUsers` users shown a card |
| No rise in thumbs-down with a card | Significantly higher (p < 0.05) on answers with a card than without | Fewer than `minFeedbackPerArm` votes on either side |
| Cost per WAVL within budget | Above `analytics.costBudgetPerWavlUsd` | No budget, or no WAVL yet |
| Groq capacity at target | Projected daily use of any model above `groqLimits.warnShare` (80%) of its limit | No SVS traffic measured yet |

**Warnings don't block** (there's not enough data to judge). **Failures do.**

## 2. Step up
```
npm run ops:ramp -- to 50 --reason "Ramp step 2: guardrails green for 3 days"
```
This sets `enabled = true`, `rolloutPercent = 50` and experiment `svs_ramp` (share 1). Servers apply it within 15 s. **Groq capacity first:** if the capacity check fails, raise the Groq tier and update `analytics.groqLimits` before stepping (P10.2).

`--force` steps past failed checks. It is recorded in the audit log ("forced past: …"), so use it only with a written reason, never for guardrail failures.

## 3. Watch (each step, for at least 72 h)
- Dashboard `/#/admin/analytics`, scope "All traffic": opt-out tile, thumbs-down, cost per WAVL, Groq health, voice start p95.
- Alerts: `opt_out_rate`, `thumbs_down_delta`, `groq_headroom`, `cost_per_wavl`.
- `npm run ops:ramp -- status` again before the next step.

## 4. Roll back
Lower the rollout with `npm run ops:config -- rollout <lower> --reason "…"`, or use the [kill switch](kill-switch.md). Lowering never needs the ramp checks.

## Languages during the ramp (P10.3)
Cards in a language need **both**:
- the copy in `copy.languages`: all of en, hi, bn, mr, te are ready as drafts
- the language in `classifier.languages`: only languages the classifier was evaluated on

```
npm run ops:language -- check all                 # readiness per language
npm run ops:language -- enable bn --reason "…"    # production rules: reviewed copy + ≥100 reviewed eval rows
npm run ops:language -- enable bn --prototype --reason "…"   # prototype: synthetic rows / draft copy accepted, still needs ≥85% precision
npm run ops:language -- rank                      # which regional languages learners actually use
```

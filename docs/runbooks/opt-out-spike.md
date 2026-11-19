# Runbook: Opt-out spike

**Guardrail (PRD):** opt-out rate ≤ 5% of users shown a card. The alert `opt_out_rate` warns at 4% and turns critical above 5%, over a rolling 7 days, once at least 50 users have been shown a card. **Kill rule:** opt-out > 5% in the A/B test means **Kill** (decision rules, `npm run analytics:report`).

## 1. Confirm it's real (15 minutes)
- Dashboard → opt-out tile and the alert value. Check the sample size (`users_shown` in the alert details).
- Is it one slice? Compare by intent and language in the funnel, and by source:
  `SELECT props->>'source' AS source, count(*) FROM events WHERE event = 'suggestions_opted_out' AND ts > now() - interval '7 days' GROUP BY 1;`
- Did something change? `npm run ops:config -- audit` (thresholds, rollout, copy languages) and recent deploys.

## 2. Contain
| Finding | Action |
|---|---|
| One language or intent is driving it (e.g. new Hindi copy, a noisy intent) | `kill --language <lang>`, or raise that intent's threshold: `merge '{"classifier":{"thresholds":{"<intent>":0.95}}}'` |
| Cards look wrong (ambiguous queries getting cards) | Raise thresholds overall, re-run `npm run eval:classifier` on recent misfires |
| Broad, no single cause, above 5% | **Kill switch** (`disable`) and follow the PRD Kill rule: write up the learnings |
| Frequency (people seeing too many cards) | Lower `cap.perRollingWeek` (`merge '{"cap":{"perRollingWeek":2}}'`) |

Always `--reason` with the incident link. During the A/B test, log the change in the experiment notes.

## 3. Follow up
- Re-run `npm run analytics:report` for the affected window. A Kill decision ends the test.
- Users who opted out stay opted out (FR-4). Never turn suggestions back on for them in bulk.

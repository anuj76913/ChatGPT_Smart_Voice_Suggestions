# Runbook: Kill switch

**Use when:** suggestions must stop now: a guardrail breach (opt-out, thumbs-down), a bad classifier release, a Legal request, an incident in one market or language.
**Effect:** cards stop within ≤ 15 s (config reload). Chat is untouched. Voice sessions already running continue; new ones can still start from **Practice again** (the card-less entry points), which is intended.

## 1. Turn off
| Scope | Command |
|---|---|
| Everything | `npm run ops:config -- disable --reason "INC-123: <why>"` |
| One region | `npm run ops:config -- kill --region IN --reason "…"` |
| One language | `npm run ops:config -- kill --language hinglish --reason "…"` |
| One cohort | `npm run ops:config -- kill --cohort beta --reason "…"` |
| A combination | `npm run ops:config -- kill --region IN --language hi --reason "…"` (a rule matches only when **all** of its fields match) |
| Reduce, not stop | `npm run ops:config -- rollout 5 --reason "…"` |

If the database is unreachable, the servers already fail closed: config older than the staleness limit counts as stale, and stale config means no cards (`stale_config` in `suggestion_decisions`).

## 2. Verify (within a minute)
- `npm run ops:config -- show`: check `enabled` and the kill-switch rules.
- `suggestion_decisions` shows the new reason (`disabled` / `kill_switch` / `rollout`) for new answers:
  `SELECT outcome, count(*) FROM suggestion_decisions WHERE at > now() - interval '5 minutes' GROUP BY 1;`
- Send a test query that normally gets a card ("Take my mock interview"): no card.

## 3. Restore
`npm run ops:config -- unkill --region IN --reason "…"` or `enable --reason "…"`. Check `audit` afterwards.

## Notes
- Dogfood cohorts (`dogfoodCohorts`) bypass `enabled` but **not** the kill switch.
- The kill switch is evaluated twice: before the decision, and again right before the card is sent (edge-case DE-21). A card that is already on screen stays there.
- **Drill:** `kill --cohort local`, ask a card query in the local app (no card), then `unkill --cohort local`.

# Phase 8 Status: Internal Dogfood and Baseline Pre-period

> Tracks implementation-plan.md Phase 8 (PRD launch phase 1, W11–W12). This phase is **two weeks of real use by people**. What can be built is built and tested; running it needs the blockers below cleared, then the [playbook](playbook.md).
> **Status:** ✅ ready (built + tested) · 🟡 ready, with a gap · ⛔ blocked (outside engineering) · ⏳ needs the 2 weeks to happen.

## Can Phase 8 start?
**Not yet. Two Phase 7 blockers remain, neither of them code:**
1. **Groq capacity (BB-05):** the current key's limits can't carry dogfood traffic. Upgrade the tier, then update `analytics.groqLimits`.
2. **Access (BB-13):** dev login lets anyone pick any handle, so the deployment must be on a private network, or real sign-in must exist.

Hosting itself is still undecided (ADR-009). Everything else is ready.

## Tasks
| Task | Status | What exists |
|---|---|---|
| **P8.1** Dogfood cohort only | ✅ ⏳ | `npm run ops:cohort -- add --cohort dogfood <handles>` enrols participants. `npm run ops:config -- preset dogfood-baseline` turns on cards for that cohort only. `/v1/me` exposes `is_dogfood`. Tested: dogfood users get cards outside any experiment (`experiment_id` null) |
| **P8.2** Real queries → eval set | ✅ ⏳ | **Research consent** (dogfood only): a banner, a Settings toggle and `POST /v1/me/research-consent`. `npm run dogfood:export` exports **consenting** users' queries, with personal data masked, to git-ignored `data/intent-eval/private/`. `npm run dataset:label` is a resumable labelling CLI with blind mode and drop-for-personal-data. The eval (`eval:classifier`, `eval:check`, threshold sweep) now includes `private/dogfood.jsonl` automatically. Drilled end to end on synthetic data. **Needs:** consenting participants and two labellers |
| **P8.3** Daily triage | ✅ ⏳ | **Report a problem** in the app (dogfood + admins; own sessions only; 1,000 chars; deleted after 90 days). Admin triage API (`GET/PATCH /v1/admin/feedback`). `npm run dogfood:daily` covers participation, funnel, reason codes, thumbs-down, voice outcomes, open reports, alerts and Groq errors. The Phase 6 dashboard and alerts cover Groq health and latency |
| **P8.4** Baseline pre-period | ✅ ⏳ | **No new mode needed:** the same preset puts everyone else in experiment `svs_baseline` with treatment share 0, so the classifier runs and eligibility is logged, but no cards are shown (tested). **New general mic button** (practice picker, `entry_point = mic_button`), so the baseline can measure organic voice use; without it, the baseline voice start rate would be 0 by construction (BB-15, fixed). `npm run analytics:baseline` computes the baselines, the PRD targets against them, and the A/B sizing ([synthetic example](baseline-report-synthetic.md)) |
| **P8.5** Final experiment config + frozen plan | 🟡 ⏳ | `npm run ops:config -- preset ab-test --rollout N` stages Phase 9 (experiment `svs_v1`, 50/50). The [analysis plan](analysis-plan.md) is pre-registered as a **draft**; its blanks are filled from the real baseline report, then signed |

## Gate to Phase 9
`npm run gate:phase9` checks the gate automatically (eval precision, ≥ 1,000 human-reviewed rows including dogfood ones, ≥ 14 clean baseline days, the baseline report) and reads human sign-offs from [gate-attestations.json](gate-attestations.json). **Today: 12 of 13 checks open, as expected before dogfood** (only the eval gate on the synthetic seed passes):

| PRD gate | Status |
|---|---|
| Classifier precision ≥ 85% (extended set) | ⏳ The gate passes on the synthetic seed; the extended set needs dogfood labels |
| No P0 bugs | ⛔ BB-05 capacity, BB-13 auth (no open P0 code bugs) |
| Privacy copy approved by Legal + T&S | ⛔ pending (consent wording added to the review) |
| Baselines recorded; targets confirmed | ⏳ needs the 2-week pre-period |

## Verification
- Tests: `apps/server/test/dogfood.test.ts` (8 tests):
  - consent
  - problem-report permissions and ownership
  - admin triage
  - feedback retention
  - the baseline preset suppresses cards but logs eligibility
  - dogfood users get cards
  - mic-button sessions
  - personal-data scrubbing
- Browser walkthrough (`npm run audit:a11y`, production build): **16 screens, 0 axe WCAG 2.2 AA violations, no target under 44 px, no browser errors.** The 3 new screens are the practice picker, the consent banner and Report a problem ([results](../phase7/a11y-results.md)).
- Drills on the synthetic database:
  - preset → consent → export (only consenting users, masked)
  - labelling CLI (label / drop / resume, schema-valid output)
  - daily report
  - baseline report
  - gate check

## Known gaps
- The consent banner and the problem-report text are **draft wording** pending Legal / T&S.
- The scrubber masks emails, phones, URLs and long numbers. **Names need the labeller** (drop with `x`).
- The baseline uses the app's own mic button as the organic voice entry. In the real product, other voice entry points exist, so measure them too if you can.
- Participants' problem reports and exported queries are personal data: `data/intent-eval/private/` is git-ignored and must live in restricted storage in a real deployment.

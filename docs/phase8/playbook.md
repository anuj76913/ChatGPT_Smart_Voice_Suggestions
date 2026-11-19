# Dogfood + Baseline Pre-period Playbook (Phase 8)

> How to run the two weeks: who does what, which commands, and what gets checked every day.
> **Start only when** the Groq tier is upgraded (BB-05) and the app is on a private network or has real sign-in (BB-13). Legal / T&S review must be in progress; their approval is a Phase 9 gate, but the research-consent and privacy wording shown to dogfooders is marked draft.

## Day 0: set up
1. **Deploy** the current build with migrations applied (`npm run db:migrate`; `007_dogfood` adds consent and problem reports).
2. **Enrol participants** (India staff + student beta panel). Each person signs in once, then:
   ```
   npm run ops:cohort -- add --cohort dogfood <handle> <handle> …
   npm run ops:cohort -- list
   ```
3. **Turn on dogfood + baseline in one step** (P8.1 + P8.4):
   ```
   npm run ops:config -- preset dogfood-baseline --dogfood-cohort dogfood --rollout 100 --reason "Phase 8 start"
   ```
   - Dogfood users see cards (always treatment, outside any experiment).
   - Everyone else in the rollout is in experiment `svs_baseline` with treatment share 0: the classifier runs and logs eligibility, nobody sees a card, and voice is only reachable from the mic button. That's the baseline.
   - Lower `--rollout` if Groq capacity is tight. Classifier calls scale with it (see the capacity plan).
4. **Check:** `npm run ops:config -- show`; a dogfood account gets a card for "Take my mock interview"; a normal account doesn't.
5. Brief participants:
   - what to test: cards, voice, the summary, the mic button, Settings
   - "Report a problem" is in the menu
   - the consent banner is their choice (they can change it in Settings)

## Every day (15 minutes)
1. `npm run dogfood:daily`. It covers participation, the card funnel, reason codes, thumbs-down, voice outcomes, open problem reports, firing alerts and Groq errors. It contains participants' words, so keep it out of `docs/` (`--out` only writes under `data/intent-eval/private/`).
2. Triage every open report. Create a bug-bash item (P0/P1/P2) when needed, then mark the report:
   `PATCH /v1/admin/feedback/:id {"status":"triaged","triage":"BB-31"}`.
3. Check the dashboard (`/#/admin/analytics`, scope "All traffic" for dogfood, experiment `svs_baseline` for the baseline): alerts, Groq health, voice start p95.
4. Fix P0s the same day; ship P1s before Phase 9.

## Twice a week: extend the eval set (P8.2)
1. `npm run dogfood:export`. It only takes queries from **consenting** dogfood users, masks emails, phones, URLs and long numbers, and writes to the git-ignored `data/intent-eval/private/`.
2. Two people label independently:
   ```
   npm run dataset:label -- --labeler <a> --in data/intent-eval/private/raw-<date>.jsonl
   npm run dataset:label -- --labeler <b> --blind --in … --out data/intent-eval/labellers/<b>.jsonl
   npm run dataset:agreement -- data/intent-eval/private/dogfood.jsonl data/intent-eval/labellers/<b>.jsonl
   ```
   Drop (`x`) anything that still identifies a person.
3. `npm run eval:classifier` (new rows only, cached), then `npm run eval:classifier -- --write-thresholds` to re-tune, then `npm run eval:check`. Precision must stay ≥ 85% on seed + dogfood rows. Commit the thresholds and the eval report, **never** the private data.

## End of week 2
1. **Baseline report:** `npm run analytics:baseline -- --days 14 --out docs/phase8/baseline-report.md`. It records the baselines, the PRD targets against them, and the A/B sizing (adjust the targets if the baselines require it, P8.4).
2. **Freeze the analysis plan:** fill the blanks in [analysis-plan.md](analysis-plan.md) from the report, get it signed, and record it in `gate-attestations.json` (P8.5).
3. **Gate:** fill `docs/phase8/gate-attestations.json` (Legal, Groq terms, retention, capacity, auth, P0 count), then run `npm run gate:phase9`. Phase 9 starts only when every line passes.
4. Phase 9 start: `npm run ops:config -- preset ab-test --rollout <frozen> --reason "Phase 9 start"`.

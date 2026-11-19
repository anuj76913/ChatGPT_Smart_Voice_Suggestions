# Runbook: Groq model swap or deprecation

**Use when:** Groq announces a deprecation, a model degrades (latency, errors, quality), or a better model is approved.
**Rule:** never switch the **classifier** model without re-running the eval (precision ≥ 85%, PRD FR-1). Other use cases need a smoke test.

## 1. Check the candidate
1. `npm run groq:check -- --no-smoke` lists the models the key can use and checks every model ID in the default config. Confirm the candidate is in that list. Preview the config change with `npm run ops:config -- model classifier <new-id> --dry-run --reason "eval"`.
2. Use only Groq **production** models. Preview models can disappear without notice (ADR-004).

## 2. Validate
| Use case | Validation before switching |
|---|---|
| classifier | `npm run eval:classifier` with the candidate (edit `classifier.models` in a local override), then `npm run eval:check`. It must keep precision ≥ 85% and no ambiguous cards. Commit the new eval report |
| chat | `npm run bench:ttft -- --n 10`: TTFT not worse than the baseline (docs/phase1/ttft-baseline.md) |
| coach, opening | `npm run smoke:voice -- <clips>`: first coach sentence p50 ≤ 1.5 s, sensible replies |
| summary | Smoke run: the tip is one actionable sentence in the learner's language |

## 3. Switch (no release)
```
npm run ops:config -- model classifier <new-primary> <fallback|none> --reason "Groq deprecates <old> on <date>; eval report <link>"
```
Watch the dashboard's Groq health for 30 minutes: error rate, fallback rate, p95 latency per use case.

## 4. Roll back
`npm run ops:config -- model <use case> <old-primary> <old-fallback> --reason "rollback: …"`.

## Notes
- Each use case has its own primary and fallback (`llm.models`). Changing one doesn't touch the others.
- Changing the classifier also changes `model_version` in `suggestion_eligible`, so analyses can split by version.
- Update the token prices in `analytics.pricing` if the new model has different prices; otherwise cost per WAVL is wrong.

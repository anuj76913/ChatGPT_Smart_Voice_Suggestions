# Phase 10 Status: Ramp and Localization (prototype, no A/B)

> Tracks implementation-plan.md Phase 10 (PRD launch phase 3). **Phase 9 (A/B test) is skipped: this is a prototype** (decisions.md ADR-017). The ramp therefore gates each step on guardrails, cost and capacity, without a control arm.
> **Status:** ✅ done and verified · 🟡 done, with a gap · ⛔ blocked outside engineering.

## Tasks
| Task | Status | What exists |
|---|---|---|
| **P10.1** Ramp 50% → 100% with guardrail re-checks | ✅ | `npm run ops:ramp -- status \| to <pct> --reason "…"` ([runbook](../runbooks/ramp.md)). Each step requires ≥ 72 h at the current step, no firing critical alerts, opt-out ≤ 5%, no significant thumbs-down rise on answers with a card vs without, and cost per WAVL within budget. Too little data warns, failures block, and `--force` is audited. A step sets experiment `svs_ramp` with treatment share 1 (everyone in the rollout sees cards). Tested: first step allowed with warnings; blocked when going down, too soon, with a critical alert, or on an opt-out breach |
| **P10.2** Groq capacity ahead of each step | ✅ ⛔ | The ramp check projects each model's daily load at the target rollout from measured traffic (chat constant, SVS scaled by reach) and blocks above 80% of `analytics.groqLimits`. On the synthetic data it **blocks: gpt-oss-120b would need 463% of the current limit.** That's the same tier blocker as Phase 7 (BB-05). The pf-v4 prefilter also drops one-word messages before any model call |
| **P10.3** Localization: Hindi, then the top 3 regional languages | 🟡 | See below. Bengali, Marathi and Telugu are fully wired (detection, prefilter, copy, chat / coach / summary language, TTS voice by script, eval rows, readiness gate). **Copy and eval rows are machine-written drafts:** native review and real labelled queries are needed before production |
| **P10.4** Cost per WAVL against budget at each step | ✅ | A ramp check (budget $0.05 proposed in Phase 7) plus the existing `cost_per_wavl` alert |

## Localization details
| Piece | Hindi | Bengali | Marathi | Telugu |
|---|---|---|---|---|
| Language tag | Devanagari, default for Devanagari | Bengali script | Devanagari + Marathi marker words / suffixes | Telugu script |
| Prefilter (pf-v3/v4) | ✅ | ✅ | ✅ | ✅ |
| Card copy (`COPY_STATUS`) | draft | draft | draft | draft |
| Chat / coach reply language (chat-v4) | ✅ | ✅ | ✅ | ✅ |
| Summary tip + encouragement | ✅ | ✅ (draft) | ✅ (draft) | ✅ (draft) |
| Whisper language mapping | ✅ | ✅ | ✅ | ✅ |
| Browser TTS voice | hi-IN | bn-IN / bn-BD | hi-IN → mr-IN | te-IN (falls back to the browser default; captions always shown) |
| Eval rows (synthetic) | 20 | 20 | 20 | 20 |
| Live eval, primary model | 100% precision on 12 cards, recall 100% | 100% on 11, recall 91.7% | 100% on 12, recall 100% | 100% on 12, recall 100% |
| Ambiguous-set cards | 0 / 4 | 0 / 4 | 0 / 4 | 0 / 4 |
| Readiness, prototype rules | ✅ ready | ✅ ready | ✅ ready | ✅ ready |
| Readiness, production rules | ❌ draft copy, 0 reviewed rows | ❌ | ❌ | ❌ |
| Card on a 360 px phone (browser walkthrough) | ✅ no axe findings, no truncation | ✅ | ✅ | ✅ |

**Why the language is decided on the server:** the classifier model's prompt and JSON schema are unchanged (`clf-v2`, model languages en / hinglish / hi / other). Bengali and Telugu are recognised by script; Marathi vs Hindi by marker words and Marathi's glued postpositions (…साठी, …मध्ये). Changing the prompt would have invalidated the eval cache: re-running 280 rows on two models against the free tier's daily token limit. The eval was run **live on Groq** for the 80 new rows only (primary and fallback).

**Found and fixed by the eval:** the primary model gave a card for the bare word "interview" in Bengali and Telugu (ambiguous-set rows seed-0237 / seed-0277; it handled English correctly). Prefilter pf-v4 now drops one-word messages before the model: a single word is a topic, never a request to practise. Every one-word row in the eval set is labelled "none". The overall eval is now **100% precision / 98.8% recall (primary), 0 ambiguous cards**, and `eval:check` passes.

## How to turn a language on
```
npm run ops:language -- check all                       # production rules (reviewed copy + ≥100 reviewed rows)
npm run ops:language -- check all --prototype           # prototype rules (synthetic rows, draft copy; precision still ≥ 85%)
npm run ops:language -- enable bn --prototype --reason "prototype demo"
npm run ops:language -- rank                            # re-rank regional languages from real usage
```
Copy for all five languages is enabled by default (`copy.languages`). Whether cards appear in a language is controlled only by `classifier.languages` (default en + Hinglish). **Your dev database config is unchanged.** I demonstrated the regional cards on the synthetic `svs_analytics` database.

## Verification
- Tests: `apps/server/test/localization.test.ts` (13):
  - detection for every script and Marathi vs Hindi
  - the model-tag correction
  - Whisper mapping
  - reply-script instructions
  - pf-v3/v4 including the one-word rule
  - copy completeness: every language, intent and field is in its own script, titles ≤ 45 characters
  - config validation
  - readiness rules
  - Bengali cards blocked until enabled, then in Bengali and stored as Bengali, with fallback to English copy when bn copy is off
  - the ramp gate cases
- Live eval on Groq (80 new rows, both models): numbers above; report in [docs/phase2/eval-report.md](../phase2/eval-report.md).
- Browser walkthrough (`npm run audit:a11y -- --regional`): **20 screens, 0 axe violations, no target under 44 px, no browser errors**, including a card in each of Hindi, Bengali, Marathi and Telugu on a 360 px phone ([results](../phase7/a11y-results.md)).
- Ramp drill on synthetic data: `ops:ramp status` reported guardrails green, cost $0.0037 per WAVL, and a **capacity block** (Groq tier).

## Gate (PRD: results hold at scale; cost per WAVL within budget)
| Criterion | Status |
|---|---|
| Guardrails hold at each step | ✅ checked by `ops:ramp` before every step; ⏳ needs real traffic |
| Cost per WAVL within budget | ✅ $0.0037 on synthetic data vs $0.05 proposed budget |
| Capacity for the next step | ⛔ the Groq tier (BB-05) blocks any step above dogfood scale |
| Regional languages live | 🟡 prototype-ready; production needs native-reviewed copy and ≥ 100 human-labelled queries per language |

## Known gaps
- **The regional copy, summary text, prefilter words and eval rows were written by me, not native speakers.** Each needs review: Bengali, Marathi and Telugu speakers, plus Legal for the copy.
- The Marathi/Hindi split is a heuristic. Short Devanagari messages without marker words count as Hindi.
- Regional TTS voices are often missing on Android, in which case the browser default voice reads the text badly. Captions always show the text. Real-device QA is needed (BB-17).
- Other regional languages (Tamil, Kannada, Gujarati…) are not detected yet; they fall under "other". `ops:language rank` can only rank languages it can detect.
- With no A/B test, the ramp shows whether harm appears, not whether voice use grew because of the cards.

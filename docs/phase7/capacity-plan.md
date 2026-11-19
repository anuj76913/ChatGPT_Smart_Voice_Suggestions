# Capacity Plan vs Groq Limits (P7.6)

> Reproduce with `npm run capacity:plan -- --scenario dogfood|ab10|ramp100` (add `--measured` to use average tokens per call from `llm_usage`). Code: [scripts/capacity-plan.ts](../../scripts/capacity-plan.ts).

## Verdict
**Capacity is NOT confirmed. The current Groq key can't serve even the 300-user dogfood.** This blocks Phase 8 (it's bug-bash item BB-05, P0), and the fix is commercial, not code: a higher Groq tier, or an Enterprise agreement, before dogfood.

The bottleneck is **chat**, not SVS. In this MVP the chat assistant runs on the same `openai/gpt-oss-120b` model and org limits as the voice coach. SVS itself is light: about $0.0017 per voice session, and the classifier only runs for the ~20% of messages that pass the prefilter.

## Limits used (`analytics.groqLimits`)
Groq's published base limits per model, checked 2026-11-17 at console.groq.com/docs/rate-limits. They match what the current key hits.

| Model | Requests/min | Requests/day | Tokens/min | Tokens/day | Audio |
|---|---|---|---|---|---|
| openai/gpt-oss-120b, openai/gpt-oss-20b | 30 | 1,000 | 8,000 | 200,000 | — |
| whisper-large-v3(-turbo) | 20 | 2,000 | — | — | 7,200 s/hour |

## Traffic model (proposed; replace with Phase 8 measurements)
6 chat messages per active user per day · 20% pass the prefilter · 35% of those classified voice-friendly · 50% survive the caps · treatment share 50% · 15% of cards start a session (PRD target) · 1% organic sessions per user per day · 6 spoken turns per session · 12 s per answer · peak hour = 15% of the day, peak minute ×2 burst.

Average tokens per call, measured on real Groq calls in Phases 1–5: chat ≈ 740 · classifier ≈ 880 · opening ≈ 550 · coach ≈ 620 per turn · summary ≈ 620. The sample is small; re-measure with `--measured` during dogfood.

## Results (worst ratio = need ÷ limit)
### Phase 8 dogfood: 300 users, everyone enabled
| Model | Peak req/min | Peak tokens/min | Req/day | Tokens/day |
|---|---|---|---|---|
| gpt-oss-120b | 9.3 / 30 (0.31×) | 6,828 / 8,000 (0.85×) | 1,854 / 1,000 (**1.85×**) | 1,365,527 / 200,000 (**6.83×**) |
| gpt-oss-20b | 1.8 / 30 | 1,605 / 8,000 | 368 / 1,000 | 321,049 / 200,000 (**1.61×**) |
| whisper-large-v3-turbo | 0.2 / 20 | 83 audio-s / 7,200 per peak hour | 46 / 2,000 | — |

### Phase 9 A/B: 100k daily active learners, 10% in the experiment
| Model | Peak req/min | Peak tokens/min | Req/day | Tokens/day |
|---|---|---|---|---|
| gpt-oss-120b | 3,009 / 30 (100×) | 2.2M / 8,000 (278×) | 601,803 / 1,000 (602×) | 445M / 200,000 (2,226×) |
| gpt-oss-20b | 61 / 30 (2.0×) | 53,508 / 8,000 (6.7×) | 12,258 / 1,000 (12×) | 10.7M / 200,000 (54×) |
| whisper-large-v3-turbo | 7.7 / 20 (0.39×) | 2,781 audio-s / 7,200 (0.39×) | 1,545 / 2,000 (0.77×) | — |

### Phase 10 full ramp: 100k daily active learners, everyone enabled
gpt-oss-120b 2,276× tokens/day · gpt-oss-20b 535× · Whisper 3.9× audio-seconds/hour, 7.7× requests/day.

## Cost at list prices (`analytics.pricing`)
| Scenario | Chat/day | SVS/day | Per voice session |
|---|---|---|---|
| Dogfood | $0.61 | $0.04 | $0.0017 |
| A/B 10% | $202 | $1.36 | $0.0017 |
| Full ramp | $202 | $13.59 | $0.0017 |

**Cost per WAVL** is estimated at **≈ $0.011** at A/B scale: about $9.5 of SVS spend per week over about 870 weekly active voice learners (1,300 qualifying sessions at about 1.5 sessions per learner). The **proposed budget is $0.05 per WAVL** (`analytics.costBudgetPerWavlUsd`, ~4–5× headroom), which arms the `cost_per_wavl` alert. The product owner confirms the number (ADR-015).

## Actions before Phase 8
1. **Upgrade the Groq org tier** to cover dogfood with ≥ 2× headroom: about 3M tokens/day and ≥ 4k requests/day on gpt-oss-120b. Then get A/B-scale limits agreed before Phase 9.
2. Update `analytics.groqLimits` to the new tier so the `groq_headroom` alert is meaningful.
3. Optional levers if limits stay tight:
   - move **chat** to `gpt-oss-20b`, which roughly halves 120b load (needs a quality check)
   - keep `reasoning_effort` low
   - cap chat answers at a lower `max_tokens`
   - the suggestion path alone fits a much smaller budget
4. Re-run `npm run capacity:plan -- --measured` after week 1 of dogfood with real traffic, and before each ramp step (P10.2).

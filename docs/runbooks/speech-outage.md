# Runbook: Speech outage (speech-to-text)

**Architecture reminder (ADR-005):** speech-to-text is Groq Whisper (`whisper-large-v3-turbo` → fallback `whisper-large-v3`). Text-to-speech runs **in the browser** (`speechSynthesis`), so it can't have a server outage. It can only be missing on a device, and then captions still show every reply.

**Signals:** the `stt` row in Groq health shows errors or a high p95; `groq_server_errors:stt` or `groq_latency_p95:stt` fires; voice sessions end with `end_reason = 'error'`; learners see "Couldn't hear that clearly".

## What already happens automatically
- Each turn tries the primary model, then the fallback (8 s timeout each).
- If both fail, the learner is told and can answer again. After **3 failures in a row** the session ends cleanly (tested in `hardening.test.ts`). Chat is unaffected.

## 1. Triage
`SELECT end_reason, count(*) FROM voice_sessions WHERE started_at > now() - interval '1 hour' GROUP BY 1;`
Check whether `error` endings jumped and whether `llm_usage` rows for `use_case = 'stt'` show `status = 'error'`.

## 2. Act
- **Only one Whisper model is failing:** swap them. `npm run ops:config -- merge '{"stt":{"model":"whisper-large-v3","fallbackModel":"whisper-large-v3-turbo"}}' --reason "turbo failing"`.
- **Whisper is down:** stop sending learners into a broken experience. `npm run ops:config -- disable --reason "STT outage"` stops new cards. Learners can't start voice from a card, and chat continues normally.
- **Audio-seconds limit reached (7,200 s/hour per model on the current tier):** lower `rolloutPercent` and raise the tier (see the [capacity plan](../phase7/capacity-plan.md)).

## 3. Recover
`enable`, then watch `stt` errors and `voice_start_p95` for 30 minutes.

## Drill
`FAKE_GROQ_MODE=stt-down npx tsx scripts/fake-groq.ts 8790`: the session says it couldn't hear, then ends after 3 tries; chat keeps working.

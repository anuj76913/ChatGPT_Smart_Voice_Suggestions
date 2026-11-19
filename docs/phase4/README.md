# Phase 4 Status: Voice Session

> Tracks implementation-plan.md Phase 4 (W5–W7). FR-3, FR-6, FR-7, FR-10 (controls) and the four PRD edge cases.
> **Status:** ✅ done and verified · 🟡 done, with a known gap · ⬜ not started.

## Tasks
| Task | Status | Where | Verified by |
|---|---|---|---|
| **P4.1** C3 Voice Onboarding | ✅ | `apps/web/src/components/VoiceFlow.tsx`, `POST /v1/me/privacy-notice-ack` | Privacy notice once per account (server flag), with "Not now". Mic is requested only after the tap. Separate states for denied, blocked, busy, no mic and unsupported, each with instructions and **Back to text** (never a dead end). Events `privacy_notice_shown/ack`, `mic_permission_denied {permanent}`. Integration test for the ack |
| **P4.2** S9 Speech Gateway | ✅ | `apps/server/src/voice/speech.ts` | Groq Whisper `whisper-large-v3-turbo` → fallback `whisper-large-v3` (tested). `verbose_json` → language + `avg_logprob` / `no_speech_prob` quality signals; romanized-Hinglish prompt hint; 8 s timeout. Usage → `llm_usage` (`use_case = stt`). **TTS runs in the browser** (`lib/voice/tts.ts`, ADR-005): rate = speed, voice = accent, Devanagari → Hindi voice |
| **P4.3** Presets | ✅ | `apps/server/src/voice/presets.ts` (`coach-v1`) | 4 presets: role prompt, opening guidance, en/Hinglish/Hindi opening templates, next activities. Shared spoken-reply rules (≤3 short sentences, one question, no markdown, ask to repeat if the transcript is garbled) |
| **P4.4** Session creation | ✅ | `POST /v1/voice/sessions`, `orchestrator.ts` | Preset + last 6 chat turns + speed/voice prefs. Opening line from Groq within 600 ms, **else the template** (tested with a slow model: <1.2 s, template used). Returns label, opening, settings, limits and a **5-minute HMAC stream token scoped to session + user**. Emits `voice_session_started` |
| **P4.5** Pre-warm | 🟡 | n/a | Not needed in practice: creation, including the LLM opening, took **340–632 ms** live, and the browser speaks the text with no TTS network hop. Revisit if device tests miss the 2 s target |
| **P4.6** Turn loop | ✅ | `orchestrator.ts` | One audio clip per turn over the WebSocket → Whisper → `transcript.final` → Groq coach (`gpt-oss-120b`, streaming, fallback `-20b`) → `reply.sentence` per finished sentence → `reply.done`. Replies follow the learner's script (server-side detector). Both models fail → "Sorry, can you say that again?"; 3 in a row → ends with `error` |
| **P4.7** In-session signals | ✅ | `orchestrator.ts` | Per-language tally (dominant language; a tie goes to the latest turn), question counter (answer of ≥3 words to a question), **noisy-room hint after 2 low-quality turns**, **10-minute cap with a warning 1 minute before**, busy guard (one turn at a time), clip-size limit |
| **P4.8** Transcript persistence | ✅ | `voice_turns` | Finalized turns only; **no audio column anywhere** (asserted by a test that scans the schema). Audio is held in memory, sent to Groq, then dropped |
| **P4.9** Resilience | ✅ | WS resume + `POST /v1/voice/sessions/:id/continue-in-text` | Client retries for 5 s, then shows "Continue in text". The server keeps the session resumable for 60 s, sends missed turns after `last_turn_id`, and excludes gaps from the duration. Continue-in-text ends the session and appends a recap to the chat (tested) |
| **P4.10** C4 Voice Session UI | ✅ | `apps/web/src/components/VoiceSession.tsx`, `lib/voice/recorder.ts` | Task label, assistant speaks first, **captions always shown**, states as text plus a live region, mic closed while the assistant speaks (avoids echo). End of turn after 1.2 s of silence or **Done speaking**. Silence nudge at 10 s, pause at 60 s; tab hidden → pause. **Speed/Voice one tap away** (saved). End confirmation under 30 s. Reconnect / "Continue in text" UI |
| **P4.11** Entry points + events | 🟡 | | `entry_point` stored for `suggestion_card` and `practice_again` (the tapped card offers **Practice again**). `voice_session_started/completed` are server-emitted (completed carries `start_latency_ms`, `duration_s`, `questions`, `qualifies_for_wavl`). Client logs `voice_setting_changed`, `noisy_room_hint_shown`, `voice_session_network_drop`. **Gap:** no general **mic button** in the composer yet (the API accepts `mic_button`) |
| **P4.12** Tests | 🟡 | `apps/server/test/voice.test.ts` (21 tests) + live run | Every server path (see below). **Not done:** browser end-to-end and a **mid-range Android device over 4G** (needs a device lab or a person with a phone) |

## Live results on real Groq (Phase 4 smoke runs)
`npm run smoke:voice -- turn1.wav turn2.wav` against the running server. Clips were synthesized speech (Windows voice, English). 3 runs, 2 turns each:

| Measure | Results | Target |
|---|---|---|
| Session create (incl. LLM opening line) | 340 / 632 / 482 ms | Part of the <2 s start (browser TTS then starts locally) |
| Whisper STT per turn | 322–850 ms (median ~400 ms) | n/a |
| Clip sent → first coach sentence | 908 / 670 / 1366 / 817 ms (+960 ms in the first run) | p50 ≤ 1.5 s, p90 ≤ 2.5 s ✅ |
| Clip sent → full reply | 744–1452 ms | n/a |

The coach gave sensible interview feedback, e.g. after "I built a chatbot for my college library…": *"Good start: mention the impact of the project, like how it helped users or saved time. Next, can you describe a technical challenge you faced…?"* Whisper misheard "chatbot" as "Chotbit" on the synthetic voice, and the coach still followed the meaning.

**Start latency** as the PRD defines it (session request → first audible audio) = create (≈0.3–0.6 s) + browser TTS start. The client measures it and sends it to the server (`start_latency_ms`, kept on the session and in `voice_session_completed`). It hasn't been measured on a real phone yet.

## PRD edge cases
| Edge case | Status |
|---|---|
| PRD-1 ambiguous query | ✅ Phase 2/3 (no card) |
| PRD-2 noisy room | ✅ Headphone hint on the card (Phase 3) + "Noisy room?" hint after 2 low-quality turns (tested) |
| PRD-3 Hindi/Hinglish mid-session | ✅ Reply follows the learner's script; dominant language reported at the end (tested). 🟡 Only tested with scripted transcripts, not real Hinglish speech |
| PRD-4 network drop | ✅ Reconnect/resume with missed turns; "Continue in text" appends a recap (tested) |

## Bugs found and fixed during Phase 4
1. **Failure counter reset by every transcription.** Speech-to-text and coach failures shared one counter that every successful transcription reset, so a broken coach would loop "Sorry, can you say that again?" forever. Split into two counters (found by the IS-23 test).
2. **Stale React closures in the session screen.** Socket handlers captured `listen()` from the first render, so the session would never start recording after the assistant spoke. Handlers now read refs.
3. **Question detection missed closing quotes.** An opening ending in `…this role?”` didn't count the learner's answer as a practised question (seen live). There's a unit test.
4. **Smoke-script measurement bug** (leftover sentences in the queue): fixed before reporting the numbers above.

## Exit criteria
| Criterion | Status |
|---|---|
| FR-3, FR-6, FR-7 pass; FR-10 controls work | ✅ server-side (tests + live). 🟡 UI not yet clicked through in a real browser |
| Voice start <2 s p90 on a mid-range Android over 4G | 🟡 Server part 0.3–0.6 s live; **device measurement not done** |
| Turn latency near p50 ≤1.5 s / p90 ≤2.5 s | ✅ first sentence 0.67–1.37 s live (n = 5) |
| All 4 PRD edge cases behave as specified | ✅ (PRD-3 with scripted transcripts) |

## How to try it
1. `npm run db:local:start` (if needed) and `npm run dev` → http://localhost:5173 in **Chrome** (`localhost` counts as a secure context for the mic).
2. Local users already see cards (Phase 3 dogfood setting). Ask *"Take my mock interview for a TCS fresher role"* → **Try Voice Practice** → accept the privacy notice → allow the mic.
3. Speak after the assistant finishes; pause 1.2 s (or press **Done speaking**). **⚙ Speed / Voice** changes apply to the next reply.

Live smoke test without a browser: `npm run smoke:voice -- <clip1.wav> <clip2.wav>` (server running, real key).

## Known gaps / next
- **No real-browser or device testing yet.** Mic capture, the voice-activity threshold, `speechSynthesis` voices (especially `hi-IN` on Android) and the <2 s start on a mid-range phone over 4G all need a person with a device. That's P4.12 and the P7.1 performance pass.
- **No general mic button** (`entry_point = mic_button`) in the composer yet.
- **No barge-in:** the mic is closed while the assistant speaks. That's simpler and avoids echo, but the learner can't interrupt.
- **Pronunciation feedback is transcript-based only** (edge-case IS-21; the coach prompt says so).
- Live sessions are held in memory (single server instance), like the rate limiter.
- ~~The session summary screen, tip, streak and next activity are Phase 5.~~ Done in [Phase 5](../phase5/README.md).

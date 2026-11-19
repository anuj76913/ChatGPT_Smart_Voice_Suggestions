# Phase 5 Status: Summary, Habit Loop and Remaining P1

> Tracks implementation-plan.md Phase 5 (W8–W9). FR-8 (summary), FR-9 (next activity), FR-10 (polish), FR-11 (Hindi copy).
> **Status:** ✅ done and verified · 🟡 done, with a known gap · ⬜ not started.

## Tasks
| Task | Status | Where | Verified by |
|---|---|---|---|
| **P5.1** Summary build | ✅ | `orchestrator.ts` (`end()`), `voice_sessions` | Duration excludes pauses and reconnect gaps (Phase 4). Questions practised = answers of ≥3 words to an assistant question. Dominant language = most-spoken language (a tie goes to the latest turn). `qualifies_for_wavl` = ≥30 s and at least one learner turn. Tested, including a mid-session switch from English to Hinglish |
| **P5.2** Tip + next activity | ✅ | `apps/server/src/voice/summary.ts` (`summary-v1`) | Groq `gpt-oss-120b`, strict `json_schema` `session_summary {tip, next_activity_index}`, non-streaming, 8 s timeout, fallback `gpt-oss-20b`. If both fail, the summary shows with no tip and the preset's first next activity (tested). No answers means no LLM call, and an encouragement line is shown instead (SU-03). The tip is written in the dominant language (Hinglish tested). It is **built in the background when the session ends** and cached in `session_summaries` (`tip_source` = llm / none / failed) |
| **P5.3** Streak | ✅ | `apps/server/src/voice/streak.ts`, `voice_prefs.streak_*` | Counts consecutive **local** days with at least one qualifying session (the user's time zone, falling back to Asia/Kolkata); the goal is 3. The day credited is the day the session **started**, so a session that runs past midnight counts for the day it began. Same day → unchanged, next day → +1, gap → 1, and an older day never rewinds the streak. Unit tests for midnight and time zones (19:00 UTC = next day in India) plus integration tests (same day / consecutive / gap). Saved on the session (`streak_after`, `streak_credited`) |
| **P5.4** C5 Summary UI | 🟡 | `apps/web/src/components/SessionSummaryPanel.tsx`, `VoiceSession.tsx`, `VoiceFlow.tsx` | Shows duration and questions at once, then the tip ("Preparing your tip…" while it loads), streak dots ("2 of 3 days"), and a short-session note. **Next: <activity>** starts a session with `entry_point = next_activity` and the chosen activity as the session focus (the opening line and the coach prompt both use it). **Practice again** starts one with `entry_point = practice_again`. **Back to chat** posts the recap and reloads the chat. Logs `summary_action {action, voice_session_id}`. `voice_session_completed` is server-emitted (Phase 4). **Gap:** not clicked through in a real browser |
| **P5.5** FR-11 Hindi card copy | 🟡 | `packages/shared/src/copy.ts`, `suggestions/engine.ts`, `classifier/prefilter.ts` (`pf-v2`) | Hindi copy for all 4 intents. Devanagari queries now reach the classifier. Cards in Hindi are **only shown when `classifier.languages` includes `hi`** (off by default, edge-case CL-06), and then use Hindi copy. Stored cards keep their language on reload. **Gap:** the Hindi strings are a **draft** that needs native-speaker review and Legal sign-off, and the classifier hasn't been evaluated on Hindi yet |
| **P5.6** Tests | 🟡 | `apps/server/test/summary.test.ts` (17) + live run | Unit tests: streak rules, time zones, Hindi copy, the Devanagari prefilter. Integration tests: summary + tip + next activity + streak; both models failing; no answers; Hinglish; a mid-session language switch; streak same day / next day / gap; owner-only and 409 while active; recap idempotency; next-activity focus and a bad index (400); Hindi cards blocked then shown. **Not done:** browser end-to-end tests of the three actions, and Hindi copy QA on a device (truncation, fonts) |

## Live check on real Groq
`npm run smoke:voice -- turn1.wav turn2.wav` now also fetches the summary and posts the recap. Synthetic English answers about a library chatbot gave:

- **Tip (en):** *"Connect your project to TCS skills by highlighting problem-solving and teamwork."* It was ready **1.7 s after the session ended**, including the round trip; the background build had already started.
- **Next activity:** *Practise HR questions next*
- **Streak:** 0/3, not credited. This is correct, because the scripted session lasted under 30 s.
- **Recap:** posted to the conversation (200)

The turn latencies matched Phase 4: STT 273–314 ms, first coach sentence 617–625 ms.

## Edge cases covered
| Edge case | Behaviour |
|---|---|
| SU-02 short session | Summary shown with a "short session" note; no streak credit |
| SU-03 no answers | No tip and no LLM call; an encouragement line instead |
| SU-04 summary model fails | Summary without a tip; the default next activity |
| SU-06/08 streak across midnight / time zones | The local day of the session start, in the user's time zone |
| CL-06 unsupported language | A Devanagari query gets `language_not_supported` (no card) until Hindi is enabled |
| Back to Chat twice | One recap message (idempotent, with a row lock) |

## Exit criteria
| Criterion | Status |
|---|---|
| FR-8 summary (duration, questions, one tip, streak) | ✅ server (tests + live). 🟡 UI not clicked through in a browser |
| FR-9 next activity | ✅ chosen from the preset's list, and it sets the next session's focus |
| FR-10 polish | ✅ controls from Phase 4, plus the summary screen with a ≥48 px tap size, live regions and focus moved to the heading |
| FR-11 English + Hindi | 🟡 built and tested. The Hindi copy is a **draft** pending native review, and Hindi cards are off until the classifier is evaluated on Hindi |
| `qualifies_for_wavl` correct in all tests | ✅ |

## How to try it
1. `npm run db:local:start`, `npm run db:migrate` (applies `004_session_summaries`), then `npm run dev` → http://localhost:5173 in Chrome.
2. Start voice practice from a card, answer one or two questions, then **✕ End**.
3. The summary appears: try **Next: …**, **Practice again** or **Back to chat** (look for the recap message in the chat).

## Known gaps / next
- **Hindi copy is a draft.** It needs native-speaker review, Legal sign-off where needed, and device QA. To turn on Hindi cards, add `hi` to `classifier.languages`, but only after a Hindi classifier eval.
- **No browser or device testing** of the summary screen (the same gap as Phase 4).
- **Hinglish detection is a word-list heuristic.** Sentences built from words it doesn't know (e.g. *maine*, *kiya*, *kyunki*, *thi*) count as English. This affects the dominant language and so the tip's language. Consider adding these words or using Whisper's own language tag together with the script check.
- **The streak only counts voice sessions**, as the plan specifies. It isn't shown anywhere outside the summary yet (e.g. in Settings).
- Summaries and live sessions are cached per server instance; a multi-instance deployment needs the in-flight dedupe moved to the database (the summary row itself is already shared).

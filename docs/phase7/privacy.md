# Privacy Review (P7.3)

> What is stored, where, and for how long. This is the engineering side of the privacy sign-off. **Legal / Trust & Safety approval of the copy and of Groq's terms is still pending** (docs/phase0/legal-review.md).

## Data inventory
| Data | Where | Contains learner content? | Retention |
|---|---|---|---|
| Chat messages | `messages` | Yes (the product's chat history) | Existing chat-history policy (not changed by SVS) |
| Voice transcripts (finalized turns) | `voice_turns.transcript` | Yes | **`privacy.voiceTranscriptRetentionDays` (proposed 30 days)**, then deleted by the purge job (every 6 h) |
| Summary tips | `session_summaries.tip` | Model text about the answers | Cleared on the same schedule as transcripts |
| Voice recap in chat | `messages` (`model = 'voice-recap'`) | Short summary + tip | Chat-history policy |
| **Audio** | **Nowhere.** Held in memory for one Whisper call, then dropped | — | Not stored (a test scans the schema for audio columns) |
| Events | `events` | **No.** Ids, enums, numbers, booleans only; typed per the catalogue; free-text keys rejected | Analytics retention (to be set with the analytics store) |
| Groq metering | `llm_usage` | No (tokens, latency, model, ids) | Same as events |
| Suggestion decisions, suggestions, assignments, alerts | their tables | No | Same as events |
| Dogfood problem reports (Phase 8) | `feedback_reports` | Yes: text the participant chose to send | **`privacy.feedbackRetentionDays` (90)**, then deleted by the purge job |
| Research consent (Phase 8) | `users.research_consent(_at)` | No | Account lifetime |
| Exported dogfood queries for labelling (Phase 8) | `data/intent-eval/private/` (git-ignored; restricted storage in a real deployment) | Yes: consenting participants only, with emails / phones / URLs / long numbers masked; labellers drop rows that name someone | Until the eval set is retired; delete on consent withdrawal |
| Server logs | stdout (pino) | **No**: no request bodies; cookies and auth headers redacted | Hosting log retention |

## Automated checks
- **Canary test** (`hardening.test.ts`): a chat query, the model's answer and a voice transcript each carry a unique canary string. After a full flow (card, a Groq failure, a spoken turn, the summary), none of them appears in the **log output** (captured at trace level) or in `events`, `llm_usage`, `suggestion_decisions`, `suggestions`, `alert_events`, `experiment_assignments` or `voice_sessions`. Only `messages` and `voice_turns` hold them, by design.
- **Retention test:** turns older than the window are deleted, recent ones kept, and old tips cleared.
- **Event schema** (Phase 6): props must match the catalogue, which has no content fields.

## Third parties
- **Groq** receives the chat text, the classifier input (the query plus up to 2 recent turns), the voice audio clips (for transcription) and the transcripts (for the coach and summary). Groq's data-processing and retention terms are **pending Legal review** (§17 #13); this is a dogfood gate.
- The browser's own speech synthesis runs on the device; no audio or text is sent to a TTS service.

## Pending (not engineering)
- Legal / T&S approve the first-use privacy line and the mic explainer (FR-6). The current text is marked "Draft".
- Legal confirms the transcript retention period against the Voice Mode policy (§17 #9). Change `privacy.voiceTranscriptRetentionDays` if it differs; no release needed.
- DPDP notice and consent wording.

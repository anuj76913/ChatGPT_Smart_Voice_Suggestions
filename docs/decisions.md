# Decision Log: Smart Voice Suggestions MVP

> Output of **Phase 0** (implementation-plan.md, P0.1–P0.4). Each entry records a decision, the reason for it, and what it changes in [architecture.md](architecture.md).
> **Status values:** **Decided** = final for the MVP · **Default** = adopted so work can start; product can still change it before the listed phase.

| ID | Decision | Status | Decided on |
|---|---|---|---|
| ADR-001 | Client: responsive website (React + Vite + TypeScript) with desktop and mobile views | Decided | 2026-11-16 |
| ADR-002 | Backend: Node.js + TypeScript (Fastify + WebSocket) | Decided | 2026-11-16 |
| ADR-003 | Database: PostgreSQL (also the MVP analytics store) | Decided | 2026-11-16 |
| ADR-004 | LLM provider: Groq | Decided | 2026-11-16 |
| ADR-005 | Speech: Groq Whisper (STT) + browser `speechSynthesis` (TTS) | Decided | 2026-11-16 |
| ADR-006 | Classifier: rules prefilter + Groq `openai/gpt-oss-20b` (architecture §6.1 option B) | Decided | 2026-11-16 |
| ADR-007 | Monorepo layout and tooling | Decided | 2026-11-16 |
| ADR-008 | Timing constants and behaviour defaults | Default | 2026-11-16 |
| ADR-009 | Hosting / deployment target for staging and prod | **Open** | — |
| ADR-010 | User authentication: dev login for local, staging and dogfood | Decided (MVP default) | 2026-11-16 |
| ADR-011 | Phase 3 suggestion-engine implementation choices | Decided | 2026-11-16 |
| ADR-012 | Phase 4 voice-session implementation choices | Decided | 2026-11-17 |

---

## ADR-001: Client is a responsive website
**Decision:** a single-page web app built with **React + Vite + TypeScript**, responsive from 360px phones up to desktop.
- **Mobile view (<768px):** full-width chat, bottom composer, and a **full-screen** voice session.
- **Desktop view (≥768px):** a centred chat column (max ~760px); the voice session opens as a **centred panel** over the chat.

**Why:** fastest to build and demo; runs on Android Chrome (the PRD's primary device) and on desktop; same style as the prototype (ask-listen-speak.lovable.app).

**Consequences:**
- The mic needs a secure context (HTTPS, or `localhost` in development).
- "App backgrounded" cases (edge-case DV-02) become tab-hidden cases (`visibilitychange`). Android Chrome may suspend audio in a hidden tab, so the session pauses.
- Mic permission uses the browser permission model. The "Open settings" deep link (FR-7) becomes instructions for site settings in the browser.
- Store installs and push notifications are out of scope for the MVP.

## ADR-002: Backend is Node.js + TypeScript
**Decision:** Node.js (≥22) + TypeScript, **Fastify** for HTTP, `@fastify/websocket` for the voice channel, **zod** for config and payload validation. The architecture components (S1–S13) are modules in one service for the MVP. They can be split later.

**Why:** types shared with the client; Groq's API is OpenAI-compatible and easy to call from Node; good streaming support.

## ADR-003: Database is PostgreSQL
**Decision:** PostgreSQL (18 locally) is the primary store for the §8 data model. For the MVP it **also stores analytics events** (an `events` table), queried for the metrics in §12.3. A dedicated warehouse comes later if volume needs it.

**Why:**
- Atomic counter updates for the frequency caps (FR-5) via `UPDATE … RETURNING` / row locks.
- Relational model fits the §8 entities.
- Already installed.

## ADR-004: LLM provider is Groq
Recorded earlier in architecture.md §6.7. Model IDs are in config (`packages/shared/src/config.ts`) and must be checked with `npm run groq:check` (P0.5).

**Update 2026-11-16, after the first `groq:check` with the project key:**
- The key sees 11 models. The Llama models originally proposed (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) are Enterprise-tier and **not available**, so every use case moved to the production `gpt-oss` models:

  | Use case | Primary | Fallback |
  |---|---|---|
  | chat | `openai/gpt-oss-120b` | `openai/gpt-oss-20b` |
  | classifier | `openai/gpt-oss-20b` | `openai/gpt-oss-120b` |
  | coach | `openai/gpt-oss-120b` | `openai/gpt-oss-20b` |
  | opening | `openai/gpt-oss-20b` | template |
  | summary | `openai/gpt-oss-120b` | `openai/gpt-oss-20b` |

  Reasoning effort is low except for the summary (medium).
- The strict-JSON classifier smoke test passed: a Hinglish interview query was classified `mock_interview` (confidence 0.9, language `hinglish`) in 593 ms.
- Also visible to the key: `openai/gpt-oss-safeguard-20b` and `meta-llama/llama-prompt-guard-2-*` (preview). These are candidates for the open content-moderation question (edge-case Q4), but because they are preview models they need a fallback plan.
- `qwen/qwen3.8-27b` is visible but preview, so it is not used on core paths.

## ADR-005: Speech is Groq Whisper STT + browser TTS
**Decision**
| Function | Choice | Notes |
|---|---|---|
| Speech-to-text | **Groq `whisper-large-v3-turbo`** (production model); fallback `whisper-large-v3` | Called from the **server** (key stays server-side). `verbose_json` gives the detected **language** and per-segment `avg_logprob` / `no_speech_prob`, used as the confidence and quality signals for the noisy-room hint (edge-cases IS-01, SP-04) |
| Text-to-speech | **Browser `speechSynthesis`** with `en-IN` / `hi-IN` voices | Runs **in the client**. Speed control = `utterance.rate`; accent = choice of voice (`en-IN` vs `hi-IN`). Free; no audio leaves the device for TTS |

**Turn-taking (MVP):** Whisper on Groq is request/response, not streaming. So a turn works like this:
1. The browser records with `MediaRecorder` (Opus/WebM).
2. **End of speech** is detected by a simple client-side silence detector (proposed: 1.2s of silence) **or** a "Done" button.
3. The audio clip is sent to the server over the voice WebSocket.
4. The server calls Whisper, then the Groq coach model (streaming).
5. The server streams the reply text back sentence by sentence.
6. The browser speaks each sentence as it arrives.

**Changes to architecture.md:**
- **S9 Speech Gateway** handles **STT only** on the server. TTS moves into **C4 Voice Session UI**.
- In the §5.2/§5.3 sequence diagrams, read "S → A audio stream" as "server streams reply **text** → browser TTS".
- The <2s start budget improves: the opening line is spoken by the browser as soon as its text arrives (no TTS network hop).
- `hint.noisy_room` uses Whisper `no_speech_prob` / `avg_logprob` thresholds (to be tuned in Phase 4).

**Risks and mitigations**
| Risk | Mitigation |
|---|---|
| `hi-IN` voice missing on some devices/browsers | Fall back to an `en-IN` (or any English) voice. Always show **captions** of the reply (helps AX-03 and SP-03) |
| Whisper writes Hindi in Devanagari when the user spoke Hinglish | Pass a `prompt` hint with romanized Hinglish examples; the coach handles both scripts; language tally treats `hi` with Latin script as `hinglish` |
| Audio clips go to Groq (a third party) | Not stored by us; covered in the Legal review packet (docs/phase0/legal-review.md) |
| Turn latency (record → upload → STT → LLM) | Short clips; Groq Whisper turbo is fast; the coach streams; measured against the p50 ≤1.5s / p90 ≤2.5s target in Phase 4 |

## ADR-006: Classifier approach
**Decision:** architecture §6.1 **option B**: a rules prefilter (English + Hinglish keywords, tuned for recall) and then Groq `openai/gpt-oss-20b` with strict `json_schema`, temperature 0. Fallback: `openai/gpt-oss-120b` with the same strict schema, plus server-side validation. Per-intent thresholds come from the eval set (Phase 2).

## ADR-007: Repository layout and tooling
```
apps/web        React + Vite + TS client (C1–C8)
apps/server     Fastify + TS backend (S1–S13)
packages/shared Shared types + config defaults (intents, presets, constants, event names)
scripts/        Ops scripts: groq-check, db-check, dataset validate/agreement
data/intent-eval Labelled classifier dataset (JSONL)
docs/           Product + architecture docs; docs/phase0 = Phase 0 outputs
```
- npm workspaces; `tsx` for running TypeScript; `tsup` to bundle the server; `vitest` for tests; GitHub Actions CI (typecheck, test, build, dataset validation).
- Config defaults live in `packages/shared/src/config.ts` and mirror architecture §10. The runtime config service (Phase 1, S7) loads these as defaults and applies overrides.
- Secrets come only from environment variables (`.env` locally, the platform secret store in staging/prod). `.env` is git-ignored.

## ADR-008: Defaults for timing and behaviour
Adopted so Phases 1–5 can start. Product can change any of these before the phase listed.

| Item | Default | Source | Change before |
|---|---|---|---|
| Card grace window after `answer.complete` | 500 ms | arch §10 | Phase 3 |
| Classifier timeout | **2s (decided 2026-11-16)**: at 1.5s, 14% of calls timed out on the Groq free tier (queueing ≈0.3–0.4s) | arch §10, Phase 2 eval | — |
| Opening-line budget | 600 ms, then template | arch §6.7.3 | Phase 4 |
| Session length cap | 10 min, warning at 9 min | arch §10 | Phase 4 |
| Noisy-room hint | after 2 consecutive low-quality turns | arch §10 | Phase 4 |
| Reconnect window | 5s | arch §5.6 | Phase 4 |
| End-of-speech silence (new, ADR-005) | 1.2s, or a "Done" button | this log | Phase 4 |
| Weekly cap window | **Rolling 7×24h in absolute time** (time zone not needed; fixes the wording in arch §6.2, edge-case Q6) | edge-case Q6 | Phase 3 |
| What resets consecutive dismissals | Only a card tap (not organic voice) | arch §17 #11 | Phase 3 |
| Re-enable in Settings | Clears an active pause and the dismissal counter; weekly cap still applies | edge-case Q2 | Phase 3 |
| Kill switch scope | Stops new suggestions only; running sessions continue | edge-case Q3 | Phase 3 |
| `suggestion_shown` trigger | ≥50% visible for ≥1s | edge-case Q8 | Phase 3 |
| Card in a conversation that already had organic voice | Suppressed | edge-case Q9 | Phase 3 |
| Active voice sessions per user | One; the older session ends as `superseded` | edge-case Q10 | Phase 4 |
| Silence / hidden tab timeouts | Nudge at 10s silence, pause at 60s; end after 5 min hidden | edge-case Q7 | Phase 4 |
| Meaning of "accent" control (FR-10) | Choice of browser TTS voice (`en-IN` / `hi-IN`) **and** the Whisper language hint | arch §17 #5 | Phase 4 |
| Streak | Consecutive local days with ≥1 qualifying session (≥30s); goal 3 days | arch §17 #6 | Phase 5 |
| Recap on Back to Chat | Append a short recap message | arch §17 #10 | Phase 5 |
| Daily voice budget per user | 30 min/day; above it, no cards (sessions still allowed) | edge-case Q5 | Phase 7 |
| Privacy notice | Shown once per account for this feature | edge-case Q1 | Phase 4 |
| Content moderation on the Groq path | **Still open** (edge-case Q4). Must be decided before dogfood | edge-case Q4 | Phase 7 |

## ADR-009: Hosting (open)
Needed before staging exists (Phase 1 exit). It needs: Node hosting with WebSocket support, managed PostgreSQL, HTTPS (required for the mic), and a secret store.

## ADR-010: Authentication: dev login (MVP default)
Caps, opt-out and A/B assignment need a stable user ID (edge-case DE-12).

**Decision (Phase 1):** a **dev login**.
- The user picks a handle (2–32 chars). The server upserts a `users` row and sets a **signed, httpOnly, SameSite=Lax session cookie** holding the user id (`@fastify/cookie`, `SESSION_SECRET`). The cookie is `Secure` in staging/production.
- No password.
- Enabled for local/test/staging. Disabled in production unless `ALLOW_DEV_LOGIN=true`.
- Admins for the runtime-config API are the handles listed in `ADMIN_USERS`.

**Why:** unblocks Phase 1–8 (local work and the dogfood panel) without choosing an identity provider now. Only `authenticate` in `apps/server/src/auth.ts` reads the cookie, so swapping in real sign-in later (Google or email magic link) doesn't touch any feature route.

**Must change before public traffic:** real sign-in, plus age/region capture for the experiment population (India, 18–24, Tier-2/3).

## ADR-011: Phase 3 suggestion-engine implementation choices
- **Impressions come from the `suggestions` table** (architecture §8 asked to pick one source of truth). Counted statuses: shown, tapped, dismissed, opted_out, ignored, eligible_control. `late` never counts.
- **Impressions are recorded at delivery, not at decision.** `decide()` runs in parallel with the answer and doesn't write impressions. `commit()` runs after `answer.complete`: it re-checks the kill switch, prefs and caps under a **per-user advisory lock** (`pg_advisory_xact_lock`) and then inserts the row. So a late card or a failed answer never uses up a cap, and two tabs can't both take the last slot.
- **Dogfood cohorts always get treatment** and get no experiment assignment, keeping them out of the A/B analysis (edge-case EX-02).
- **`suggestion_eligible` is server-emitted at commit** (both arms), carrying arm, intent, language, confidence and classifier version.
- **Reason codes** go to a `suggestion_decisions` table (one row per answered message; ids/enums/numbers only).
- **Dismiss has a 4 s undo** in the UI; the dismissal only counts when the undo window ends (or when the user navigates away).
- **The tap only records interest until Phase 4** ships the voice session.

## ADR-012: Phase 4 voice-session implementation choices
- **Turn protocol:** one complete audio clip per spoken turn over the WebSocket (a `turn` message with the MIME type, then one binary frame). Not continuous streaming, because Groq Whisper is request/response. The server replies with `transcript.final`, then `reply.sentence` per finished sentence, then `reply.done`, so the browser starts speaking after the first sentence.
- **Mic is closed while the assistant speaks.** This avoids the assistant hearing itself on speakerphone (edge-case IS-08), at the cost of no barge-in (IS-07).
- **End of turn:** client-side energy detector with an adaptive noise floor. A turn ends after 1.2 s of silence following speech, on **Done speaking**, or at 90 s.
- **Opening line:** Groq `gpt-oss-20b` within 600 ms, otherwise a per-preset template in English, Hinglish or Hindi. Pre-warming wasn't needed: creation took 340–632 ms live.
- **Auth for the stream:** session cookie **plus** a 5-minute HMAC token scoped to session + user (edge-case SEC-05).
- **One live session per user,** held in memory and mirrored in `voice_sessions`. A new session supersedes the old one. A dropped socket stays resumable for 60 s (`serverResumeWindowMs`); the client gives up after 5 s and offers "Continue in text", which appends a recap to the chat.
- **Duration excludes pauses and disconnected time.** `qualifies_for_wavl` = duration ≥ 30 s and at least one learner turn.
- **Failure handling:** separate counters for speech-to-text and coach failures; 3 in a row of either ends the session (`error`).
- **Question counting:** an answer of ≥3 words to an assistant turn that ends in a question (closing quotes ignored).
- **Thresholds and limits are in config** (`voice.*`): STT quality thresholds, clip size, turn length, silence nudge/pause, resume window, coach max tokens.

## ADR-013: Phase 5 summary, streak and Hindi copy choices
- **The summary is built when the session ends, not when it is opened.** `end()` calls `VoiceSummaries.warm()`, which asks Groq (`gpt-oss-120b`, strict `json_schema`, fallback `-20b`, 8 s) for one tip plus the index of a next activity from the preset's list. The result is cached in `session_summaries`. `GET /v1/voice/sessions/:id/summary` returns the cached row or waits for the in-flight build. If both models fail, the summary has no tip and the first next activity. No answers means no LLM call.
- **Streak = consecutive local days with at least one WAVL-qualifying session**, goal 3 (decision #6). It uses the user's time zone (fallback Asia/Kolkata), and the day credited is the day the session **started**. Same day: unchanged. Next day: +1. Gap: back to 1. An older day never rewinds it. It is updated inside the end-of-session transaction and saved on the session (`streak_after`, `streak_credited`).
- **Back to Chat appends one short recap** to the conversation (decision #10): duration, questions, tip and streak. It is idempotent per session (`recap_message_id`, row lock). Practice again and Next activity start a new session in place (`entry_point = practice_again | next_activity`). The next activity becomes the new session's **focus**, added to the opening and coach prompts.
- **Hindi card copy ships as a draft and is gated by `classifier.languages`.** Devanagari queries pass the prefilter (`pf-v2`), but a `hi` classification gives `language_not_supported` (no card) unless `classifier.languages` includes `hi`. We only show cards in languages the classifier has been evaluated on (CL-06). When enabled, Devanagari queries get Hindi copy; Hinglish queries keep English copy, because Hinglish readers use Latin script. The card's language is stored, so reloads show the same copy.

## ADR-014: Phase 6 analytics, experiment and alerting choices
- **The analytics store is the same PostgreSQL** (the `events` and `llm_usage` tables) until hosting is decided (ADR-009). Metric definitions are versioned SQL (`metrics-v1`, docs/phase6/metrics.md), so they can move to a warehouse unchanged in meaning.
- **The event catalogue is data** (`event-catalogue.ts`) and is enforced at ingestion: typed props only, no free text. **Intent and language come from the referenced record, not the client** (suggestion → classified intent and language; voice session → intent and dominant language; message → suggestion/decision row or question language). References must belong to the user. This closes the spoofing gap for the PRD's "tagged with intent, language, arm" requirement (edge-case EX-05).
- **Funnel unit = the eligible suggestion**, so it can be sliced by intent and language. The primary A/B metric is per user: eligible users who start voice after first eligibility.
- **D30 is a proxy** (chat or voice activity on local days 30–36, read by maturity date) until the app-level pipeline is available.
- **Cost per WAVL** counts only SVS use cases (classifier, opening, coach, summary, speech-to-text), at Groq list prices kept in config. Whisper is billed at a 10 s minimum per call, and audio seconds are now metered. Chat is reported separately. The budget is unset until the Phase 7 capacity plan.
- **Alerts run inside the API server** every 5 minutes behind a transaction-scoped advisory lock. They keep one open row per (rule, key), notify once on open and once on resolve, and support an optional Slack-compatible webhook with no user ids. Thresholds and minimum samples live in config (`analytics.*`).
- **The decision rules are code** (`decision.ts`), run by `npm run analytics:report`, which writes markdown. This replaces a Python notebook so it runs in the same toolchain and CI. SRM (p < 0.001) makes a result **invalid** before any other rule applies.
- **Synthetic staging data** lives in a separate `svs_analytics` database; the seed refuses to write to `svs_dev` / `svs_test`.

## ADR-015: Phase 7 hardening choices
- **Sessions are revocable:** the signed cookie holds `user id + epoch`, and logout increments the epoch (signing the user out everywhere). This is a stopgap until real authentication replaces dev login (ADR-010), which stays a P0 before any public deployment.
- **Defence in depth for cross-site requests:** an Origin check on state-changing requests and WebSocket upgrades, on top of `SameSite=Lax` cookies and the per-session stream token. Security headers on every response; a CSP meta tag in the production build (`script-src 'self'`). The host must add TLS, HSTS termination and `frame-ancestors 'none'`.
- **Errors return codes, never internals:** 5xx → `internal_error`, 4xx → a short code. Details go to the server log, which never includes request bodies.
- **Transcript retention: 30 days (proposed)**, enforced by a purge job every 6 hours that deletes `voice_turns` and clears summary tips. Legal confirms the period against the Voice Mode policy; it's a config value (`privacy.voiceTranscriptRetentionDays`), so changing it needs no release.
- **Turn rate limit:** 15 spoken turns per session per minute (`voice.maxTurnsPerMinute`), because each turn costs Groq calls on a shared, tight quota.
- **Cost budget: $0.05 per WAVL (proposed)**, about 4–5× the capacity-plan estimate of $0.011. It arms the `cost_per_wavl` alert; the product owner confirms it before the A/B test.
- **Capacity:** the current Groq tier can't serve dogfood (chat shares gpt-oss-120b). **A tier upgrade is a hard prerequisite for Phase 8.** `analytics.groqLimits` holds the limits and must be updated with the new tier.
- **Accessibility is verified in a real browser:** `npm run audit:a11y` drives the whole UI offline (fake Groq, fake mic) and runs axe WCAG 2.2 AA plus a 44 px target check per screen. It doesn't replace TalkBack / VoiceOver walkthroughs.
- **React effects use block bodies** (enforced by a source-rule test): Chrome's `scrollIntoView()` now returns a Promise, and an expression-bodied effect handed it to React as a "cleanup", crashing every voice session.

## ADR-016: Phase 8 dogfood and baseline choices
- **Baseline pre-period = a config preset, not a new mode.** `preset dogfood-baseline` sets `enabled`, the rollout, `dogfoodCohorts: [dogfood]` and experiment `svs_baseline` with `treatmentShare: 0`. Everyone outside the cohort is control: the classifier runs, `suggestion_eligible` is logged, nobody sees a card. The A/B test then uses a **new** experiment id (`svs_v1`), so baseline assignments don't carry over.
- **A general mic button** (practice picker, `entry_point = mic_button`) is available to everyone. Without an organic voice entry the baseline voice start rate is 0 by construction, and the control arm couldn't build D7 retention. Both arms get it; only the card differs.
- **Research consent is opt-in and separate** from the voice privacy notice. Only dogfood participants are asked, and only their consenting queries are exported, with obvious personal data masked and labellers dropping rows that name someone. The data stays in git-ignored `data/intent-eval/private/`; the eval includes it automatically.
- **Problem reports are free text by design** (explicit, dogfood and admins only), kept 90 days (`privacy.feedbackRetentionDays`). The daily triage report contains them, so it never goes into `docs/`.
- **The Phase 9 gate is a script** (`npm run gate:phase9`): automatic checks plus signed attestations in `docs/phase8/gate-attestations.json`. The analysis plan is pre-registered as a draft and frozen from the real baseline report.

## ADR-017: Phase 10 ramp and localization choices (prototype, no A/B test)
- **No A/B test** (prototype decision). Phase 9 is skipped. The ramp puts everyone in the rollout into experiment `svs_ramp` with treatment share 1. Guardrails compare answers **with** a card against answers **without** one (no control arm), so they detect harm but can't measure lift. The decision rules of Phase 6 are not used.
- **Ramp gate** (`npm run ops:ramp`): a step up needs ≥ 72 h at the current step, no firing critical alerts, opt-out ≤ 5%, no significant thumbs-down rise with a card, cost per WAVL within budget, and the Groq load projected at the target within 80% of the org limits. Too little data **warns** instead of blocking; `--force` is audited.
- **Top 3 regional languages = Bengali, Marathi, Telugu.** The PRD says "by segment usage", but there's no usage data yet. The default is the 2011 Census ranking of first languages after Hindi; `npm run ops:language -- rank` re-ranks from real queries once there's traffic.
- **The server decides the language tag; the classifier model's prompt and schema are unchanged** (`clf-v2`, model languages en / hinglish / hi / other). Bengali and Telugu are detected by script. Marathi vs Hindi (both Devanagari) is decided by marker words and Marathi's glued postpositions, defaulting to Hindi. This keeps the eval cache valid, because changing the prompt would have meant re-running 200+ rows on two models against the free tier's daily limit.
- **Copy for all five languages is available** (`copy.languages`), as **drafts** (`COPY_STATUS`) until native review. Cards in a language still need it in `classifier.languages`, managed by `npm run ops:language`. The production rule needs reviewed copy, ≥ 100 human-reviewed eval rows, ≥ 85% precision and no ambiguous-set cards; `--prototype` accepts synthetic rows and draft copy, but never lower precision.
- **Voice in regional languages:** Whisper's tags are mapped; chat, coach and summary reply in the learner's script (chat-v4). TTS picks a voice by script (bn-IN, te-IN, hi-IN / mr-IN), falling back to the browser default with captions.

## ADR-018: Phase 11 v2 bets and the team demo
- **Each v2 bet has its own flag** (`v2.previewMode`, `v2.quietMode`), off by default. Flags reach the UI through the client config (`features`), and the server enforces them too (e.g. the quiet setting is not returned while its flag is off).
- **Voice Learning Challenges are out of scope for the prototype** and were removed after being built: no UI, API, flag, events or tables. Migration 009 drops `challenge_enrollments` / `challenge_days` and the session columns, moves any `entry_point = challenge` rows to `mic_button`, removes the `challenge` entry point and the challenge events, and strips `v2.challenges` from stored config overrides.
- **Voice Preview Mode is scripted, not generated:** a fixed ~30 s exchange per intent, read by the browser's speech engine with captions. It's instant, free, needs no microphone, and behaves the same every time. Starting practice from it uses `entry_point = preview` and also records a card tap.
- **Quiet mode is client-led:** a lower speech-detection threshold and softer playback, plus a server flag that stops low-confidence soft speech from triggering the noisy-room hint.
- **Short answers (chat-v5):** long multi-section answers pushed the voice card below the fold in the demo. The chat prompt now caps answers at about 120 words with no tables or headings, longer only on request. This applies to every answer, card or not, so the text answer still never depends on the card.
- **Demo tooling:** `npm run demo:setup` applies one audited config, `npm run demo` / `npm run demo:offline` start everything in one terminal, and docs/DEMO.md is the presenter script. The offline mode exists because the Groq free tier can rate-limit a live demo.

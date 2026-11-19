# Phase 11 Status: v2 Bets (after the MVP)

> Tracks implementation-plan.md Phase 11 (PRD launch phase 4). Each bet ships **behind its own new flag** (config `v2.*`, all off by default) and can be switched on without a deploy. `npm run demo:setup` turns all of them on for the team demo ([docs/DEMO.md](../DEMO.md)).
> **Status:** ✅ done and verified · 🟡 done, with a gap · ⛔ out of scope.

| Bet | Flag | Status | What exists |
|---|---|---|---|
| **Voice Preview Mode**: a 30-second guided voice demo on top of the card | `v2.previewMode.enabled` | ✅ | "▶ Hear a 30-sec preview" on the card plays a scripted exchange per intent (coach question → sample answer → feedback, ~30 s), read aloud with captions and a progress bar. **No mic, no permission prompt.** "Start practising" opens the real session (`entry_point = preview`, counted as a card tap). Events `voice_preview_started` and `voice_preview_ended {seconds, outcome}`, tagged from the card |
| ~~Voice Learning Challenges~~ | — | ⛔ out of scope | Not part of the prototype. It was built briefly and then removed completely: UI, API, flag, events and tables. Migration `009_remove_challenges.sql` cleans existing databases. A test checks that the API, the `challenge` entry point and the tables no longer exist |
| **Whisper / low-volume mode**: for hostels and libraries | `v2.quietMode.enabled` | 🟡 | A "Quiet mode" switch in the session's Speed / Voice panel, saved in preferences. It lowers the speech-detection threshold so soft speech counts as a turn, plays the coach more softly, suppresses the "noisy room" hint (whispers score low on purpose), and shows a headphones tip. **Gap:** whisper recognition quality depends on Whisper and the mic; it needs testing in a real library or hostel |

## Verification
- Tests: `apps/server/test/v2.test.ts` (5):
  - preview scripts are ~30 s
  - everything is hidden while the flags are off
  - challenges are gone: `/v1/challenges` returns 404, `entry_point = challenge` is rejected, and no challenge tables or columns remain
  - quiet mode is saved and returned
  - a session can start from a preview, and preview events are tagged from the card
- Browser walkthrough (`npm run audit:a11y -- --v2 --regional --admin admin`, against `npm run demo:offline`): **21 screens, 0 axe WCAG 2.2 AA violations, no target under 44 px, no browser errors.** That includes the card with the preview button, the preview playing, a voice session with quiet mode on, and its summary.
- **Found and fixed by the walkthrough:**
  - **Funnel accuracy:** a fast tap could log `suggestion_tapped` before `suggestion_shown`, which only fires after the card has been visible for a moment. The dashboard showed 200% "tapped of shown". A tap now logs `shown` first if needed.
  - **Targets:** the quiet-mode checkbox (22 px, now a 44 px switch) and the dashboard's focusable funnel rows (36 → 44 px).
  - The Speed / Voice panel stayed open over the summary; it now hides when the session ends.

## Demo tooling
| Command | What it does |
|---|---|
| `npm run demo:setup` | Migrations, plus a demo config (suggestions for everyone, 6 card languages, all v2 bets on, relaxed caps). `-- --off` resets to defaults |
| `npm run demo` | API (real Groq) + web app in one terminal; Ctrl+C stops both |
| `npm run demo:offline` | The same with the built-in fake Groq: no key, no rate limits |

## Notes
- **Demo setup replaced your dev database's overrides.** Before it, the only override was `dogfoodCohorts: ['local']` from Phase 3. `npm run demo:setup -- --off` clears everything back to the code defaults, not to that earlier override.
- The preview scripts are English. Regional previews would follow the same path as the card copy: draft, then native review.
- With no A/B test, the impact of the v2 bets can't be measured causally. The events exist for a future experiment.

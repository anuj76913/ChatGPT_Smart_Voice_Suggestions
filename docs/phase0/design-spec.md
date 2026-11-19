# Design Spec: P0 Screens (P0.9)

> **For:** whoever designs and builds the client (apps/web).
> **Platform:** responsive website (ADR-001).
> **Breakpoints:**
> - **Mobile:** <768px, designed at 360×740
> - **Desktop:** ≥768px, centred 760px column
>
> Covers every P0 screen plus the P1 summary and settings. Wireframes are low-fidelity; the layout, states, copy and accessibility rules are the binding part.

---

## 1. Foundations

### 1.1 Tokens (implemented in `apps/web/src/styles.css`)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #f7f7f5 | #121211 | Page background |
| `--surface` | #ffffff | #1c1c1a | Chat column, cards |
| `--text` | #1c1c1a | #ededea | Body text (AA on surface) |
| `--text-muted` | #55554f | #a9a9a2 | Secondary text (AA on surface) |
| `--border` | #dcdcd6 | #3a3a36 | Dividers, card outline |
| `--accent` | #0f766e | #2dd4bf | Primary actions (CTA, Send) |
| `--accent-text` | #ffffff | #062b28 | Text on accent |
| `--danger` | #b42318 | #f97066 | Errors |
| `--radius` | 12px | | Cards, inputs, buttons |
| `--tap` | 48px | | Minimum touch target |
| `--gutter` | 16px | | Side padding on mobile |

**Type:** system UI stack plus **Noto Sans Devanagari** for Hindi. Body 16px / 1.5 line height. Card title 16px semibold. Never below 14px.

### 1.2 Global accessibility rules (NFR: WCAG AA, TalkBack/VoiceOver)
- Contrast ≥4.5:1 for text and ≥3:1 for UI boundaries, in both themes.
- Every interactive element ≥48×48 CSS px, with an accessible name.
- Nothing conveyed by colour alone (states always have text).
- Respect `prefers-reduced-motion`: no pulsing animations; use static state labels.
- Layout survives 200% text zoom with no clipped buttons (edge-case UI-10, AX-07).
- Focus is visible (2px accent outline) and follows a logical order.

---

## 2. Chat screen with the Suggestion Card (C1 + C2) · FR-2, FR-4

### Mobile
```
┌──────────────────────────────┐
│ Voice Practice Chat      ⚙   │  header 56px; ⚙ = Settings
├──────────────────────────────┤
│              ┌─────────────┐ │
│              │ Help me prep│ │  user bubble (right)
│              │ for my TCS  │ │
│              │ interview   │ │
│              └─────────────┘ │
│ ┌──────────────────────────┐ │
│ │ Sure! Here's how to      │ │  assistant answer (full text,
│ │ prepare… (text answer)   │ │  always rendered FIRST)
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ 🎙 Practice with Voice  ✕│ │  ← Suggestion Card (below answer)
│ │ Speak your answers out   │ │     ✕ = dismiss (48px target)
│ │ loud and get instant     │ │
│ │ feedback on your         │ │
│ │ confidence and accuracy. │ │
│ │ 🎧 Tip: use headphones in │ │  headphone hint (muted text)
│ │ a shared space.          │ │
│ │ ┌──────────────────────┐ │ │
│ │ │  Try Voice Practice  │ │ │  primary CTA, full width, 48px
│ │ └──────────────────────┘ │ │
│ │ Don't suggest voice      │ │  text button (48px tall)
│ └──────────────────────────┘ │
├──────────────────────────────┤
│ [ Ask anything…        ][Send]│ composer, safe-area padding
└──────────────────────────────┘
```

### Desktop
Same structure inside a centred 760px column. The card's max width matches the answer bubble. The CTA is auto-width (not full width) and left-aligned, with "Don't suggest voice" inline to its right.

### Card rules
| Rule | Detail | Source |
|---|---|---|
| Position | Directly **below** the completed answer it belongs to; never mid-stream, never above | FR-2, UI-01 |
| Appearance | Fades in over 150 ms (instant with reduced motion); **no** focus steal, no scroll jump | UI-02 |
| Title | Task-specific from the copy catalogue (e.g. "Practice with Voice", "Practice your viva aloud") | FR-2 |
| Dismiss (✕) | Hides the card with a 4s "Dismissed · Undo" snackbar (undo within 4s doesn't count as a dismissal) | FR-4 |
| "Don't suggest voice" | Hides the card; toast: "Voice suggestions are off. Turn them back on in Settings." with a Settings link | FR-4 |
| Double tap | CTA disabled after the first tap until the session opens or fails | UI-05 |
| History | The card keeps its state when the conversation is reopened; a dismissed card stays hidden | UI-07 |

### Card states
`hidden` (default) → `visible` → `starting` (CTA shows a spinner + "Starting…") → `gone` (dismissed / opted out) or `used` (session started; the card collapses to "Practised with voice ✓ · Practice again").

### Card accessibility
- Container is a `<section aria-label="Voice practice suggestion">`, inserted **after** the answer has finished being read.
- Announced politely (`aria-live="polite"`) with "Voice practice available". It never interrupts the answer (AX-01).
- Reading order: title → why-line → headphone hint → **Try Voice Practice** → **Dismiss suggestion** → **Don't suggest voice**.
- The ✕ button's accessible name is "Dismiss suggestion".

---

## 3. First-use privacy notice (C3) · FR-6
Shown once per account, after tapping **Try Voice Practice** and **before** requesting the mic.

```
Mobile: bottom sheet                    Desktop: centred dialog (480px)
┌──────────────────────────────┐        ┌────────────────────────────────┐
│ ─────                        │        │ Before you start            ✕  │
│ Before you start             │        │                                │
│                              │        │ Your voice is turned into text │
│ Your voice is turned into    │        │ to run this practice. We don't │
│ text to run this practice.   │        │ keep the recording. …          │
│ We don't keep the recording. │        │ Privacy policy ↗               │
│ Transcripts are handled under│        │                                │
│ our voice privacy policy.    │        │        [ Not now ] [Continue]  │
│ Privacy policy ↗             │        └────────────────────────────────┘
│ ┌──────────────────────────┐ │
│ │        Continue          │ │
│ └──────────────────────────┘ │
│          Not now             │
└──────────────────────────────┘
```
- Copy: legal-review.md §4 (**pending Legal approval**).
- **Continue** → mark seen → mic permission. **Not now** / ✕ / backdrop → back to chat; the notice is **not** marked seen (PM-03).
- The policy link opens in a new tab; returning keeps the sheet open (PM-02).
- Dialog semantics: `role="dialog"`, `aria-modal="true"`, focus trapped, Esc closes, focus returns to the CTA on close.

---

## 4. Mic permission denied (C3) · FR-7
```
┌──────────────────────────────┐
│ 🎙  Microphone is off         │
│                              │
│ Voice practice needs your    │
│ microphone so you can answer │
│ out loud.                    │
│                              │
│ To allow it: tap the 🔒 icon │
│ next to the address → Site   │
│ settings → Microphone →      │
│ Allow. Then try again.       │
│ ┌──────────────────────────┐ │
│ │        Try again         │ │
│ └──────────────────────────┘ │
│        Back to text          │
└──────────────────────────────┘
```
- Variants (PM-07/08/11/12):
  - **denied once:** "Try again" re-prompts
  - **blocked:** instructions only, no OS prompt
  - **mic busy:** "Your mic is in use by another app"
  - **no mic:** "No microphone found"
- Instructions differ for Android Chrome and desktop browsers; detect the browser and show the right steps.
- **Back to text** always works and returns focus to the chat composer (no dead end).

---

## 5. Voice session (C4) · FR-3, FR-10
Mobile: **full screen**. Desktop: **centred panel** (560×640) over a dimmed chat.

```
┌──────────────────────────────┐
│ ✕ End      Interview Practice│  task label (FR-3); End = 48px
│                  ⚙ Speed/Voice│  one tap to controls (FR-10)
├──────────────────────────────┤
│                              │
│   Tell me about yourself     │  assistant caption (live, large)
│   and why you chose CS.      │
│                              │
│          ◉  Listening…       │  state: Speaking / Listening /
│                              │  Thinking / Paused / Reconnecting
│  You: "I'm a final-year…"    │  your last turn (caption)
│                              │
│  ⓘ Noisy room? Try headphones│  hint (non-blocking, IS-01)
├──────────────────────────────┤
│  [ ⏸ Pause ]    [ ✓ Done ]   │  Done = end of turn (ADR-005)
│  9:12 left                   │  shown from the 1-min warning
└──────────────────────────────┘
```

| Element | Behaviour |
|---|---|
| Start | Assistant **speaks first** (browser TTS); the opening caption appears immediately; target <2s to the first audio |
| States | Text label always visible; the icon is decorative (`aria-hidden`). States: Speaking, Listening, Thinking, Paused, Reconnecting… |
| Captions | Assistant replies always shown as text (deaf/hard-of-hearing users, a missing `hi-IN` voice, AX-03, SP-03) |
| **Done** | Ends the user's turn; auto-ends after 1.2s of silence (ADR-008) |
| Speed / Voice (⚙) | Sheet with speed (0.8× / 1× / 1.2×) and voice (English-India / Hindi). Applies from the next reply (IS-14/15) |
| End (✕) | Confirms only if <30s ("End now? Short sessions don't count toward your streak") → summary |
| Length cap | "1 minute left" banner at 9 min → summary at 10 min |
| Reconnecting | Banner "Reconnecting…"; after 5s: "Connection lost. **Continue in text**" (NW-01) |
| Tab hidden | Session pauses; on return: "Paused · Resume" (DV-02) |

Accessibility:
- Each state change is announced politely.
- Captions are a live region; listening pauses while a screen reader is speaking (AX-02).
- All controls are labelled ("End session", "Speed and voice settings", "Done speaking").

---

## 6. Session summary (C5) · FR-8, FR-9 (P1)
```
┌──────────────────────────────┐
│ Nice work! 🎉                 │
│ Interview Practice           │
│ ┌───────┐ ┌───────┐          │
│ │ 5:12  │ │   5   │          │  duration · questions practised
│ │ mins  │ │ Qs    │          │
│ └───────┘ └───────┘          │
│ 💡 Tip: Use one concrete      │  exactly one tip (dominant language)
│ example when describing your │
│ project.                     │
│ Streak: ●●○  2 of 3 days     │  text + dots (not colour alone)
│ ┌──────────────────────────┐ │
│ │      Practice again      │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ Next: Practise HR        │ │  next activity (FR-9)
│ │ questions →              │ │
│ └──────────────────────────┘ │
│         Back to chat         │
└──────────────────────────────┘
```
- Variants: <30s → "Short session", no streak credit (SU-02); 0 questions → no tip, an encouragement line (SU-03); tip unavailable → tip row hidden (SU-04).

---

## 7. Settings (C6) · FR-4
```
Settings
─────────────────────────────────────
Voice suggestions                [ ● ]   toggle, 48px row
Show a voice practice option when it could help.

Voice speed                    1× ▾
Voice                 English (India) ▾
```
- The toggle takes effect immediately, with the label "On"/"Off" in text; `role="switch"`, `aria-checked`.
- Turning it on clears an active pause (ADR-008).

---

## 8. Copy catalogue (English, v1)
| Key | Text |
|---|---|
| `card.title.mock_interview` | Practice your interview with voice |
| `card.title.spoken_english` | Practice speaking English |
| `card.title.viva_revision` | Practice your viva aloud |
| `card.title.pronunciation` | Practice your pronunciation |
| `card.why` | Speak your answers out loud and get instant feedback on your confidence and accuracy. |
| `card.cta` | Try Voice Practice |
| `card.optout` | Don't suggest voice |
| `card.dismiss.a11y` | Dismiss suggestion |
| `card.headphones` | Tip: use headphones in a shared space. |
| `toast.optout` | Voice suggestions are off. Turn them back on in Settings. |

Hindi strings arrive in Phase 5 (FR-11) after native review. The PRD's default title "Practice with Voice" is the fallback for any intent without its own title.

---

## 9. Sign-off
| Screen | Design owner | Product | Accessibility review |
|---|---|---|---|
| Chat + card | ☐ | ☐ | ☐ |
| Privacy notice | ☐ | ☐ (and Legal, copy) | ☐ |
| Mic denied | ☐ | ☐ | ☐ |
| Voice session | ☐ | ☐ | ☐ |
| Summary | ☐ | ☐ | ☐ |
| Settings | ☐ | ☐ | ☐ |

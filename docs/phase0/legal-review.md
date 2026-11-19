# Legal / Trust & Safety Review Packet (P0.6)

> **For:** Legal and Trust & Safety reviewers.
> **Purpose:** start the long-lead review that **gates internal dogfood** (Phase 8, target sign-off before week 11).
> **Feature:** Smart Voice Suggestions. In a learning chat, a card offers a one-tap voice practice session (mock interview, spoken English, viva revision, pronunciation) for students aged 18–24 in Tier-2/3 India.

---

## 1. What we need from you

| # | Decision requested | Blocks |
|---|---|---|
| L1 | Approve the **first-use privacy line** (draft in §4) in English and Hindi | FR-6, dogfood gate |
| L2 | Approve the **microphone explainer** copy (draft in §4) | FR-7 |
| L3 | Confirm **Groq** (US-based AI inference provider) is acceptable as a processor for query text, chat context, voice transcripts **and short audio clips** (§2–3) | Dogfood gate (architecture §17 #13) |
| L4 | Confirm **transcript retention** for voice sessions (§3) | architecture §17 #9 |
| L5 | Confirm **DPDP Act** notice and consent approach (§5) | NFR privacy |
| L6 | Confirm the approach to **content safety / moderation** for voice sessions (edge-case Q4, still open) | Dogfood gate |
| L7 | Confirm we may use **dogfood queries** (de-identified) to grow the classifier eval set | Phase 8 (P8.2) |

---

## 2. Data flows

| Data | Where it goes | Why | Stored by us? |
|---|---|---|---|
| Typed query + last 2 chat turns | Our server → **Groq** (classifier model) | Decide whether to offer voice practice | Chat messages stored as normal chat history |
| Typed query + conversation | Our server → **Groq** (chat model) | Normal text answer | As above |
| Last ~6 chat turns + practice preset | Our server → **Groq** | Start the voice session in context (assistant speaks first) | No new storage |
| **Audio clip of each spoken turn** | Browser → our server → **Groq Whisper** (speech-to-text) | Transcribe what the learner said | **No.** Audio is never written to disk or database by this feature |
| Transcript of each turn | Our server → **Groq** (coach model) | Generate the spoken reply | Finalized turns stored **only as the Voice Mode policy allows** (L4) |
| Session transcript | Our server → **Groq** (summary model) | One improvement tip + next activity | Summary stored (duration, question count, tip) |
| Reply text → speech | **In the browser** (device text-to-speech) | Speak the reply | Not sent anywhere |
| Analytics events | Our database | Measure the experiment | IDs and enums only. **No query, transcript or audio content** |

## 3. Questions on Groq (L3, L4)
1. Do Groq's terms (data retention, training use, sub-processors, data location) meet our requirements for user text and **audio**?
2. Is a data processing agreement (DPA) in place or needed? Is a zero-retention option available or required?
3. Cross-border transfer: is processing outside India acceptable under our DPDP position?
4. Transcript retention: how long may finalized voice-session turns be kept, and must they be deletable on user request (edge-case ST-07)?

## 4. Draft copy for review (L1, L2)

**First-use privacy line** (shown once before the first voice practice session; FR-6)
| Language | Draft |
|---|---|
| English | "Your voice is turned into text to run this practice. We don't keep the recording. Transcripts are handled under our voice privacy policy." · **[Privacy policy]** · **[Continue]** |
| Hindi | "इस प्रैक्टिस के लिए आपकी आवाज़ को टेक्स्ट में बदला जाता है। हम रिकॉर्डिंग नहीं रखते। ट्रांसक्रिप्ट हमारी वॉइस प्राइवेसी पॉलिसी के तहत संभाले जाते हैं।" · **[प्राइवेसी पॉलिसी]** · **[आगे बढ़ें]** |

**Microphone explainer** (mic blocked; FR-7)
| Language | Draft |
|---|---|
| English | "Voice practice needs your microphone so you can answer out loud. You can allow it in your browser's site settings, or keep going in text." · **[How to allow]** · **[Back to text]** |
| Hindi | "वॉइस प्रैक्टिस के लिए माइक्रोफ़ोन चाहिए ताकि आप बोलकर जवाब दे सकें। आप इसे ब्राउज़र की साइट सेटिंग्स में चालू कर सकते हैं, या टेक्स्ट में जारी रखें।" · **[कैसे चालू करें]** · **[टेक्स्ट पर वापस]** |

**Card text** (FR-2; marketing review only): title per task (e.g. "Practice with Voice"); line: "Speak your answers out loud and get instant feedback on your confidence and accuracy."; button: "Try Voice Practice"; plus "Don't suggest voice" and a headphone tip.

> Copy is a draft from product/engineering, not legal text. Please edit freely. The Hindi drafts need native-speaker review.

## 5. DPDP notice and consent (L5)
- **Notice:** the privacy line (§4) appears before any audio is captured. The policy link explains purpose, processors and retention.
- **Consent:** the mic is requested only after the learner taps **Try Voice Practice** and then **Continue**. Voice is never on by default, and the learner can stop at any time.
- **Choice:** "Don't suggest voice" turns off suggestions immediately; it can be turned back on in Settings.
- **Rights:** access/deletion requests cover voice-session data (sessions, turns, summaries).
- **Age:** the target segment is 18–24. Accounts known to be under 18 do not get suggestions (edge-case SF-06). Please confirm.

## 6. Content safety (L6)
Learners may say harmful things during a session (self-harm, abuse). We propose:
- running the platform's existing moderation on user turns if available; otherwise a moderation model call per turn
- safe-response behaviour from the existing safety policy, and ending the practice framing when triggered

Please confirm the required approach before dogfood.

## 7. Dogfood data use (L7)
During dogfood (staff + student beta panel, with consent), we want to sample de-identified typed queries to label for the classifier eval set. Rows are stripped of personal data (labelling-guidelines §8). Please confirm consent wording for the beta panel.

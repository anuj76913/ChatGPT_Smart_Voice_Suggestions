# Team Demo: Smart Voice Suggestions

> A 10–15 minute click-through of the prototype. Everything runs on your laptop.

## Before the meeting (5 minutes)
1. Start the database: `npm run db:local:start`. First time on this machine: `npm run db:local:init`.
2. Turn on demo mode: `npm run demo:setup`. This switches on suggestions for everyone, all six card languages, the voice preview and quiet mode. `npm run demo:setup -- --off` reverts.
3. Start the app, in one of two ways:
   - `npm run demo`: **real AI answers** (Groq, from `.env`). The free tier allows about 270 chat messages a day across everyone, enough for one demo but not for a room of people all trying it.
   - `npm run demo:offline`: **no internet or key needed**. A built-in fake gives scripted answers, so nothing can rate-limit you mid-demo. Use it as the backup.
4. Open **http://localhost:5173 in Chrome**. Allow the microphone when asked; `localhost` counts as secure. Use headphones if the room is quiet.
5. No sign-in: the app opens straight into a ChatGPT-style chat as an anonymous learner (one per browser). For the dashboard, open **http://localhost:5173/#/admin/analytics** in a second browser profile or incognito window; it signs in as `admin` automatically.

Ctrl+C in the terminal stops everything.

## The story (what to say)
> 7M Bharat Learners use ChatGPT weekly. Most know voice exists, but only ~20% use it, because nothing tells them *when* speaking beats typing. We suggest voice exactly when it helps, in one tap, never slowing the text answer.

## Click-through
| # | Do | Point out |
|---|---|---|
| 1 | The example **"My PM interview is tomorrow. How should I answer 'Tell me about yourself'? I want to practise it."** types itself into the box on a fresh page load: press **Enter** | The text answer streams first, untouched: a real answer on how to structure it. The **card appears below it** as a suggestion, because the learner also wants to practise |
| 2 | Ask a normal question in a **new chat**: "What is normalization in DBMS?" | **No card.** The classifier only suggests voice for practice requests (100% precision in our eval) |
| 3 | On the interview card, tap **▶ Hear a 30-sec preview** | v2 **Voice Preview Mode**: hear what practice sounds like, with captions, **no mic permission needed** |
| 4 | Tap **Start practising** | The first-time privacy notice, then the mic prompt. **The coach speaks first**, using the chat topic. Answer out loud; pause for about 2 seconds or tap **Done speaking** to finish your turn |
| 5 | Open **⚙ Speed / Voice** | Slower/faster and Indian-English/Hindi voice in one tap. **Quiet mode** (v2) is for hostels and libraries: speak softly, softer playback |
| 6 | Answer one or two questions, then tap **✕ End** | The **summary**: time, questions answered, one personalised tip, streak dots, and **Next activity / Practice again / Back to chat** |
| 7 | **Back to chat** | A short recap appears in the conversation |
| 8 | Ask in Hindi: **"कल मेरा इंटरव्यू है, मॉक इंटरव्यू लीजिए"**. Also try Bengali **"কাল আমার ইন্টারভিউ, একটা মক ইন্টারভিউ নিন"**, Marathi **"उद्या माझी मुलाखत आहे, सराव घ्या"** or Telugu **"రేపు నాకు ఇంటర్వ్యూ ఉంది, మాక్ ఇంటర్వ్యూ తీసుకోండి"** | The card copy is in **the learner's language**, and the coach replies in it too. (The regional wording is a draft pending native review) |
| 9 | Tap the **mic button** next to the message box | Voice practice is also available without a card: pick a practice type |
| 10 | On a card: **✕** (dismiss, with Undo) and **"Don't suggest voice"** | User control: 1 card per conversation, a weekly cap, a 14-day pause after 3 dismissals, and opt-out in Settings |
| 11 | In the incognito window: **localhost:5173/#/admin/analytics** | The funnel (eligible → shown → tapped → mic allowed → started → completed), metrics, cost per WAVL, Groq health, alerts. **Everything we'd need for the launch decision** |
| 12 | Optional, live kill switch: `npm run ops:config -- kill --language hi --reason "demo"`, then ask the Hindi query again | Cards in Hindi stop within ~15 s, with no deploy. Undo: `npm run ops:config -- unkill --language hi --reason "demo"` |

## If something goes wrong
| Problem | Fix |
|---|---|
| No card appears | Run `npm run demo:setup` again. A conversation gets at most 1 card, so start a **new chat** (＋) |
| "Too many requests" or answers stop | You hit the Groq free-tier limit: restart with `npm run demo:offline` |
| The coach doesn't hear you | Check Chrome's mic permission (🔒 in the address bar). Speak, then pause about 2 seconds, or tap **Done speaking** |
| The coach seems to answer itself | Its voice is leaking from the speakers into the mic. The app now filters this, but **headphones** remove it completely; or lower the volume |
| No voice coming out | Turn up the volume. Captions always show the text; some PCs lack an Indian English or Hindi voice |
| Port already in use | Close the other `npm run dev`, or restart the machine's node processes |

## What's real vs prototype
- **Real:** streaming chat on Groq, the intent classifier, suggestion rules and caps, the voice loop (Whisper speech-to-text, AI coach, browser speech), summary/tip/streak, analytics, kill switch, accessibility (21 screens pass WCAG 2.2 AA checks).
- **Prototype:**
  - sign-in is a simple dev login
  - regional copy is a machine draft
  - the eval set is synthetic
  - the Groq free tier limits it to a handful of users
  - no A/B test

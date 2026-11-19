# Labelling Guidelines: Voice-Intent Dataset (P0.7)

> For anyone labelling learner queries for the classifier (FR-1). The dataset gates **Phase 2** (≥85% precision on ≥1,000 queries) and the **dogfood gate** in Phase 8.
> Data lives in [`data/intent-eval/`](../../data/intent-eval/). Tools: `npm run dataset:validate`, `npm run dataset:agreement`.

---

## 1. The one question to ask

For each typed query, ask:

> **"Is this learner asking to *practise speaking out loud* on a learning task, right now?"**

- **Yes** → pick the matching voice intent (§2).
- **No, or you're not sure** → `none`.

The card is only useful when speaking really beats typing. A wrong card is the "pushy" failure the PRD warns about (71% of learners prefer typing), so **when in doubt, label `none`**. Precision matters more than recall.

---

## 2. Labels

| Label | Use when the learner wants to… | Typical signals | Examples |
|---|---|---|---|
| `mock_interview` | **be interviewed**: answer interview questions aloud and get feedback (jobs, placements, internships, admissions, UPSC/SSC/bank interviews) | "mock interview", "take my interview", "be my interviewer", "ask me HR questions one by one", "interview ki practice karwa do" | "Take a mock interview for a TCS Ninja fresher role" · "Mujhse interviewer ki tarah sawal poocho" |
| `spoken_english` | **practise speaking English** in conversation and be corrected (fluency, confidence, small talk, role-play) | "talk with me in English", "practise English conversation", "correct my English as I speak", "English bolne ki practice" | "Be my English speaking partner and point out grammar errors" |
| `viva_revision` | **explain a subject aloud or be quizzed orally** on it (viva, oral exam, project defence, teach-back) | "viva", "oral exam", "quiz me orally", "I'll explain X, you ask questions", "examiner ki tarah" | "My DBMS viva is tomorrow, ask me questions on normalization" |
| `pronunciation` | **say words aloud and get pronunciation feedback** (sounds, stress, silent letters, mother-tongue influence) | "pronounce", "how do I say X, let me try", "correct my pronunciation", "v aur w ka farak" | "Check my pronunciation of 'schedule', 'data' and 'vehicle'" |
| `none` | anything else | facts, explanations, lists, writing help, coding, greetings, written quizzes, non-learning tasks | "What are the most common HR interview questions? Just list them" |

---

## 3. Decision rules (apply in order)

1. **Negated or written-only → `none`.** "I don't want to speak, just give notes" or "write the answers for my viva" is `none` (edge-case CL-04).
2. **About the topic, not practising it → `none`.** "What is a viva?", "list HR questions", "TCS interview experience", "IPA symbol for 'th'" are `none` (CL-03).
3. **Written quiz → `none`.** "Generate 20 MCQs on OS" is written, not oral, so `none`. "Quiz me orally" / "ask me one by one so I can answer" is a voice intent.
4. **Non-learning speaking → `none`.** A shop sales pitch or a wedding speech is out of scope (PRD non-goal; CL-13).
5. **About the voice feature itself → `none`.** "How do I turn on voice mode?" (CL-12).
6. **Two voice intents in one query → pick the main ask.** "Mock interview and fix my pronunciation" → `mock_interview`, the first and main ask (CL-08). Add a note.
7. **Interview + English:** "practise English for my interview" → `spoken_english` if the focus is fluency; `mock_interview` if they want interview questions asked.
8. **Explain + quiz:** "Explain normalization" is `none`. "I'll explain normalization, then quiz me" is `viva_revision`.
9. **Short keyword queries** ("interview", "pronunciation", "viva questions on DBMS") don't make the practise intent explicit, so they go in the **ambiguous set** as `none` (§4).

---

## 4. Main set vs ambiguous set

| Set | What goes in it | Gold label | Expected product behaviour |
|---|---|---|---|
| `main` | Queries where the intent is clear after applying §3 | The intent, or `none` | Card shown only for voice intents above threshold |
| `ambiguous` | Queries where a reasonable person can't tell whether the learner wants to practise aloud (PRD example: "explain interview questions for testers"; short keyword queries; "how to prepare for HR interview") | **Always `none`** | **No card**: the PRD rule "show the card only above the confidence threshold" |

The validator rejects an ambiguous-set row with any label other than `none`.

---

## 5. File format (JSONL, one row per line)

```json
{"id":"seed-0001","text":"Take a mock interview for a TCS Ninja fresher role","language":"en","label":"mock_interview","set":"main","source":"synthetic_seed","labeler":"claude-seed","reviewed":false}
```

| Field | Values | Notes |
|---|---|---|
| `id` | lowercase, digits, dashes | Unique and stable; never reuse an id |
| `text` | the query exactly as typed | Keep typos and mixed scripts; **remove names, phone numbers, emails, roll numbers** |
| `language` | `en`, `hinglish`, `hi`, `other` | `hinglish` = Hindi words in Latin script mixed with English. `hi` = Devanagari. v1 scope is `en` + `hinglish` |
| `label` | `mock_interview`, `spoken_english`, `viva_revision`, `pronunciation`, `none` | |
| `set` | `main`, `ambiguous` | §4 |
| `source` | `synthetic_seed`, `survey`, `dogfood`, `manual` | Where the query came from |
| `labeler` | your labeller ID | Not your real name |
| `reviewed` | `true` / `false` | `true` only after a human has checked this row |
| `notes` | optional | Why a tricky row got its label |

---

## 6. Process

1. **Calibrate:** two labellers independently label the same 100 rows. Run `npm run dataset:agreement -- a.jsonl b.jsonl`. Target **Cohen's kappa ≥ 0.80**. Discuss every disagreement and update these rules if a pattern appears.
2. **Label:** once calibrated, label individually. **Double-label 20%** of every new batch and keep kappa ≥ 0.80.
3. **Adjudicate:** a third person (product or ML owner) decides disagreements; record the reason in `notes`.
4. **Validate** before every merge: `npm run dataset:validate` (schema, duplicates, counts). CI runs it too.
5. **Balance targets** for the ≥1,000-row main set (guidance, not hard rules):
   - ~40% `none`, including at least half **hard negatives** (interview/English/viva-*adjacent* but not practice)
   - ~15% each for the four voice intents
   - ~45% English, ~55% Hinglish
6. **Ambiguous set:** keep growing it (target ≥100 rows by Phase 2).

---

## 7. Seed data (current status)

`data/intent-eval/seed.jsonl` holds **200 synthetic seed rows** (170 main, 30 ambiguous), written to cover every rule above, including hard negatives, negations, greetings and out-of-scope items. They are a **starting point, not ground truth**: all are `reviewed: false` until a labeller checks them. Real queries (survey follow-ups, then dogfood) must make up most of the final dataset, because synthetic text is cleaner than real learner typing.

## 8. Privacy
- Use real queries only with consent and as the policy allows (see legal-review.md).
- Strip personal data before adding a row.
- Never paste dataset rows into analytics, tickets or chat tools outside the team.

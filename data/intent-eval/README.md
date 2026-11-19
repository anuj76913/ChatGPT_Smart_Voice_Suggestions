# Intent eval dataset

Labelled learner queries for the voice-intent classifier (FR-1). Labelling rules: [docs/phase0/labelling-guidelines.md](../../docs/phase0/labelling-guidelines.md).

| File | Contents |
|---|---|
| `private/dogfood.jsonl` | **Phase 8, git-ignored:** real dogfood queries from consenting participants, labelled by people (`npm run dataset:label`). Personal data: restricted storage only. Included in the eval automatically when present |
| `seed.jsonl` | 280 **synthetic seed** rows: 200 in English and Hinglish (170 main, 30 ambiguous) plus, since Phase 10, 20 each in Hindi, Bengali, Marathi and Telugu (16 main, 4 ambiguous). Starting point only: `reviewed: false` until a human labeller checks each row |

- Validate: `npm run dataset:validate` (add `-- --gate` to check the Phase 2 targets).
- Agreement between two labellers: `npm run dataset:agreement -- a.jsonl b.jsonl`.
- Phase 2 target: ≥1,000 human-reviewed main-set rows (English + Hinglish) plus the ambiguous set.
- Never add personal data. Strip names, phone numbers and emails from real queries before adding them.

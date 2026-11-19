# Groq Setup (P0.5)

> Steps to finish the Groq part of Phase 0. Steps 1–4 need a person with access to the Groq console; step 5 verifies everything from this repo.

## Checklist
- [ ] **1. Organisation.** Create (or join) the team's Groq organisation at console.groq.com. Use a team account, not a personal one, so keys and billing survive people changes.
- [ ] **2. One project and key per environment.**

  | Environment | Key name (suggested) | Stored in |
  |---|---|---|
  | local / dev | `svs-dev` | each developer's repo-root `.env` (git-ignored) |
  | staging | `svs-staging` | staging secret store (ADR-009, hosting still open) |
  | production | `svs-prod` | production secret store |

  Separate keys let you revoke one environment without touching the others (edge-case LLM-12), and keep usage and rate limits apart.
- [ ] **3. Rate-limit tier (architecture §17 #14).** Note the org's requests-per-minute and tokens-per-minute limits for each model in the table below. Phase 7 (P7.6) compares them with projected traffic before dogfood.

  | Model | Use case | RPM | TPM | Notes |
  |---|---|---|---|---|
  | `openai/gpt-oss-120b` | chat, coach, summary, classifier fallback | | | |
  | `openai/gpt-oss-20b` | classifier, opening line, fallbacks | | | |
  | `whisper-large-v3-turbo` | STT | | | audio seconds/hour limit too |
- [ ] **4. Local key.** `cp .env.example .env`, then paste the dev key into `GROQ_API_KEY`. Never commit `.env`; never paste a key into a ticket, chat or doc.
- [ ] **5. Verify from the repo:**
  ```bash
  npm run groq:check            # key works, all configured models exist, strict-JSON classifier smoke test
  npm run groq:check -- --no-smoke   # same, without the (tiny, billable) test completion
  ```
  Expected output ends with `✔ Groq setup looks good.`

## What `groq:check` verifies
1. The key is accepted (`GET /models`). A 401 means the key is wrong or revoked.
2. Every model ID in [`packages/shared/src/config.ts`](../../packages/shared/src/config.ts) (LLM primaries, fallbacks and the Whisper models) exists and is active for this key.
3. A strict `json_schema` call on the classifier model (`openai/gpt-oss-20b`) returns valid JSON with `intent=mock_interview` for a clear Hinglish interview query. This confirms the structured-output path the classifier depends on (architecture §6.7.2).

If a model is reported **MISSING** or **INACTIVE**, check the Groq models page. Pick a replacement **production** model, update `config.ts`, and note it in [decisions.md](../decisions.md). Classifier model changes need the Phase 2 eval re-run (architecture §14).

## Models in use (from config)
| Use case | Primary | Fallback |
|---|---|---|
| Chat answer | `openai/gpt-oss-120b` | `openai/gpt-oss-20b` |
| Intent classifier | `openai/gpt-oss-20b` (strict `json_schema`) | `openai/gpt-oss-120b` (strict `json_schema`) |
| Coach replies | `openai/gpt-oss-120b` | `openai/gpt-oss-20b` |
| Opening line | `openai/gpt-oss-20b` | static template |

> The Llama models first proposed are Enterprise-tier on Groq and weren't available to the project key, so all use cases run on the production `gpt-oss` models (decisions.md ADR-004 update). `gpt-oss` reasons before answering; config sets `reasoningEffort` per use case.
| Session summary | `openai/gpt-oss-120b` (strict `json_schema`) | `openai/gpt-oss-20b` |
| Speech-to-text | `whisper-large-v3-turbo` | `whisper-large-v3` |

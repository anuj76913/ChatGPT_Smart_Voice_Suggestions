# Security Review (P7.4)

> The review of the MVP's server and web client against the plan's checklist. Automated checks live in [apps/server/test/hardening.test.ts](../../apps/server/test/hardening.test.ts). Sign-off by a security reviewer is still needed (see the open items).

## Checklist
| Item | Status | How |
|---|---|---|
| Provider keys only server-side, never logged | ✅ | The Groq key lives only in the server env (`.env`, git-ignored). A test runs chat (incl. a Groq failure), a card and a voice turn with a canary key and asserts it's absent from **every log line** and from the events / metering / decision / suggestion / alert / session tables. The web bundle never sees it (the browser talks only to our API) |
| Auth on every endpoint | ✅ | A route-inventory test calls **every registered route** without a session and expects 401, except the public `GET /healthz`, `GET /readyz`, `POST /v1/auth/dev-login`, `POST /v1/auth/logout`. Admin routes also check `ADMIN_USERS` (403) |
| Per-user rate limiting | ✅ | See the table below. New in Phase 7: **spoken turns per voice session** (`voice.maxTurnsPerMinute`, 15), because each turn costs a Whisper and a coach call |
| Voice stream tokens short-lived and scoped | ✅ | HMAC token, 5 minutes, bound to session + user, **plus** the session cookie (Phase 4, edge-case SEC-05) |
| Session revocation | ✅ new | The cookie holds `user id + epoch`. **Logout bumps the epoch**, so a copied cookie stops working everywhere (tested). Old plain-id cookies are rejected, so users sign in once more after this release |
| Cross-site requests | ✅ new | Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in staging/production. **Origin check:** state-changing requests and WebSocket upgrades from a foreign `Origin` get 403 (tested); same-origin and `WEB_ORIGIN` are allowed |
| Security headers | ✅ new | Every response sends `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `CORP: same-origin`. API responses add `Cache-Control: no-store`, and staging/production add HSTS. The web build ships a **Content-Security-Policy** (`script-src 'self'`, no inline scripts; the production build passed the full browser walkthrough under it) |
| Errors don't leak internals | ✅ new | 5xx → `{"error":"internal_error"}` (details only in the server log); 4xx → a short code, never parser or database text (tested with broken JSON and a missing table) |
| TLS everywhere | 🟡 host | The app sets `Secure` cookies and HSTS outside local/test. **TLS termination is the hosting layer's job; hosting is still undecided (ADR-009).** The host must also send `Content-Security-Policy: frame-ancestors 'none'` as a header (a meta CSP can't) |
| Input limits | ✅ | JSON body ≤ 64 KB (events ≤ 256 KB), chat message ≤ the configured max, audio clip ≤ 4 MB and ≤ 90 s, event props typed and ≤ 64 chars (Phase 6 catalogue) |
| Secrets in the repo | ✅ | `.env` is git-ignored and `.env.example` has no values. Git has no commits yet, so no history to scrub |

## Rate limits
| Route | Limit | Key |
|---|---|---|
| `POST /v1/auth/dev-login` | 10/min | IP |
| `POST /v1/conversations/:id/messages` (chat) | 20/min | user |
| `POST /v1/events` | 60/min | user |
| Suggestion actions (dismiss, tap, prefs) | 60/min | user |
| `POST /v1/voice/sessions` | 10/min | user (and one live session per user) |
| Spoken turns | 15/min, one at a time | voice session |
| Admin analytics | 30/min | user |

The rate limiter is **in memory**, so it's per server instance. Running more than one instance needs a shared store (bug bash BB-14).

## Open items (need a decision or a person)
- **Authentication is dev login** (ADR-010): anyone who can reach the server can sign in as any handle. That's acceptable on a private network for internal dogfood, but it's **a P0 before any public deployment** (BB-13). Real sign-in has to replace `registerAuth`; only `authenticate` reads the cookie.
- A security reviewer should sign off this document (P7.4 exit criterion).
- Dependency audit: `npm audit` on CI is not set up yet.

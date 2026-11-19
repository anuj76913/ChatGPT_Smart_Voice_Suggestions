# Deploying: API on Railway, web app on Vercel

```
Browser ──https──▶ Vercel (React app)
   │                  └─ /v1/*  is forwarded (rewrite) ──▶ Railway API ──▶ Railway PostgreSQL
   └──wss (voice)────────────────────────────────────────▶ Railway API ──▶ Groq
```

- **Vercel** serves the web app and forwards every `/v1/...` request to Railway. To the browser it is one site, so
  the sign-in cookie just works.
- **The voice WebSocket** goes straight to Railway, because Vercel can't forward WebSockets. The browser has no
  cookie there, so the server accepts the short-lived signed stream token instead (`VOICE_WS_TOKEN_ONLY=true`).
  The token is only given to the signed-in owner of a session and expires after 5 minutes.
- Pushing to `main` on GitHub redeploys both automatically.

Time: about 15 minutes. You need a Railway account, a Vercel account and your Groq API key.

## 1. Railway: API and database

1. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → pick
   `ChatGPT_Smart_Voice_Suggestions`. Railway reads `railway.json` (build, start command, health check).
2. In the project: **+ Create** → **Database** → **PostgreSQL**.
3. Open the API service → **Variables** → add:

   | Variable | Value |
   |---|---|
   | `APP_ENV` | `staging` (secure cookies; keeps the no-password demo sign-in on) |
   | `HOST` | `0.0.0.0` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway fills it in) |
   | `GROQ_API_KEY` | your Groq key (only here, never in git) |
   | `SESSION_SECRET` | 64 random characters: run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `ADMIN_USERS` | a **private** admin name only you know, e.g. `anuj-admin-7k2p` (not `admin`: the site is public) |
   | `MIGRATE_ON_START` | `true` |
   | `APPLY_DEMO_CONFIG` | `true` (suggestions on for everyone, all six languages, voice preview, quiet mode) |
   | `VOICE_WS_TOKEN_ONLY` | `true` |
   | `WEB_ORIGIN` | `https://example.com` for now; set your Vercel URL in step 3 |

   `PORT` is set by Railway; don't add it.
4. API service → **Settings** → **Networking** → **Generate Domain**. You get something like
   `https://svs-api-production.up.railway.app`.
5. Check it: open `https://<your-railway-domain>/readyz`. You should see `"database":"ok"` and `"groq":"ok"`.

## 2. Vercel: web app

1. In `vercel.json`, replace `YOUR-RAILWAY-API.up.railway.app` (2 places) with your Railway domain, then commit and
   push. (Vercel can't read environment variables in rewrites, so the address lives in this file.)
2. [vercel.com](https://vercel.com) → **Add New** → **Project** → import the same GitHub repo. Keep the **Root
   Directory** as the repo root: `vercel.json` sets the install, build and output folder.
3. **Environment Variables** → add `VITE_VOICE_WS_URL` = `wss://<your-railway-domain>` (note `wss://`).
4. **Deploy**. You get `https://<your-app>.vercel.app`.

## 3. Connect them

Back in Railway → API service → **Variables** → set `WEB_ORIGIN` to your Vercel URL, e.g.
`https://chat-gpt-smart-voice-suggestions.vercel.app`. To also allow a preview URL, add it after a comma. Railway
redeploys by itself.

## 4. Check

- Open the Vercel URL in Chrome. The example prompt types itself in; press **Enter**. The answer streams, and the
  voice card appears under it.
- **Try Voice Practice**: allow the mic. The coach speaks first; answer and pause, and it replies.
- Analytics dashboard: open `https://<your-app>.vercel.app/?admin=<your ADMIN_USERS name>#/admin/analytics` once.
  The admin name is never built into the public site; without this private link the dashboard URL is just the chat.

## Good to know

- **Anyone with the link can use it**, and all use counts against your Groq free tier (about 270 chat messages a
  day across everyone). Share the link with your team, not publicly.
- **Sign-in is anonymous** (one random learner per browser). It is a prototype, not real accounts.
- **Demo config**: `APPLY_DEMO_CONFIG` only acts on a fresh database, so changes you make later (kill switch,
  `ops:config`) survive restarts.
- **Costs**: Vercel Hobby is free. Railway gives trial credit, then the Hobby plan (about $5 a month) covers a small
  API and database.

## If something goes wrong

| Problem | Fix |
|---|---|
| The page says "Can't reach the server" | Check `https://<railway-domain>/readyz`, and that `vercel.json` has the right Railway domain (then push) |
| Buttons fail with `forbidden_origin` | `WEB_ORIGIN` on Railway must exactly match the Vercel URL you opened (https, no trailing path) |
| Voice says "Connection lost" right away | `VITE_VOICE_WS_URL` (Vercel, then redeploy) must be `wss://<railway-domain>`, and `VOICE_WS_TOKEN_ONLY=true` on Railway |
| No suggestion card | The database had config before `APPLY_DEMO_CONFIG`: run `npm run demo:setup` with `DATABASE_URL` set to Railway's **public** database URL |
| Railway build fails on Node | The repo needs Node 22 (`.nvmrc`); set the Railway variable `NIXPACKS_NODE_VERSION=22` or `RAILPACK_NODE_VERSION=22` if it picked an older one |

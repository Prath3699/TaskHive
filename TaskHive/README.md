# TaskHive

Multi-user issue tracker and team task management: a vanilla-JS single-page app (`index.html`, `app.js`,
`styles.css`) served by a dependency-light Node.js backend (`server.js`) using **normalized SQLite tables**
(`better-sqlite3`) with per-workspace data isolation, cookie sessions, and rate-limited auth.

## Authentication (real, multi-user)
- `#/signup` / `#/login` pages (dark theme). Passwords hashed with scrypt; never stored in plain text.
- Session = random token in an **httpOnly, SameSite=Lax cookie** (Secure in production). No tokens in localStorage.
- `GET /api/auth/me` restores the session on load; unauthenticated hash routes redirect to `#/login`.
- Rate limiting on `/api/auth/*` (429 + `Retry-After`), security headers (CSP, X-Frame-Options, …), CORS allowlist.
- Every data route requires login (401 otherwise) and is scoped to your workspace; cross-workspace ids 404.
- **"Try the demo workspace"** button logs into a shared, resettable demo account (read-only for guests);
  `POST /api/auth/demo/reset` restores pristine demo data. New signups get an empty workspace
  (optionally seeded with sample data via a checkbox).
- Trial banner ("N days left") is computed from your real workspace `created_at` (14-day trial).

## Environment variables (see `.env.example`)
| Var | Purpose |
|---|---|
| `PORT` | server port (Render injects it) |
| `TASKHIVE_DATA_DIR` | where `taskhive.db` lives (default `./data`) |
| `TASKHIVE_COOKIE_SECURE` | set `1` in production so the session cookie is HTTPS-only |
| `TASKHIVE_TRUST_PROXY` | set `1` behind Render/Netlify HTTPS proxy (needed for Secure cookies + correct client IP for rate limiting) |
| `TASKHIVE_ALLOWED_ORIGINS` | comma-separated CORS allowlist (same-origin works without it) |
| `TASKHIVE_DEMO_PASSWORD` | password for the seeded demo accounts — **change this in production** |
| `TASKHIVE_SEED_DEMO` | set `0` to skip seeding the demo workspace |

Note: this build intentionally uses SQLite, not Postgres — Render's free Postgres expires after 30 days.
`DATABASE_URL` is ignored.

## Run locally
    npm install
    cp .env.example .env      # optional; sensible defaults exist
    npm start                 # http://localhost:3000
    # demo login: parth@catlas.inc / password   (or click "Try the demo workspace")

## Tests
    npm start &               # server on :3000
    ./test_api.sh             # auth, sessions, rate limit, data-isolation smoke tests

## Deploy (Render, free plan)
`render.yaml` is a Blueprint: Render > New + > Blueprint > pick this repo > Apply.
One service serves both the frontend and `/api`. Health check: `/api/health`.

Manual steps in the Render dashboard after first deploy:
1. **Set `TASKHIVE_DEMO_PASSWORD`** to a real secret (the committed placeholder is not one).
2. Keep `TASKHIVE_COOKIE_SECURE=1` and `TASKHIVE_TRUST_PROXY=1` (already in `render.yaml`).
3. Optionally set `TASKHIVE_ALLOWED_ORIGINS=https://taskhive-4vsl.onrender.com`.

The free plan has no persistent disk, so the database resets on redeploy/spin-down (demo data is
re-seeded; new signups must re-register). For persistence upgrade to `plan: starter` and add the
disk settings shown in the comments at the bottom of `render.yaml`.

## Layout
    server.js, app.js, index.html, styles.css   application source
    .env.example                                 documented environment variables
    package.json, package-lock.json             dependencies (must stay at the repo root)
    render.yaml / vercel.json / netlify.toml    deployment configs
    public/, build-netlify.mjs, netlify/        static copy + function for Netlify/Vercel hosting
                                                (run `node build-netlify.mjs` after editing the SPA)
    test_api.sh                                 API smoke tests (`npm run test:api`, server on :3000)
    dev-tools/                                  debug, e2e and screenshot scripts (need Playwright)
    docs/                                       design/spec PDF
    data/                                       runtime SQLite database (gitignored)

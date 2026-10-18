# TaskHive

Issue tracker and team task management: a vanilla-JS single-page app (`index.html`, `app.js`,
`styles.css`) served by a dependency-light Node.js backend (`server.js`, SQLite via `better-sqlite3`).

## Run locally
    npm install
    npm start            # http://localhost:3000   (demo login: parth@catlas.inc / password)

## Deploy (Render, free plan)
`render.yaml` is a Blueprint: Render > New + > Blueprint > pick this repo > Apply.
One service serves both the frontend and `/api`. Health check: `/api/health`.
The free plan has no persistent disk, so data resets on restart; see the comments in `render.yaml`
for the paid-plan disk settings. **Change the admin password in Settings after the first login.**

## Layout
    server.js, app.js, index.html, styles.css   application source
    package.json, package-lock.json             dependencies (must stay at the repo root)
    render.yaml / vercel.json / netlify.toml    deployment configs
    public/, build-netlify.mjs, netlify/        static copy + function for Netlify/Vercel hosting
    test_api.sh                                 API smoke tests (`npm run test:api`, server on :3000)
    dev-tools/                                  debug, e2e and screenshot scripts (need Playwright)
    docs/                                       design/spec PDF

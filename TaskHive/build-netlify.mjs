#!/usr/bin/env node
/* Build script for Netlify: copies the SPA (index.html, app.js, styles.css)
 * into ./public so it can be served as static assets alongside the API
 * function. Run automatically via [build] command in netlify.toml. */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('public', { recursive: true });
for (const f of ['index.html', 'app.js', 'styles.css']) {
  cpSync(f, `public/${f}`);
}
// favicon-ish placeholder + meta robots
writeFileSync('public/robots.txt', 'User-agent: *\nDisallow: /api/\n');
console.log('Netlify build: copied SPA assets to public/');

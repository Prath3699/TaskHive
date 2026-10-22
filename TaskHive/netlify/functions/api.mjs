/* TaskHive — Netlify Function entry (ESM)
 * Wraps the CommonJS backend (server.js) as a serverless handler.
 * Persistence: Netlify Blobs store ("taskhive") holds the JSON document, so
 * data survives cold starts and redeploys. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.TASKHIVE_NO_LISTEN = '1';
process.env.TASKHIVE_COOKIE_SECURE = '1';   // always HTTPS on *.netlify.app

const { getStore } = require('@netlify/blobs');
const core = require('../../server.js');     // { handleApi, readBody, loadDbAsync, flushSaves }

let blobsReady = false;
function kvAdapter(siteStore) {
  return {
    get: async (key) => {
      try { return await siteStore.get(key); } catch (_) { return null; }
    },
    put: async (key, value) => { await siteStore.set(key, value); },
  };
}

export default async function handler(req) {
  /* CORS for any origin that isn't the same site (dev/preview convenience). */
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);

  try {
    const siteStore = getStore({ name: 'taskhive' });
    await core.loadDbAsync(kvAdapter(siteStore));
    blobsReady = true;
  } catch (e) {
    console.error('blob store unavailable:', e.message);
  }

  const method = req.method;
  let bodyObj = {};
  if (method !== 'GET' && method !== 'HEAD') {
    const text = await req.text().catch(() => '');
    if (text) { try { bodyObj = JSON.parse(text); } catch (_) { bodyObj = {}; } }
  }

  const fakeReq = {
    method,
    url: req.url,
    headers: Object.fromEntries(req.headers),
    _body: bodyObj,
    on() {}, destroy() {},
  };
  const fakeRes = {
    statusCode: 200, headers: {}, body: '', ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, hdrs = {}) { this.statusCode = status; Object.assign(this.headers, hdrs); },
    end(payload) { if (payload !== undefined) this.body = String(payload); this.ended = true; },
  };

  try {
    await core.handleApi(fakeReq, fakeRes, url);
  } catch (e) {
    fakeRes.statusCode = 500;
    fakeRes.headers['Content-Type'] = 'application/json';
    fakeRes.body = JSON.stringify({ error: e.message });
  }

  if (blobsReady) { try { await core.flushSaves(); } catch (e) { console.error('flush failed:', e.message); } }

  const headers = new Headers(cors);
  for (const [k, v] of Object.entries(fakeRes.headers)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x)); else headers.set(k, v);
  }
  return new Response(fakeRes.body || null, { status: fakeRes.statusCode, headers });
}

#!/usr/bin/env node
/* Issue Tracker Dashboard — backend server
 * Zero-dependency Node.js server:
 *   - Serves the static frontend (index.html, app.js, styles.css, ...)
 *   - Exposes a JSON REST API under /api/* backed by a persistent JSON file (data/db.json)
 *
 * Run:  node server.js [port]     (default port 3000)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

/* ------------------------------------------------------------------ */
/* Netlify serverless entry (deploy/netlify.mjs)                      */
/* ------------------------------------------------------------------ */
/* When required as a module (e.g. by the Netlify Function wrapper), we skip
 * the local HTTP server bootstrap and expose only the pure API handler +
 * the durable-storage adapter hooks. All persistence on Netlify goes through
 * an injected KV store (Netlify Blobs) instead of SQLite/filesystem, since
 * serverless disk is read-only/ephemeral. */
const IS_MODULE = !!process.env.TASKHIVE_NO_LISTEN;
let kv = null; // { get(key):Promise<string|null>, put(key,val):Promise<void>, del?(key) }
function setKV(store) { kv = store; }

/* Durable storage location. On Render's free tier the container filesystem is
 * ephemeral, so render.yaml mounts a persistent Disk at /var/data and sets
 * TASKHIVE_DATA_DIR accordingly. Locally it defaults to ./data. */
const DATA_DIR = process.env.TASKHIVE_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');   // fallback store (no SQLite driver)
const SQLITE_FILE = path.join(DATA_DIR, 'taskhive.db'); // durable store (Phase 4)
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

/* ------------------------------------------------------------------ */
/* Storage layer (SQLite-backed with JSON-file fallback)               */
/* ------------------------------------------------------------------ */

let sqlite = null;
if (!IS_MODULE) try {
  const Driver = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sqlite = new Driver(SQLITE_FILE);
  sqlite.pragma('journal_mode = WAL');   // crash-safe durability
} catch (e) {
  sqlite = null;                          // driver unavailable → atomic JSON fallback
}

/* Phase 4 — credential hardening: passwords are stored as salted scrypt
 * hashes (never plaintext). The demo accounts all share the password
 * "password". */
const DEMO_PASSWORD = 'password';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `sc$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith('sc$')) {           // legacy plaintext entry — migrate on first login
    const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
    return crypto.timingSafeEqual(digest(pw), digest(stored)) ? 'migrate' : false;
  }
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const a = Buffer.from(hashHex, 'hex');
  const b = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), a.length, SCRYPT_PARAMS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seedData() {
  const people = [
    { id: 'p1', name: 'Parth Sharma', initials: 'PT', color: '#43b3ff', email: 'parth@catlas.inc',   password: hashPassword(DEMO_PASSWORD), role: 'admin' },
    { id: 'p2', name: 'David Lee',    initials: 'DL', color: '#ffa575', email: 'david@catlas.inc',   password: hashPassword(DEMO_PASSWORD) },
    { id: 'p3', name: 'Maya Chen',    initials: 'MC', color: '#7b60ff', email: 'maya@catlas.inc',    password: hashPassword(DEMO_PASSWORD) },
    { id: 'p4', name: 'Alex Kim',     initials: 'AK', color: '#3eb957', email: 'alex@catlas.inc',    password: hashPassword(DEMO_PASSWORD) },
    { id: 'p5', name: 'Sara Noor',    initials: 'SN', color: '#db672d', email: 'sara@catlas.inc',    password: hashPassword(DEMO_PASSWORD) },
  ];

  const projects = [
    { id: 'q3-plan',        name: 'Q3 Plan',           desc: 'Product roadmap & delivery plan for Q3', members: ['p1','p2','p3','p4','p5'] },
    { id: 'website-redesign', name: 'Website Redesign', desc: 'New marketing site and design system',   members: ['p1','p2','p3','p4'] },
    { id: 'mobile-app-v2',  name: 'Mobile App v2.0',   desc: 'Feature parity with web + offline mode', members: ['p1','p2','p3','p4','p5'] },
    { id: 'api-docs',       name: 'API Documentation', desc: 'Public developer docs refresh',          members: ['p2','p3','p5'] },
    { id: 'customer-portal',name: 'Customer Portal',   desc: 'Self-service dashboard for clients',     members: ['p1','p3','p4','p5'] },
    { id: 'internal-tools', name: 'Internal Tools',    desc: 'Admin utilities and ops automation',     members: ['p4'] },
  ];

  const mk = (id, name, progress, urgency, assignee, comments, project, idx) => ({
    id, name, progress, urgency, assignee, comments: comments || 0, project: project || 'q3-plan',
    idx, createdAt: new Date().toISOString(),
  });

  /* The 15 design-mockup tasks (idx 0-14) live in the Q3 Plan project; two extra
     "On hold" tasks exercise the fifth status bucket. */
  const tasks = [
    mk('TSK-8',  'Improve Navigation & Menu Organization', 'Ongoing',   'Moderate', 'p3', 0, 'q3-plan', 0),
    mk('TSK-20', 'Enhance Search Functionality',           'Completed', 'Critical', 'p2', 6, 'q3-plan', 1),
    mk('TSK-22', 'Dark Mode Implementation',               'In review', 'Minor',    'p1', 0, 'q3-plan', 2),
    mk('TSK-6',  'Optimize Mobile Responsiveness',         'Ongoing',   'Moderate', 'p4', 0, 'q3-plan', 3),
    mk('TSK-6b', 'Redesign Checkout Flow',                 'Ongoing',   'Critical', 'p5', 0, 'q3-plan', 4),
    mk('TSK-10', 'Speed Optimization for Home Page',       'Ongoing',   'Critical', 'p2', 0, 'q3-plan', 5),
    mk('TSK-40', 'Reduce Load Time for Large Data Sets',   'Pending',   'Minor',    'p3', 0, 'q3-plan', 6),
    mk('TSK-12', 'Optimize Image Compression for Faster Loading', 'In review', 'Moderate', 'p1', 0, 'q3-plan', 7),
    mk('TSK-18', 'Introduce AI-powered Task Prioritization', 'Completed', 'Moderate', 'p4', 4, 'q3-plan', 8),
    mk('TSK-12b','Multi-language Support Implementation',  'Completed', 'Critical', 'p5', 1, 'q3-plan', 9),
    mk('TSK-12c','Missing Tooltip on Product Images',      'Completed', 'Moderate', 'p2', 0, 'q3-plan', 10),
    mk('TSK-22b','Integrate Third-party Calendar Sync',    'Completed', 'Critical', 'p3', 4, 'q3-plan', 11),
    mk('TSK-14', 'Enhance User Authentication with 2FA',   'Pending',   'Minor',    'p1', 0, 'q3-plan', 12),
    mk('TSK-27', 'GDPR Compliance Updates',                'Pending',   'Minor',    'p4', 0, 'q3-plan', 13),
    mk('TSK-18b','Data Encryption for Sensitive Information', 'In review', 'Minor', 'p5', 3, 'q3-plan', 14),
    mk('TSK-31', 'Vendor Contract Renewal Review',         'On hold',   'Minor',    'p2', 0, 'q3-plan', 15),
    mk('TSK-33', 'Legacy Data Migration Assessment',       'On hold',   'Moderate', 'p5', 0, 'q3-plan', 16),
  ];

  /* Seed a few tasks into the other projects so their boards aren't dead ends */
  let seedIdx = 500;
  ['website-redesign', 'mobile-app-v2', 'api-docs', 'customer-portal', 'internal-tools'].forEach((pid, pi) => {
    const owners = [people[pi % people.length].id, people[(pi + 2) % people.length].id];
    const pName = projects.find(p => p.id === pid).name;
    [`Kick-off & scope “${pName}”`, `Define success metrics for ${pName}`].forEach((n, ni) => {
      tasks.push(mk(
        'TSK-' + (50 + pi * 2 + ni), n,
        ni === 0 ? 'Ongoing' : 'Pending',
        ['Moderate', 'Minor', 'Critical'][pi % 3],
        owners[ni], 0, pid, seedIdx++));
    });
  });

  const now = Date.now();
  const inbox = [
    { id: 'inbox-1', who: 'David Lee',    initials: 'DL', color: '#ffa575', text: 'mentioned you in “Enhance Search Functionality”',            ago: 10 * 60e3,      task: 'TSK-20',  unread: true  },
    { id: 'inbox-2', who: 'Parth Sharma', initials: 'PT', color: '#43b3ff', text: 'assigned you “Dark Mode Implementation”',                    ago: 32 * 60e3,      task: 'TSK-22',  unread: true  },
    { id: 'inbox-3', who: 'Maya Chen',    initials: 'MC', color: '#7b60ff', text: 'completed “Introduce AI-powered Task Prioritization”',       ago: 60 * 60e3,      task: 'TSK-18',  unread: true  },
    { id: 'inbox-4', who: 'Alex Kim',     initials: 'AK', color: '#3eb957', text: 'commented on “Optimize Mobile Responsiveness”',              ago: 3 * 3600e3,     task: 'TSK-6',   unread: false },
    { id: 'inbox-5', who: 'Sara Noor',    initials: 'SN', color: '#db672d', text: 'requested review of “Data Encryption for Sensitive Information”', ago: 26 * 3600e3, task: 'TSK-18b', unread: false },
    { id: 'inbox-6', who: 'David Lee',    initials: 'DL', color: '#ffa575', text: 'changed urgency of “Redesign Checkout Flow” to Critical',    ago: 28 * 3600e3,    task: 'TSK-6b',  unread: false },
    { id: 'inbox-7', who: 'Parth Sharma', initials: 'PT', color: '#43b3ff', text: 'shared the project “Q3 Plan” with you',                      ago: 48 * 3600e3,    task: null,    unread: false },
  ].map(it => ({ ...it, at: new Date(now - it.ago).toISOString() }));

  const channelMessages = {
    engineering: [
      { who: 'Alex Kim',  initials: 'AK', color: '#3eb957', text: 'Deployed build #482 to staging — search latency down 30%.', time: '09:12' },
      { who: 'Maya Chen', initials: 'MC', color: '#7b60ff', text: 'Nice! Any regressions on the nav menu task (TSK-8)?',       time: '09:15' },
      { who: 'Alex Kim',  initials: 'AK', color: '#3eb957', text: 'None so far. QA signed off on mobile responsiveness too.',  time: '09:18' },
    ],
    docs: [
      { who: 'Parth Sharma', initials: 'PT', color: '#43b3ff', text: 'PRD.docx updated with the new accessibility section.', time: '11:02' },
      { who: 'David Lee',    initials: 'DL', color: '#ffa575', text: 'I’ll add the API examples before Friday.',             time: '11:20' },
    ],
    teams:       [{ who: 'Sara Noor', initials: 'SN', color: '#db672d', text: 'Reminder: retro at 4 pm in the big room.', time: '10:00' }],
    initiatives: [{ who: 'David Lee', initials: 'DL', color: '#ffa575', text: 'Q3 initiative tracker is live — see the Q3 Plan project.', time: '08:45' }],
    'active-sprint': [
      { who: 'Maya Chen', initials: 'MC', color: '#7b60ff', text: 'Standup notes: TSK-20 done, TSK-22 in review.',        time: '09:30' },
      { who: 'Alex Kim',  initials: 'AK', color: '#3eb957', text: 'Blocker: need designs for the checkout flow revamp.',  time: '09:32' },
    ],
    design:    [{ who: 'Parth Sharma', initials: 'PT', color: '#43b3ff', text: 'Dark mode tokens are in Figma — feedback welcome.', time: '13:10' }],
    marketing: [{ who: 'Sara Noor',    initials: 'SN', color: '#db672d', text: 'Launch blog draft is ready for engineering review.', time: '15:40' }],
  };

  return {
    meta: { nextTaskNum: 100, nextIdx: 1000 },
    people,
    projects,
    tasks,
    inbox,
    discussions: {},  // taskId -> [{ who, initials, color, text, at }]
    messages: channelMessages,   // channelId -> [{ who, initials, color, text, time }]
    prefsByUser: {},             // userId -> { savedIds: [], readFlags: {} } (per-user preferences)
  };
}

let db;

/* ------------------------------------------------------------------ */
/* Phase 4 — SQLite task mirror                                        */
/*                                                                     */
/* The JSON document store remains the source of truth, but every task */
/* is also mirrored into a normalized SQLite `tasks` table with real   */
/* columns and indexes. Indexed reads (by id / idx) are served from    */
/* SQLite; deletes are soft-deletes (deleted_at) so rows stay          */
/* recoverable; pagination is supported on GET /api/tasks.             */
/* ------------------------------------------------------------------ */

const TASK_COLS = 'id TEXT PRIMARY KEY, idx INTEGER UNIQUE, name TEXT, progress TEXT, urgency TEXT, assignee TEXT, project TEXT, comments INTEGER, deleted_at TEXT, created_at TEXT';
/* Just the column names, for INSERT lists (TASK_COLS includes type defs). */
const TASK_COL_NAMES = ['id', 'idx', 'name', 'progress', 'urgency', 'assignee', 'project', 'comments', 'deleted_at', 'created_at'];
let taskStmts = null; // prepared statements (only when sqlite is active)

function initTaskTable() {
  if (!sqlite) return;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS tasks (${TASK_COLS});
               CREATE INDEX IF NOT EXISTS idx_tasks_project  ON tasks(project);
               CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
               CREATE INDEX IF NOT EXISTS idx_tasks_idx      ON tasks(idx);`);
  taskStmts = {
    upsert: sqlite.prepare(`INSERT INTO tasks (${TASK_COL_NAMES.join(',')})
        VALUES (@id,@idx,@name,@progress,@urgency,@assignee,@project,@comments,@deleted_at,@created_at)
        ON CONFLICT(id) DO UPDATE SET
          idx=@idx, name=@name, progress=@progress, urgency=@urgency,
          assignee=@assignee, project=@project, comments=@comments, deleted_at=@deleted_at`),
    get:     sqlite.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL'),
    byIdx:   sqlite.prepare('SELECT * FROM tasks WHERE idx = ? AND deleted_at IS NULL'),
    live:    sqlite.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL'),
    softDel: sqlite.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?'),
    revive:  sqlite.prepare('UPDATE tasks SET deleted_at = NULL WHERE id = ?'),
  };
}

function rowFromTask(t) {
  return {
    id: t.id, idx: t.idx ?? null, name: t.name, progress: t.progress, urgency: t.urgency,
    assignee: t.assignee, project: t.project, comments: t.comments ?? 0,
    deleted_at: t.deletedAt || null, created_at: t.createdAt || null,
  };
}
function taskFromRow(r) {
  const t = {
    id: r.id, name: r.name, progress: r.progress, urgency: r.urgency,
    assignee: r.assignee, project: r.project, comments: r.comments, createdAt: r.created_at,
  };
  if (r.idx != null) t.idx = r.idx;
  if (r.deleted_at) t.deletedAt = r.deleted_at;
  return t;
}

/* Mirror one task into the table (no-op without SQLite). */
function upsertTaskRow(t) {
  if (!taskStmts) return;
  try { taskStmts.upsert.run(rowFromTask(t)); } catch (e) { console.error('task mirror upsert failed:', e.message); }
}
/* Soft-delete keeps the row (recoverable); falls back to a hard delete of a
   non-existent row otherwise. */
function softDeleteTaskRow(id) {
  if (!taskStmts) return;
  try {
    const info = taskStmts.softDel.run(new Date().toISOString(), id);
    if (!info.changes) upsertTaskRow({ id, deletedAt: new Date().toISOString() });
  } catch (e) { console.error('task mirror delete failed:', e.message); }
}
function reviveTaskRow(t) {
  if (!taskStmts || !t) return;
  try { taskStmts.revive.run(t.id); }
  catch (_) { /* fall through */ }
  upsertTaskRow(t);
}

/* Rebuild the whole mirror from the document store (startup). */
function syncTaskTable() {
  if (!sqlite || !taskStmts) return;
  try {
    const tx = sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM tasks').run();
      for (const t of db.tasks) taskStmts.upsert.run(rowFromTask(t));
    });
    tx();
  } catch (e) { console.error('task mirror sync failed:', e.message); }
}

/* Indexed lookup served by SQLite; undefined means "use document fallback". */
function sqliteTaskById(param) {
  if (!taskStmts) return undefined;
  let r = taskStmts.get.get(param);
  if (!r && /^-?\d+$/.test(param)) r = taskStmts.byIdx.get(Number(param));
  return r ? taskFromRow(r) : undefined;
}

/* Return a soft-deleted mirror row (for 410 Gone responses), or null. */
function sqliteDeletedRow(id) {
  if (!sqlite || !taskStmts) return null;
  try {
    return sqlite.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NOT NULL').get(id) || null;
  } catch (_) { return null; }
}

/* Permanently purge soft-deleted task rows (used by POST /api/purge).
   Returns the number of rows removed. No-op without SQLite. */
function purgeDeletedTaskRows() {
  if (!sqlite || !taskStmts) return 0;
  try {
    const info = sqlite.prepare('DELETE FROM tasks WHERE deleted_at IS NOT NULL').run();
    return info.changes || 0;
  } catch (e) { console.error('purge failed:', e.message); return 0; }
}

/* Additive migration so older db.json files gain new collections/counters. */
function migrate(d) {
  const seed = seedData();
  d.meta = { ...seed.meta, ...(d.meta || {}) };
  if (!Array.isArray(d.inbox)) d.inbox = seed.inbox;
  if (!d.discussions || typeof d.discussions !== 'object') d.discussions = {};
  if (!d.messages || typeof d.messages !== 'object') d.messages = seed.messages;
  /* Phase 2: per-user prefs replace the old single global savedIds/readFlags. */
  if (!d.prefsByUser || typeof d.prefsByUser !== 'object') {
    d.prefsByUser = {};
    const legacySaved = Array.isArray(d.savedIds) ? d.savedIds : [];
    const legacyRead  = (d.readFlags && typeof d.readFlags === 'object') ? d.readFlags : {};
    if (legacySaved.length || Object.keys(legacyRead).length) {
      const owner = (Array.isArray(d.people) && d.people[0]) ? d.people[0].id : 'p1';
      d.prefsByUser[owner] = { savedIds: legacySaved, readFlags: legacyRead };
    }
  }
  delete d.savedIds;
  delete d.readFlags;
  /* Phase 4: passwords are stored as salted scrypt hashes. Legacy entries
     (plaintext, e.g. the old demo value) are upgraded in place on load. */
  d.people.forEach((p, i) => {
    if (!p.email) p.email = `${String(p.name || 'user' + i).toLowerCase().replace(/[^a-z0-9]+/g, '.')}@catlas.inc`;
    if (!p.password) p.password = hashPassword(DEMO_PASSWORD);
    else if (!String(p.password).startsWith('sc$')) p.password = hashPassword(String(p.password));
  });
  /* Backfill: the first member is the workspace admin (needed for /api/import);
   * existing databases created before roles existed get upgraded additively. */
  if (d.people[0] && !d.people.some(p => p.role === 'admin')) d.people[0].role = 'admin';
  return d;
}

function userPrefs(uid) {
  if (!db.prefsByUser[uid]) db.prefsByUser[uid] = { savedIds: [], readFlags: {}, ui: {} };
  const pr = db.prefsByUser[uid];
  if (!Array.isArray(pr.savedIds)) pr.savedIds = [];
  if (!pr.readFlags || typeof pr.readFlags !== 'object') pr.readFlags = {};
  if (!pr.ui || typeof pr.ui !== 'object') pr.ui = {};   // theme / notification toggles
  return pr;
}

function loadDb() {
  if (IS_MODULE) return;   // serverless: loaded asynchronously via loadDbAsync(kv)
  if (sqlite) {
    /* Durable store first; fall back to the legacy JSON file, then to seed. */
    try {
      sqlite.exec('CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT)');
      const row = sqlite.prepare('SELECT v FROM store WHERE k = ?').get('doc');
      if (row) { db = migrate(JSON.parse(row.v)); return; }
    } catch (e) { console.error('SQLite read failed:', e.message); }
  }
  try {
    db = migrate(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (_) {
    db = seedData();
  }
  saveDbSync(); // persist into the durable store (and retire the stale JSON file)
}

let saveTimer = null;
function saveDb() {            // debounced durable write
  if (IS_MODULE) return pendingSave();   // serverless: no timers — explicit flush per invocation
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDbSync, 50);
}
/* Serverless path: mark the document dirty; `flushSaves()` persists it before
 * the function invocation freezes/returns. */
let kvDirty = false;
function pendingSave() { kvDirty = true; }
async function flushSaves() {
  if (!IS_MODULE) { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveDbSync(); return; }
  if (!kv || !kvDirty) return;
  kvDirty = false;
  await kv.put('doc', JSON.stringify(db));
}
function saveDbSync() {
  if (IS_MODULE) { pendingSave(); return; }   // module mode never touches disk
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(db, null, 2);
  if (sqlite) {
    try {
      sqlite.exec('CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT)');
      sqlite.prepare('INSERT INTO store (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
            .run('doc', json);
      syncTaskTable();
      return;
    } catch (e) { console.error('SQLite write failed, falling back to JSON file:', e.message); }
  }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DB_FILE); // atomic swap
}

/* Serverless bootstrap (Netlify): load the document from an injected KV store,
 * seeding it on first run. Safe to call repeatedly — subsequent invocations of
 * a warm container reuse the in-memory db unless `force` is set. */
let kvLoaded = false;
async function loadDbAsync(store, force) {
  setKV(store);
  if (kvLoaded && !force) return;
  const raw = await store.get('doc');
  if (raw) { db = migrate(JSON.parse(raw)); }
  else { db = seedData(); }
  kvLoaded = true;
  kvDirty = !raw;               // persist the seed on first invocation
}

loadDb();
initTaskTable();
syncTaskTable();

/* ------------------------------------------------------------------ */
/* Tiny router helpers                                                 */
/* ------------------------------------------------------------------ */

const VALID_PROGRESS = ['Ongoing', 'In review', 'Completed', 'Pending', 'On hold'];
const VALID_URGENCY  = ['Critical', 'Moderate', 'Minor'];

function send(res, status, body, headers = {}, raw) {
  const payload = raw !== undefined ? raw : (typeof body === 'string' ? body : JSON.stringify(body));
  const base = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  /* Serverless shim path (deploy/netlify.mjs): res is a plain object with
   * writeHead()/end() capturing methods — no real http.ServerResponse. */
  if (res && typeof res.writeHead === 'function' && !('headersSent' in res)) {
    res.writeHead(status, { ...base, ...headers });
    res.end(payload);
    return;
  }
  res.writeHead(status, { ...base, ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sanitizeTask(input, existing = {}) {
  const t = { ...existing };
  if (typeof input.name === 'string' && input.name.trim()) t.name = input.name.trim().slice(0, 200);
  if (input.progress !== undefined) {
    if (!VALID_PROGRESS.includes(input.progress)) throw new Error(`invalid progress "${input.progress}"`);
    t.progress = input.progress;
  }
  if (input.urgency !== undefined) {
    if (!VALID_URGENCY.includes(input.urgency)) throw new Error(`invalid urgency "${input.urgency}"`);
    t.urgency = input.urgency;
  }
  if (input.assignee !== undefined) {
    if (!db.people.some(p => p.id === input.assignee)) throw new Error(`unknown assignee "${input.assignee}"`);
    t.assignee = input.assignee;
  }
  if (input.project !== undefined) {
    if (!db.projects.some(p => p.id === input.project)) throw new Error(`unknown project "${input.project}"`);
    t.project = input.project;
  }
  if (input.comments !== undefined) {
    const n = Number(input.comments);
    if (!Number.isInteger(n) || n < 0) throw new Error('comments must be a non-negative integer');
    t.comments = n;
  }
  return t;
}

function nextTaskId(name) {
  // Generate TSK-### unique ids, seeded from stored counter
  let num = db.meta.nextTaskNum;
  let id;
  do { id = 'TSK-' + num++; } while (db.tasks.some(t => t.id === id));
  db.meta.nextTaskNum = num;
  return id;
}

function nextIdx() {           // stable internal numeric key for deep links / saved items
  return db.meta.nextIdx++;
}

/* ------------------------------------------------------------------ */
/* Sessions & auth (Phase 2)                                           */
/* ------------------------------------------------------------------ */

const COOKIE_NAME = 'taskhive_session';
const SESSION_TTL_MS = 7 * 24 * 3600e3; // one week
const sessions = new Map();             // token -> { userId, expires }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(kv => {
    const i = kv.indexOf('=');
    if (i > -1) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) { sessions.delete(token); }

function currentUser(req) {
  const tok = parseCookies(req)[COOKIE_NAME];
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(tok); return null; }
  return db.people.find(p => p.id === s.userId) || null;
}

function sessionCookie(token, maxAgeSec) {
  /* Secure is required for SameSite=None; Netlify serves over HTTPS so the
   * flag is added there too. Local http dev stays without Secure. */
  const secure = process.env.TASKHIVE_COOKIE_SECURE ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

/* Public view of a person — never leaks the password field. */
function publicPerson(p) {
  const { password, ...rest } = p;
  return rest;
}

/* Routes that mutate workspace data require an authenticated session. */
const PROTECTED_ROUTES = [
  ['POST',   /^tasks$/],   ['PATCH',  /^tasks\/.+$/],  ['PUT',  /^tasks\/.+$/], ['DELETE', /^tasks\/.+$/],
  ['PATCH',  /^board$/],
  ['POST',   /^projects$/], ['PATCH', /^projects\/.+$/], ['PUT', /^projects\/.+$/], ['DELETE', /^projects\/.+$/],
  ['POST',   /^channels\/.+$/],
  ['POST',   /^discussions\/.+$/],
  ['PATCH',  /^prefs$/],   ['PUT',    /^prefs$/],
  ['PATCH',  /^inbox\/.+$/], ['DELETE', /^inbox\/.+$/],
  ['PATCH',  /^people\/.+$/], ['PUT', /^people\/.+$/],
];

function requireAuth(method, key, user, res) {
  const needed = PROTECTED_ROUTES.some(([m, re]) => m === method && re.test(key));
  if (!needed) return true;
  if (user) return true;
  send(res, 401, { error: 'authentication required', login: '/api/login' });
  return false;
}

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const seg = parts[0] || '';
  const param = parts[1];
  const method = req.method;
  const routeKey = parts.join('/');
  const user = currentUser(req);

  /* --- health check (unauthenticated; used by Render/deploy health probes) --- */
  if (seg === 'health' && method === 'GET') {
    return send(res, 200, { ok: true, service: 'taskhive', uptime: Math.round(process.uptime()) + 's', tasks: db.tasks.length });
  }

  /* --- export: full JSON snapshot for backups / host migration --- */
  if (routeKey === 'export' && method === 'GET') {
    saveDbSync(); // flush debounced writes so the snapshot is current
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), version: 2, db }, null, 2);
    return send(res, 200, undefined, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="taskhive-backup-${stamp}.json"`,
    }, body);
  }

  /* --- import: restore a JSON snapshot produced by /api/export (admin auth) ---
   * Lets a deploy with an ephemeral disk be re-seeded after restarts, or move
   * data between hosts. Body must be the exact export format ({version, db}). */
  if (routeKey === 'import' && method === 'POST') {
    if (!user) return send(res, 401, { error: 'authentication required' });
    if (user.role !== 'admin') return send(res, 403, { error: 'admin role required for import' });
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const incoming = (b && b.db) ? b.db : b;   // accept wrapped or bare db object
    if (!incoming || !Array.isArray(incoming.tasks) || !Array.isArray(incoming.people)) {
      return send(res, 400, { error: 'invalid snapshot: expected an export JSON with tasks[] and people[]' });
    }
    try { migrate(incoming); } catch (e) { return send(res, 400, { error: 'snapshot failed validation: ' + e.message }); }
    db = incoming;
    saveDbSync();          // durable write + SQLite mirror sync
    return send(res, 200, { ok: true, tasks: db.tasks.length, people: db.people.length });
  }

  /* --- purge: permanently remove soft-deleted task rows (auth only) --- */
  if (routeKey === 'purge' && method === 'POST') {
    if (!user) return send(res, 401, { error: 'authentication required' });
    const purged = purgeDeletedTaskRows();
    return send(res, 200, { ok: true, purged });
  }

  /* --- auth --- */
  if (seg === 'login' && method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const person = db.people.find(p => p.email && p.email.toLowerCase() === email);
    const ok = person && verifyPassword(String(b.password || ''), person.password);
    if (!ok) {
      return send(res, 401, { error: 'Invalid email or password' });
    }
    if (ok === 'migrate') person.password = hashPassword(String(b.password)); // upgrade legacy plaintext on first login
    const token = createSession(person.id);
    saveDb();
    return send(res, 200, { user: publicPerson(person) }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }
  if (seg === 'logout' && method === 'POST') {
    const tok = parseCookies(req)[COOKIE_NAME];
    if (tok) destroySession(tok);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('deleted', 0) });
  }
  if (seg === 'session' && method === 'GET') {
    return send(res, 200, user ? { user: publicPerson(user) } : { user: null });
  }
  if (seg === 'signup' && method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 4) {
      return send(res, 400, { error: 'Valid name, email and a password (≥4 chars) are required' });
    }
    if (db.people.some(p => p.email && p.email.toLowerCase() === email)) {
      return send(res, 409, { error: 'That email is already registered' });
    }
    const initials = name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const palette = ['#43b3ff', '#ffa575', '#7b60ff', '#3eb957', '#db672d', '#e34a8f', '#2fbcb0'];
    const person = {
      id: 'p' + (db.people.reduce((m, p) => Math.max(m, Number(String(p.id).replace(/\D/g, '')) || 0), 0) + 1),
      name, initials, color: palette[db.people.length % palette.length], email,
      password: hashPassword(password),   // Phase 4: never store plaintext
    };
    db.people.push(person);
    saveDbSync();
    const token = createSession(person.id);
    return send(res, 201, { user: publicPerson(person) }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  if (!requireAuth(method, routeKey, user, res)) return;

  /* --- bootstrap: everything the frontend needs in one call --- */
  if (seg === 'bootstrap' && method === 'GET') {
    const prefs = user ? userPrefs(user.id) : { savedIds: [], readFlags: {}, ui: {} };
    return send(res, 200, {
      user: user ? publicPerson(user) : null,
      people: db.people.map(publicPerson),
      projects: db.projects.map(p => ({
        ...p,
        open: db.tasks.filter(t => t.project === p.id && t.progress !== 'Completed').length,
      })),
      tasks: db.tasks,
      inbox: db.inbox.map(it => ({ ...it, unread: !prefs.readFlags[it.id] })),
      discussions: db.discussions,
      messages: db.messages,
      savedIds: prefs.savedIds,
      readFlags: prefs.readFlags,
      ui: prefs.ui,
    });
  }

  /* --- people --- */
  if (seg === 'people') {
    if (method === 'GET' && !param) return send(res, 200, db.people.map(publicPerson));
    if (param) {
      const p = db.people.find(x => x.id === param);
      if (!p) return send(res, 404, { error: 'person not found' });
      if (method === 'GET') return send(res, 200, publicPerson(p));
      if (method === 'PATCH' || method === 'PUT') {
        if (!user || user.id !== p.id) return send(res, 403, { error: 'you can only edit your own profile' });
        const b = await readBody(req);
        if (typeof b.name === 'string' && b.name.trim()) {
          p.name = b.name.trim().slice(0, 80);
          p.initials = p.name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
        }
        if (typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color)) p.color = b.color;
        if (typeof b.email === 'string' && /^\S+@\S+\.\S+$/.test(b.email.trim())) p.email = b.email.trim().toLowerCase();
        if (b.password !== undefined) {
          const np = String(b.password);
          if (np.length < 4) return send(res, 400, { error: 'password must be at least 4 characters' });
          p.password = hashPassword(np);
        }
        saveDb();
        return send(res, 200, publicPerson(p));
      }
      return send(res, 405, { error: 'method not allowed' });
    }
  }

  /* --- inbox (server-persisted notifications + per-user read flags) --- */
  if (seg === 'inbox') {
    const prefs = user ? userPrefs(user.id) : { savedIds: [], readFlags: {} };
    if (method === 'GET' && !param) {
      return send(res, 200, db.inbox.map(it => ({ ...it, unread: !prefs.readFlags[it.id] })));
    }
    if (method === 'PATCH' && param === 'read-all') {
      if (!user) return send(res, 401, { error: 'authentication required' });
      const pr = userPrefs(user.id);
      db.inbox.forEach(it => { pr.readFlags[it.id] = true; });
      saveDb();
      return send(res, 200, { ok: true });
    }
    const it = db.inbox.find(x => x.id === param);
    if (!it) return send(res, 404, { error: 'inbox item not found' });
    if (method === 'PATCH' || method === 'PUT') {
      if (!user) return send(res, 401, { error: 'authentication required' });
      const pr = userPrefs(user.id);
      const b = await readBody(req);
      if (b.unread === false || b.read === true) pr.readFlags[it.id] = true;
      if (b.unread === true) delete pr.readFlags[it.id];
      saveDb();
      return send(res, 200, { ...it, unread: !pr.readFlags[it.id] });
    }
    if (method === 'DELETE') {
      db.inbox = db.inbox.filter(x => x.id !== param);
      Object.values(db.prefsByUser).forEach(pr => { delete pr.readFlags[param]; });
      saveDb();
      return send(res, 200, { deleted: true, id: param });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- task discussions (Properties panel comments) --- */
  if (seg === 'discussions') {
    const list = () => db.discussions[param] || [];
    if (method === 'GET' && param) return send(res, 200, list());
    if (method === 'POST' && param) {
      const b = await readBody(req);
      if (!b.text || !String(b.text).trim()) return send(res, 400, { error: 'text is required' });
      if (!db.tasks.some(t => t.id === param)) return send(res, 404, { error: 'task not found' });
      const c = {
        by: user ? user.id : null,
        who: user ? user.name : String(b.who || 'Anonymous'),
        initials: user ? user.initials : String(b.initials || '??'),
        color: user ? user.color : String(b.color || '#888'),
        text: String(b.text).trim().slice(0, 2000),
        at: new Date().toISOString(),
      };
      (db.discussions[param] = db.discussions[param] || []).push(c);
      const task = db.tasks.find(t => t.id === param);
      task.comments = (task.comments || 0) + 1;
      saveDb();
      return send(res, 201, { comment: c, comments: task.comments });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- projects --- */
  if (seg === 'projects') {
    if (method === 'GET' && !param) {
      return send(res, 200, db.projects.map(p => ({
        ...p,
        open: db.tasks.filter(t => t.project === p.id && t.progress !== 'Completed').length,
      })));
    }
    if (method === 'POST' && !param) {
      const b = await readBody(req);
      if (!b.name || !String(b.name).trim()) return send(res, 400, { error: 'name is required' });
      const id = String(b.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        + '-' + crypto.randomBytes(2).toString('hex');
      const proj = { id, name: String(b.name).trim(), desc: String(b.desc || ''), members: Array.isArray(b.members) ? b.members : (user ? [user.id] : []) };
      if (user && !proj.members.includes(user.id)) proj.members.push(user.id);
      db.projects.push(proj);
      saveDb();
      return send(res, 201, proj);
    }
    const proj = db.projects.find(p => p.id === param);
    if (!proj) return send(res, 404, { error: 'project not found' });
    if (method === 'GET') return send(res, 200, proj);
    if (method === 'PATCH' || method === 'PUT') {
      const b = await readBody(req);
      if (b.name) proj.name = String(b.name).trim();
      if (b.desc !== undefined) proj.desc = String(b.desc);
      if (Array.isArray(b.members)) proj.members = b.members;
      saveDb();
      return send(res, 200, proj);
    }
    if (method === 'DELETE') {
      db.projects = db.projects.filter(p => p.id !== param);
      db.tasks = db.tasks.filter(t => t.project !== param);
      saveDb();
      return send(res, 200, { deleted: true, id: param });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- tasks --- */
  if (seg === 'tasks') {
    if (method === 'GET' && !param) {
      let list = db.tasks;
      if (url.searchParams.has('project')) list = list.filter(t => t.project === url.searchParams.get('project'));
      if (url.searchParams.has('progress')) list = list.filter(t => t.progress === url.searchParams.get('progress'));
      if (url.searchParams.has('urgency')) list = list.filter(t => t.urgency === url.searchParams.get('urgency'));
      if (url.searchParams.has('assignee')) list = list.filter(t => t.assignee === url.searchParams.get('assignee'));
      if (url.searchParams.has('q')) {
        const q = url.searchParams.get('q').toLowerCase();
        list = list.filter(t => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
      }
      /* Phase 4: optional pagination — ?limit=&offset= returns a page object. */
      if (url.searchParams.has('limit') || url.searchParams.has('offset')) {
        const limit  = Math.min(500, Math.max(1, Number(url.searchParams.get('limit'))  || 25));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return send(res, 200, { total: list.length, limit, offset, items: list.slice(offset, offset + limit) });
      }
      return send(res, 200, list);
    }
    if (method === 'POST' && !param) {
      const b = await readBody(req);
      if (!b.name || !String(b.name).trim()) return send(res, 400, { error: 'name is required' });
      let task;
      try {
        task = sanitizeTask(b, {
          id: nextTaskId(b.name),
          name: String(b.name).trim(),
          progress: 'Pending',
          urgency: 'Moderate',
          assignee: db.people[0].id,
          project: 'q3-plan',
          comments: 0,
          idx: nextIdx(),
          createdAt: new Date().toISOString(),
        });
      } catch (e) { return send(res, 400, { error: e.message }); }
      db.tasks.unshift(task);   // newest first — matches the frontend's unshift()
      upsertTaskRow(task);      // mirror immediately (no debounce window)
      saveDb();
      return send(res, 201, task);
    }
    const idx = db.tasks.findIndex(t => t.id === param);
    if (idx === -1) {
      // also accept the stable numeric key used by frontend deep links (#/task/:idx)
      const byIdx = /^\d+$/.test(param) ? db.tasks.findIndex(t => t.idx === Number(param)) : -1;
      if (byIdx !== -1) {
        if (method === 'GET') return send(res, 200, db.tasks[byIdx]);
        if (method === 'PATCH' || method === 'PUT') {
          const b = await readBody(req);
          try { db.tasks[byIdx] = sanitizeTask(b, db.tasks[byIdx]); }
          catch (e) { return send(res, 400, { error: e.message }); }
          upsertTaskRow(db.tasks[byIdx]);
          saveDb();
          return send(res, 200, db.tasks[byIdx]);
        }
        if (method === 'DELETE') {
          const [removed] = db.tasks.splice(byIdx, 1);
          Object.values(db.prefsByUser).forEach(pr => { pr.savedIds = pr.savedIds.filter(id => id !== removed.id); });
          softDeleteTaskRow(removed.id);
          saveDb();
          return send(res, 200, { deleted: true, id: removed.id });
        }
      }
      /* Soft-deleted rows stay in SQLite but are invisible to normal reads. */
      if (method === 'GET') {
        const gone = sqliteDeletedRow(param);
        if (gone) return send(res, 410, { error: 'task deleted', id: gone.id, deletedAt: gone.deleted_at });
      }
      return send(res, 404, { error: 'task not found' });
    }
    if (method === 'GET') return send(res, 200, db.tasks[idx]);
    if (method === 'PATCH' || method === 'PUT') {
      const b = await readBody(req);
      try {
        db.tasks[idx] = sanitizeTask(b, db.tasks[idx]);
      } catch (e) { return send(res, 400, { error: e.message }); }
      upsertTaskRow(db.tasks[idx]);
      saveDb();
      return send(res, 200, db.tasks[idx]);
    }
    if (method === 'DELETE') {
      const [removed] = db.tasks.splice(idx, 1);
      Object.values(db.prefsByUser).forEach(pr => { pr.savedIds = pr.savedIds.filter(id => id !== removed.id); });
      softDeleteTaskRow(removed.id);   // recoverable row kept in SQLite
      saveDb();
      return send(res, 200, { deleted: true, id: removed.id });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- board-level bulk update (drag & drop persistence) --- */
  if (seg === 'board' && method === 'PATCH') {
    const b = await readBody(req);
    if (!Array.isArray(b.order)) return send(res, 400, { error: 'order must be an array of task ids' });
    const known = new Set(db.tasks.map(t => t.id));
    if (!b.order.every(id => known.has(id))) return send(res, 400, { error: 'order contains unknown task ids' });
    const byId = Object.fromEntries(db.tasks.map(t => [t.id, t]));
    db.tasks = b.order.map(id => byId[id]).concat(db.tasks.filter(t => !b.order.includes(t.id)));
    saveDb();
    return send(res, 200, { ok: true });
  }

  /* --- saved items / read flags (per-user prefs) --- */
  if (seg === 'prefs') {
    if (!user) return send(res, 401, { error: 'authentication required' });
    const pr = userPrefs(user.id);
    if (method === 'GET') return send(res, 200, { savedIds: pr.savedIds, readFlags: pr.readFlags, ui: pr.ui });
    if (method === 'PATCH' || method === 'PUT') {
      const b = await readBody(req);
      if (Array.isArray(b.savedIds)) pr.savedIds = b.savedIds.filter(x => typeof x === 'string');
      if (b.readFlags && typeof b.readFlags === 'object') pr.readFlags = b.readFlags;
      if (b.ui && typeof b.ui === 'object') pr.ui = { ...pr.ui, ...b.ui };
      saveDb();
      return send(res, 200, { savedIds: pr.savedIds, readFlags: pr.readFlags, ui: pr.ui });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- channel messages --- */
  if (seg === 'channels') {
    if (method === 'GET' && param) {
      return send(res, 200, db.messages[param] || []);
    }
    if (method === 'POST' && param) {
      const b = await readBody(req);
      if (!b.text || !String(b.text).trim()) return send(res, 400, { error: 'text is required' });
      const msg = {
        by: user ? user.id : null,
        who: user ? user.name : String(b.who || 'Anonymous'),
        initials: user ? user.initials : String(b.initials || '??'),
        color: user ? user.color : String(b.color || '#888'),
        text: String(b.text).trim().slice(0, 2000),
        time: new Date().toTimeString().slice(0, 5),
      };
      (db.messages[param] = db.messages[param] || []).push(msg);
      saveDb();
      return send(res, 201, msg);
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  return send(res, 404, { error: 'unknown API endpoint', endpoint: '/api/' + parts.join('/') });
}

/* ------------------------------------------------------------------ */
/* Static file serving                                                 */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
};

/* Only the frontend files are public. Everything else in the project folder
 * (server.js, package.json, data/ with the database, render.yaml, ...) must never be served. */
const PUBLIC_FILES = new Set(['/index.html', '/app.js', '/styles.css', '/robots.txt']);

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); }
  catch (_) {                                  // malformed %-escape: answer 400 instead of crashing the process
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request');
  }
  if (p === '/') p = '/index.html';
  if (!PUBLIC_FILES.has(p)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const filePath = path.join(ROOT, p);
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

if (IS_MODULE) {
  /* Netlify serverless mode: export the pure API handler + storage hooks. */
  module.exports = { handleApi, readBody, loadDbAsync, flushSaves, seedData };
} else {
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS (permissive, handy for local dev / separate frontend hosting)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      send(res, e.message === 'invalid JSON' || e.message === 'body too large' ? 400 : 500,
           { error: e.message });
    }
    return;
  }
  if (url.pathname === '/api' || url.pathname === '/api/') {
    return send(res, 200, { name: 'Issue Tracker API', version: 2, endpoints: [
      'POST   /api/login               POST /api/logout          GET /api/session',
      'POST   /api/signup',
      'GET    /api/bootstrap',
      'GET    /api/people              GET/PATCH /api/people/:id',
      'GET    /api/projects            POST /api/projects',
      'GET    /api/projects/:id        PATCH /api/projects/:id  DELETE /api/projects/:id',
      'GET    /api/tasks?project=&progress=&urgency=&assignee=&q=',
      'POST   /api/tasks               GET/PATCH/DELETE /api/tasks/:id',
      'PATCH  /api/board               (bulk reorder)',
      'GET    /api/prefs               PATCH /api/prefs  (per-user)',
      'GET    /api/channels/:id        POST /api/channels/:id',
      'GET    /api/discussions/:taskId POST /api/discussions/:taskId',
      'GET    /api/inbox               PATCH /api/inbox/:id  PATCH /api/inbox/read-all',
      'GET    /api/export              POST /api/purge       (backup snapshot / soft-delete purge)',
    ]});
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Issue Tracker backend running at http://localhost:${PORT}`);
  console.log(`  API base:  http://localhost:${PORT}/api`);
  console.log(`  Data file: ${DB_FILE}`);
});
} /* end else (classic server mode) */

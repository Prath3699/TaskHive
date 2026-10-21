#!/usr/bin/env node
/* TaskHive — backend server (multi-user edition)
 * Zero-dependency Node.js server:
 *   - Serves the static frontend (index.html, app.js, styles.css, ...)
 *   - JSON REST API under /api/* backed by NORMALIZED SQLite tables
 *     (users, workspaces, memberships, sessions, projects, tasks, inbox,
 *      channels, messages, discussions, prefs) with foreign keys so every
 *      user only ever sees their own workspace's data.
 *   - Auth: signup/login/logout/me over httpOnly SameSite=Lax session
 *     cookies; scrypt password hashes; rate limiting; security headers;
 *     CORS allowlist; input sanitization.
 *
 * Environment variables (see .env.example):
 *   PORT                     listen port (Render injects this)
 *   DATABASE_URL             optional Postgres URL — if set, the server warns
 *                            that it is not used and keeps SQLite as source
 *                            of truth (documented deviation for Render free
 *                            tier: its Postgres expires after 30 days).
 *   TASKHIVE_DATA_DIR        durable data directory (default ./data)
 *   TASKHIVE_COOKIE_SECURE   "1" → Secure cookie flag (set on Render)
 *   TASKHIVE_TRUST_PROXY     "1" → honor X-Forwarded-For (Render proxies)
 *   TASKHIVE_ALLOWED_ORIGINS comma-separated CORS allowlist (empty = same-origin only)
 *   TASKHIVE_DEMO_PASSWORD   password for the seeded demo accounts (default "password")
 *   TASKHIVE_SEED_DEMO       "0" disables seeding the demo workspace entirely
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
/* Netlify serverless entry (netlify/functions/api.mjs)               */
/* ------------------------------------------------------------------ */
/* When required as a module we skip the HTTP bootstrap. The relational
 * layer needs a persistent disk, which serverless does not provide, so
 * the Netlify wrapper sets TASKHIVE_READONLY_API=1 and only safe reads /
 * auth calls run there (mutations answer 503). */
const IS_MODULE = !!process.env.TASKHIVE_NO_LISTEN;
const READONLY_API = !!process.env.TASKHIVE_READONLY_API || IS_MODULE;

/* Durable storage location. On Render's free tier the container filesystem is
 * ephemeral (DB resets + re-seeds on redeploy/spin-down); render.yaml documents
 * how to attach a persistent disk on the starter plan. */
const DATA_DIR = process.env.TASKHIVE_DATA_DIR || path.join(ROOT, 'data');
/* Full database file path — overrides TASKHIVE_DATA_DIR (useful on Render when
 * a persistent disk is mounted at an arbitrary mount point). */
const SQLITE_FILE = process.env.TASKHIVE_DB_PATH || path.join(DATA_DIR, 'taskhive.db');
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

if (process.env.DATABASE_URL) {
  console.warn('[taskhive] DATABASE_URL detected — Postgres is NOT used in this build;');
  console.warn('[taskhive] SQLite at', SQLITE_FILE, 'remains the source of truth (see README).');
}

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt — OWASP-equivalent strength to bcrypt-12) */
/* ------------------------------------------------------------------ */
const DEMO_PASSWORD = process.env.TASKHIVE_DEMO_PASSWORD || 'password';
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
    try { return crypto.timingSafeEqual(digest(pw), digest(stored)) ? 'migrate' : false; }
    catch (_) { return false; }
  }
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  let a; try { a = Buffer.from(hashHex, 'hex'); } catch (_) { return false; }
  /* Always compute scrypt against the STORED key length so wrong-password and
   * corrupt-hash paths take the same time. */
  const b = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), Math.max(a.length, 1), SCRYPT_PARAMS);
  try { return crypto.timingSafeEqual(a, b); }
  catch (_) { return false; }                 // length mismatch ⇒ not equal
}
/* Temporary login-failure diagnostics (server-side only). Logs WHY a login
 * failed — never the password, never the hash. The email is reduced to a
 * short salted fingerprint so log lines can be correlated with rows without
 * storing addresses in plain text. Remove once the field issue is resolved. */
const AUTH_LOG_SALT = crypto.randomBytes(8).toString('hex');
function logAuthFail(kind, email, reason) {
  const fp = crypto.createHash('sha256').update(AUTH_LOG_SALT + ':' + email).digest('hex').slice(0, 8);
  console.warn(`[auth] ${kind} failed: ${reason}; email#${fp}`);
}

/* Shared email normalization — used by signup, login and every user lookup so
 * the value written at signup is byte-identical to the one read back at login.
 * cleanStr() trims + strips control chars; lowercasing happens INSIDE cleanStr's
 * result path below to keep ordering irrelevant. */
function normalizeEmail(raw) {
  return cleanStr(String(raw == null ? '' : raw).toLowerCase(), 254);
}

/* ------------------------------------------------------------------ */
/* Input sanitization                                                  */
/* ------------------------------------------------------------------ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/* Strip control characters (incl. newlines) from any user-supplied string. */
function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max || 200);
}
function initialsFrom(name) {
  return String(name).split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
}
const AVATAR_PALETTE = ['#43b3ff', '#ffa575', '#7b60ff', '#3eb957', '#db662d', '#e34a8f', '#2fbcb0'];

/* ------------------------------------------------------------------ */
/* Seed content (the classic demo workspace + new-user onboarding)     */
/* ------------------------------------------------------------------ */
const SEED_PEOPLE = [
  { key: 'p1', name: 'Parth Sharma', email: 'parth@catlas.inc', color: '#43b3ff', role: 'admin' },
  { key: 'p2', name: 'David Lee',    email: 'david@catlas.inc', color: '#ffa575' },
  { key: 'p3', name: 'Maya Chen',    email: 'maya@catlas.inc',  color: '#7b60ff' },
  { key: 'p4', name: 'Alex Kim',     email: 'alex@catlas.inc',  color: '#3eb957' },
  { key: 'p5', name: 'Sara Noor',    email: 'sara@catlas.inc',  color: '#db672d' },
];
const SEED_PROJECTS = [
  { id: 'q3-plan',         name: 'Q3 Plan',            desc: 'Product roadmap & delivery plan for Q3', color: '#7b60ff' },
  { id: 'website-redesign', name: 'Website Redesign',  desc: 'New marketing site and design system',   color: '#43b3ff' },
  { id: 'mobile-app-v2',   name: 'Mobile App v2.0',    desc: 'Feature parity with web + offline mode', color: '#3eb957' },
  { id: 'api-docs',        name: 'API Documentation',  desc: 'Public developer docs refresh',          color: '#ffa575' },
  { id: 'customer-portal', name: 'Customer Portal',    desc: 'Self-service dashboard for clients',     color: '#db672d' },
  { id: 'internal-tools',  name: 'Internal Tools',     desc: 'Admin utilities and ops automation',     color: '#38bdf8' },
];
const SEED_TASKS = [
  ['TSK-8',  'Improve Navigation & Menu Organization', 'Ongoing',   'Moderate', 'p3', 0, 'q3-plan', 0],
  ['TSK-20', 'Enhance Search Functionality',           'Completed', 'Critical', 'p2', 6, 'q3-plan', 1],
  ['TSK-22', 'Dark Mode Implementation',               'In review', 'Minor',    'p1', 0, 'q3-plan', 2],
  ['TSK-6',  'Optimize Mobile Responsiveness',         'Ongoing',   'Moderate', 'p4', 0, 'q3-plan', 3],
  ['TSK-6b', 'Redesign Checkout Flow',                 'Ongoing',   'Critical', 'p5', 0, 'q3-plan', 4],
  ['TSK-10', 'Speed Optimization for Home Page',       'Ongoing',   'Critical', 'p2', 0, 'q3-plan', 5],
  ['TSK-40', 'Reduce Load Time for Large Data Sets',   'Pending',   'Minor',    'p3', 0, 'q3-plan', 6],
  ['TSK-12', 'Optimize Image Compression for Faster Loading', 'In review', 'Moderate', 'p1', 0, 'q3-plan', 7],
  ['TSK-18', 'Introduce AI-powered Task Prioritization', 'Completed', 'Moderate', 'p4', 4, 'q3-plan', 8],
  ['TSK-12b','Multi-language Support Implementation',  'Completed', 'Critical', 'p5', 1, 'q3-plan', 9],
  ['TSK-12c','Missing Tooltip on Product Images',      'Completed', 'Moderate', 'p2', 0, 'q3-plan', 10],
  ['TSK-22b','Integrate Third-party Calendar Sync',    'Completed', 'Critical', 'p3', 4, 'q3-plan', 11],
  ['TSK-14', 'Enhance User Authentication with 2FA',   'Pending',   'Minor',    'p1', 0, 'q3-plan', 12],
  ['TSK-27', 'GDPR Compliance Updates',                'Pending',   'Minor',    'p4', 0, 'q3-plan', 13],
  ['TSK-18b','Data Encryption for Sensitive Information', 'In review', 'Minor', 'p5', 3, 'q3-plan', 14],
  ['TSK-31', 'Vendor Contract Renewal Review',         'On hold',   'Minor',    'p2', 0, 'q3-plan', 15],
  ['TSK-33', 'Legacy Data Migration Assessment',       'On hold',   'Moderate', 'p5', 0, 'q3-plan', 16],
];
const SEED_INBOX = [
  ['inbox-1', 'p2', 'mentioned you in “Enhance Search Functionality”',                 10 * 60e3,      'TSK-20'],
  ['inbox-2', 'p1', 'assigned you “Dark Mode Implementation”',                         32 * 60e3,      'TSK-22'],
  ['inbox-3', 'p3', 'completed “Introduce AI-powered Task Prioritization”',            60 * 60e3,      'TSK-18'],
  ['inbox-4', 'p4', 'commented on “Optimize Mobile Responsiveness”',                   3 * 3600e3,     'TSK-6'],
  ['inbox-5', 'p5', 'requested review of “Data Encryption for Sensitive Information”', 26 * 3600e3,    'TSK-18b'],
  ['inbox-6', 'p2', 'changed urgency of “Redesign Checkout Flow” to Critical',         28 * 3600e3,    'TSK-6b'],
  ['inbox-7', 'p1', 'shared the project “Q3 Plan” with you',                           48 * 3600e3,    null],
];
const SEED_CHANNELS = [
  ['engineering',    'Builds, incidents and API chatter for the platform team.'],
  ['docs',           'Everything documentation — PRDs, guides, changelogs.'],
  ['teams',          'Cross-team coordination and people ops.'],
  ['initiatives',    'Quarterly strategic initiatives and OKRs.'],
  ['active-sprint',  'Daily standups and blockers for the current sprint.'],
  ['design',         'Design critiques, mockups and the design system.'],
  ['marketing',      'Campaigns, launches and growth experiments.'],
];
const SEED_MESSAGES = {
  engineering: [
    ['p4', 'Deployed build #482 to staging — search latency down 30%.', '09:12'],
    ['p3', 'Nice! Any regressions on the nav menu task (TSK-8)?',       '09:15'],
    ['p4', 'None so far. QA signed off on mobile responsiveness too.',  '09:18'],
  ],
  docs: [
    ['p1', 'PRD.docx updated with the new accessibility section.', '11:02'],
    ['p2', 'I’ll add the API examples before Friday.',             '11:20'],
  ],
  teams:       [['p5', 'Reminder: retro at 4 pm in the big room.', '10:00']],
  initiatives: [['p2', 'Q3 initiative tracker is live — see the Q3 Plan project.', '08:45']],
  'active-sprint': [
    ['p3', 'Standup notes: TSK-20 done, TSK-22 in review.',       '09:30'],
    ['p4', 'Blocker: need designs for the checkout flow revamp.', '09:32'],
  ],
  design:    [['p1', 'Dark mode tokens are in Figma — feedback welcome.', '13:10']],
  marketing: [['p5', 'Launch blog draft is ready for engineering review.', '15:40']],
};

/* ------------------------------------------------------------------ */
/* Relational store (better-sqlite3)                                   */
/* ------------------------------------------------------------------ */
let sqlite = null;
try {
  const Driver = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sqlite = new Driver(SQLITE_FILE);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
} catch (e) {
  sqlite = null;
  if (!IS_MODULE) console.error('[taskhive] better-sqlite3 unavailable — API disabled:', e.message);
}

const SCHEMA_VERSION = 1;
function initSchema() {
  if (!sqlite) return;
  sqlite.exec(`
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#43b3ff',
    created_at TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    last_login TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'personal',   /* personal | demo | sample */
    owner_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',     /* admin | member | demo */
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id INTEGER REFERENCES workspaces(id),
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    descr TEXT NOT NULL DEFAULT '',
    members TEXT NOT NULL DEFAULT '[]',
    idx INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#7c8cff',
    PRIMARY KEY (workspace_id, id)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    name TEXT NOT NULL,
    progress TEXT NOT NULL,
    urgency TEXT NOT NULL,
    assignee TEXT,
    project TEXT,
    comments INTEGER NOT NULL DEFAULT 0,
    ord INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT,
    PRIMARY KEY (workspace_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_ws_project  ON tasks(workspace_id, project);
  CREATE INDEX IF NOT EXISTS idx_tasks_ws_assignee ON tasks(workspace_id, assignee);
  CREATE INDEX IF NOT EXISTS idx_tasks_ws_idx      ON tasks(workspace_id, idx);
  CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_key TEXT, text TEXT NOT NULL, task TEXT, at TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, id)
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    topic TEXT NOT NULL DEFAULT '', ord INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, id)
  );
  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, actor_key TEXT, text TEXT NOT NULL, time TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_msgs_ws_channel ON channel_messages(workspace_id, channel);
  CREATE TABLE IF NOT EXISTS discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task TEXT NOT NULL, actor_key TEXT, text TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_disc_ws_task ON discussions(workspace_id, task);
  CREATE TABLE IF NOT EXISTS prefs (
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    saved_ids TEXT NOT NULL DEFAULT '[]',
    read_flags TEXT NOT NULL DEFAULT '{}',
    ui TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invited_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',          /* admin | member */
    invited_by INTEGER REFERENCES users(id),
    user_id INTEGER REFERENCES users(id),         /* set when the invitee signs up (claimed) */
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invited_ws_email ON invited_members(workspace_id, email);
  CREATE INDEX IF NOT EXISTS idx_invited_email ON invited_members(email);
  CREATE TABLE IF NOT EXISTS counters (
    workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    next_task_num INTEGER NOT NULL DEFAULT 100,
    next_idx INTEGER NOT NULL DEFAULT 1
  );`);
    /* Safe migration: projects.color (added for New project dialog). Works on
   * fresh and existing databases; harmless if the column already exists. */
  try {
    const cols = sqlite.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
    /* Fresh DBs already have the column with its DEFAULT from CREATE TABLE;
     * existing DBs get it added here. ALTER ... ADD COLUMN with a non-NULL
     * default backfills every existing row automatically. */
    if (!cols.includes('color')) sqlite.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT '#7c8cff'");
  } catch (_) {}
const row = sqlite.prepare('SELECT v FROM meta WHERE k=?').get('schema_version');
  if (!row) sqlite.prepare('INSERT INTO meta (k,v) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION));
}

function getMeta(k) {
  const r = sqlite.prepare('SELECT v FROM meta WHERE k=?').get(k);
  return r ? r.v : null;
}
function setMeta(k, v) {
  sqlite.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}

/* ------------------------- workspace queries ------------------------ */
/* better-sqlite3 caches prepared statements per SQL text, so calling
 * db.prepare() repeatedly is cheap. */
const wsStmt = {
  tasksAll:      () => sqlite.prepare('SELECT * FROM tasks WHERE workspace_id=? AND deleted_at IS NULL ORDER BY ord'),
  taskById:      () => sqlite.prepare('SELECT * FROM tasks WHERE workspace_id=? AND id=?'),
  taskByIdx:     () => sqlite.prepare('SELECT * FROM tasks WHERE workspace_id=? AND idx=? AND deleted_at IS NULL'),
  taskDeleted:   () => sqlite.prepare('SELECT * FROM tasks WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL'),
  taskUpsert:    () => sqlite.prepare(`INSERT INTO tasks (id,workspace_id,idx,name,progress,urgency,assignee,project,comments,ord,deleted_at,created_at)
      VALUES (@id,@workspace_id,@idx,@name,@progress,@urgency,@assignee,@project,@comments,@ord,@deleted_at,@created_at)
      ON CONFLICT(workspace_id,id) DO UPDATE SET idx=@idx,name=@name,progress=@progress,urgency=@urgency,
        assignee=@assignee,project=@project,comments=@comments,ord=@ord,deleted_at=@deleted_at`),
  taskSoftDel:   () => sqlite.prepare('UPDATE tasks SET deleted_at=? WHERE workspace_id=? AND id=?'),
  taskMaxOrd:    () => sqlite.prepare('SELECT COALESCE(MAX(ord),0)+1 AS n FROM tasks WHERE workspace_id=?'),
  projectsAll:   () => sqlite.prepare('SELECT * FROM projects WHERE workspace_id=? ORDER BY idx'),
  projectById:   () => sqlite.prepare('SELECT * FROM projects WHERE workspace_id=? AND id=?'),
  projectUpsert: () => sqlite.prepare(`INSERT INTO projects (id,workspace_id,name,descr,members,idx,color)
      VALUES (@id,@workspace_id,@name,@descr,@members,@idx,COALESCE(@color,'#7c8cff'))
      ON CONFLICT(workspace_id,id) DO UPDATE SET name=@name,descr=@descr,members=@members,idx=@idx,
        color=COALESCE(@color,projects.color)`),
  projectDelete: () => sqlite.prepare('DELETE FROM projects WHERE workspace_id=? AND id=?'),
  inboxAll:      () => sqlite.prepare('SELECT * FROM inbox_items WHERE workspace_id=? ORDER BY ord'),
  inboxById:     () => sqlite.prepare('SELECT * FROM inbox_items WHERE workspace_id=? AND id=?'),
  inboxInsert:   () => sqlite.prepare('INSERT OR IGNORE INTO inbox_items (id,workspace_id,actor_key,text,task,at,ord) VALUES (?,?,?,?,?,?,?)'),
  channelsAll:   () => sqlite.prepare('SELECT * FROM channels WHERE workspace_id=? ORDER BY ord'),
  channelById:   () => sqlite.prepare('SELECT * FROM channels WHERE workspace_id=? AND id=?'),
  channelInsert: () => sqlite.prepare('INSERT OR IGNORE INTO channels (id,workspace_id,topic,ord) VALUES (?,?,?,?)'),
  msgsByChannel: () => sqlite.prepare('SELECT * FROM channel_messages WHERE workspace_id=? AND channel=? ORDER BY id'),
  msgInsert:     () => sqlite.prepare('INSERT INTO channel_messages (workspace_id,channel,actor_key,text,time) VALUES (?,?,?,?,?)'),
  discByTask:    () => sqlite.prepare('SELECT * FROM discussions WHERE workspace_id=? AND task=? ORDER BY id'),
  discInsert:    () => sqlite.prepare('INSERT INTO discussions (workspace_id,task,actor_key,text,at) VALUES (?,?,?,?,?)'),
  prefsGet:      () => sqlite.prepare('SELECT * FROM prefs WHERE workspace_id=? AND user_id=?'),
  counter:       () => sqlite.prepare('SELECT * FROM counters WHERE workspace_id=?'),
  counterBump:   () => sqlite.prepare(`INSERT INTO counters (workspace_id,next_task_num,next_idx) VALUES (?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        next_task_num = MAX(next_task_num, excluded.next_task_num),
        next_idx      = MAX(next_idx, excluded.next_idx)`),
};

function taskFromRow(r) {
  const t = { id: r.id, name: r.name, progress: r.progress, urgency: r.urgency,
              assignee: r.assignee, project: r.project, comments: r.comments, createdAt: r.created_at };
  if (r.idx != null) t.idx = r.idx;
  if (r.deleted_at) t.deletedAt = r.deleted_at;
  return t;
}
function projectFromRow(r) {
  let members = [];
  try { members = JSON.parse(r.members); } catch (_) {}
  return { id: r.id, name: r.name, desc: r.descr, members, idx: r.idx, color: r.color || '' };
}

/* Monotonic id/idx allocation per workspace (safe against import & restarts). */
function allocIds(wsId, count) {
  const c = wsStmt.counter().get(wsId) || { next_task_num: 100, next_idx: 1 };
  const startNum = Math.max(c.next_task_num, 100);
  const startIdx = c.next_idx;
  wsStmt.counterBump().run(wsId, startNum + count, startIdx + count);
  const ids = [], idxs = [];
  for (let i = 0; i < count; i++) {
    ids.push('TSK-' + (startNum + i));
    idxs.push(startIdx + i);
  }
  return { ids, idxs };
}

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */
function createUser({ name, email, password, color, isDemo }) {
  const info = sqlite.prepare(
    'INSERT INTO users (name,email,password_hash,avatar_color,created_at,is_demo,email_verified,last_login) VALUES (@name,@email,@pw,@color,@created,@demo,@verified,@lastLogin)'
  ).run({ name, email: normalizeEmail(email), pw: hashPassword(password), color,
          created: new Date().toISOString(), verified: 1, demo: isDemo ? 1 : 0, lastLogin: null });
  /* Check the insert actually landed — previously a failed INSERT still let
   * signup return 201 "success" with lastInsertRowid pointing at nothing. */
  if (!info || !info.changes) throw new Error('user insert failed');
  return info.lastInsertRowid;
}
function createWorkspace(name, kind, ownerId) {
  const info = sqlite.prepare('INSERT INTO workspaces (name,kind,owner_id,created_at) VALUES (?,?,?,?)')
    .run(name, kind, ownerId, new Date().toISOString());
  const wsId = info.lastInsertRowid;
  /* Every workspace gets the standard channel list up front. Without this,
   * personal workspaces had zero rows in `channels`, so POST/GET
   * /api/channels/:id answered 404 "channel not found" and the chat UI was
   * dead for every non-demo account. */
  SEED_CHANNELS.forEach(([cid, topic], i) => {
    sqlite.prepare('INSERT OR IGNORE INTO channels (id,workspace_id,topic,ord) VALUES (?,?,?,?)').run(cid, wsId, topic, i);
  });
  return wsId;
}
function addMembership(wsId, userId, role) {
  sqlite.prepare('INSERT INTO memberships (workspace_id,user_id,role) VALUES (?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role')
    .run(wsId, userId, role);
}

/* Insert the full classic demo dataset into a workspace.
 * personKeys maps seed person keys ('p1'…) to real user ids (strings). */
function insertDemoContent(wsId, personKeys) {
  const pk = (k) => personKeys[k] != null ? String(personKeys[k]) : null;
  const now = Date.now();
  /* Single-owner mode: when onboarding sample data is inserted, every seed
   * "person" maps to the same new user. In that case we must NOT list the
   * duplicate ids repeatedly as project members or the UI renders rows of
   * phantom teammates ("tasks already assigned to others"). */
  const ownerOnly = new Set(Object.values(personKeys).map(v => String(v))).size === 1;
  const memberList = (fallbackKey) => ownerOnly ? [pk(fallbackKey || 'p1')]
                                                : SEED_PEOPLE.map(p => pk(p.key)).filter(Boolean);
  for (const pr of SEED_PROJECTS) {
    const members = pr.id === 'internal-tools' && !ownerOnly ? [pk('p4')] : memberList('p1');
    wsStmt.projectUpsert().run({ id: pr.id, workspace_id: wsId, name: pr.name, descr: pr.desc, members: JSON.stringify(members), idx: SEED_PROJECTS.indexOf(pr), color: pr.color || '#7c8cff' });
  }
  /* 17 design-mockup tasks + 2 per extra project so boards aren't dead ends */
  const rows = SEED_TASKS.map(([id, name, progress, urgency, assignee, comments, project, idx]) =>
    ({ id, name, progress, urgency, assignee: pk(assignee), project, comments, idx }));
  let seedIdx = 500, n = 50;
  ['website-redesign', 'mobile-app-v2', 'api-docs', 'customer-portal', 'internal-tools'].forEach((pid, pi) => {
    const owners = [SEED_PEOPLE[pi % 5].key, SEED_PEOPLE[(pi + 2) % 5].key];
    const pName = SEED_PROJECTS.find(p => p.id === pid).name;
    [`Kick-off & scope “${pName}”`, `Define success metrics for ${pName}`].forEach((nm, ni) => {
      rows.push({ id: 'TSK-' + (n + pi * 2 + ni), name: nm, progress: ni === 0 ? 'Ongoing' : 'Pending',
                  urgency: ['Moderate', 'Minor', 'Critical'][pi % 3], assignee: pk(owners[ni]),
                  project: pid, comments: 0, idx: seedIdx++ });
    });
  });
  const maxIdx = rows.reduce((m, r) => Math.max(m, r.idx), 0);
  let ord = 0;
  for (const r of rows) {
    wsStmt.taskUpsert().run({ id: r.id, workspace_id: wsId, idx: r.idx, name: r.name, progress: r.progress,
      urgency: r.urgency, assignee: r.assignee, project: r.project, comments: r.comments, ord: ++ord,
      deleted_at: null, created_at: new Date(now - (rows.length - ord) * 3600e3).toISOString() });
  }
  wsStmt.counterBump().run(wsId, 100, maxIdx + 1000);
  for (const [iid, whoKey, text, agoMs, task] of SEED_INBOX) {
    wsStmt.inboxInsert().run(iid, wsId, pk(whoKey), text, task, new Date(now - agoMs).toISOString(), SEED_INBOX.findIndex(x => x[0] === iid));
  }
  /* INSERT OR IGNORE everywhere: createWorkspace() already seeds the standard
   * channel list for every workspace, so a plain INSERT here collided with
   * those rows → SQLITE_CONSTRAINT UNIQUE(workspace_id, id) at startup. The
   * seed ids are fixed constants reused per workspace (not generated unique);
   * the fix is to tolerate the pre-existing rows instead of double-inserting.
   * Messages get the same guard: only insert when the channel has none yet. */
  SEED_CHANNELS.forEach(([cid, topic], i) => {
    wsStmt.channelInsert().run(cid, wsId, topic, i);
    const msgCount = sqlite.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE workspace_id=? AND channel=?').get(wsId, cid).n;
    if (msgCount === 0) {
      for (const [whoKey, text, time] of (SEED_MESSAGES[cid] || [])) {
        wsStmt.msgInsert().run(wsId, cid, pk(whoKey), text, time);
      }
    }
  });
}

/* A brand-new signup gets an empty personal workspace — except the first
 * account ever, which inherits the classic demo dataset so the app has
 * something to show right away (matches "onboarding sample data"). */
/* Shared email lookup — single point of truth for how a user row is found.
 * Users are stored globally (table `users`, UNIQUE email); workspaces/memberships
 * only decide which workspace a session opens, never which row login reads. */
function getUserByEmail(email, fullRow) {
  const sql = fullRow ? 'SELECT * FROM users WHERE email=?' : 'SELECT id FROM users WHERE email=?';
  return sqlite.prepare(sql).get(normalizeEmail(email));
}

function provisionUser(userId, { sample }) {
  const u = sqlite.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const wsId = createWorkspace(`${u.name.split(' ')[0]}'s workspace`, 'personal', userId);
  addMembership(wsId, userId, 'admin');
  wsStmt.counterBump().run(wsId, 100, 1);
  if (sample) {
    /* Onboarding sample data: every seeded person maps to the new user, so
     * the classic demo board becomes a realistic single-user playground. */
    insertDemoContent(wsId, { p1: userId, p2: userId, p3: userId, p4: userId, p5: userId });
  }
  return wsId;
}

function seedDemoWorkspace() {
  /* Idempotent: if the demo workspace (or its meta pointer) already exists,
   * reuse it instead of re-seeding — a plain INSERT of the fixed seed ids
   * would hit UNIQUE(workspace_id,id). Wrapping the whole seed in one
   * transaction means a mid-way failure rolls back and leaves no partial rows. */
  const existing = sqlite.prepare("SELECT id FROM workspaces WHERE kind='demo'").get();
  if (existing) { setMeta('demo_workspace_id', String(existing.id)); return existing.id; }
  const doSeed = sqlite.transaction(() => {
    const personKeys = {};
    SEED_PEOPLE.forEach((p, i) => {
      /* parth@catlas.inc doubles as the historical first/admin account so old
       * databases keep their identity mapping when upgraded. */
      const dup = sqlite.prepare('SELECT id FROM users WHERE email=?').get(p.email);
      personKeys[p.key] = dup ? dup.id : createUser({ name: p.name, email: p.email, password: DEMO_PASSWORD,
                                                      color: AVATAR_PALETTE[i % AVATAR_PALETTE.length], isDemo: true });
    });
    const wsId = createWorkspace('Catlas (demo)', 'demo', personKeys.p1);
    SEED_PEOPLE.forEach((p, i) => addMembership(wsId, personKeys[p.key], i === 0 ? 'admin' : 'demo'));
    insertDemoContent(wsId, personKeys);
    setMeta('demo_workspace_id', String(wsId));
    return wsId;
  });
  return doSeed();
}

function bootstrapStore() {
  if (!sqlite) return;
  initSchema();
  /* Self-heal: pointer lost but demo workspace present → restore pointer so we
   * never re-seed into an existing workspace. */
  if (!getMeta('demo_workspace_id')) {
    const ex = sqlite.prepare("SELECT id FROM workspaces WHERE kind='demo'").get();
    if (ex) setMeta('demo_workspace_id', String(ex.id));
  }
  /* One-time migration from the legacy single-document JSON store. */
  const legacyFile = path.join(DATA_DIR, 'db.json');
  if (!getMeta('relational_v1') && fs.existsSync(legacyFile)) {
    try { migrateLegacyDoc(JSON.parse(fs.readFileSync(legacyFile, 'utf8'))); }
    catch (e) { console.error('legacy migration failed:', e.message); }
  }
  if (!getMeta('relational_v1')) setMeta('relational_v1', '1');
  if (process.env.TASKHIVE_SEED_DEMO !== '0' && !getMeta('demo_workspace_id')) {
    seedDemoWorkspace();
  }
}

function migrateLegacyDoc(d) {
  if (!d || !Array.isArray(d.people)) return;
  const personKeys = {};
  d.people.forEach((p, i) => {
    const email = String(p.email || `${String(p.name || 'user' + i).toLowerCase().replace(/[^a-z0-9]+/g, '.')}@catlas.inc`).toLowerCase();
    let id = sqlite.prepare('SELECT id FROM users WHERE email=?').get(email)?.id;
    if (!id) {
      const pw = String(p.password || '').startsWith('sc$') ? null : DEMO_PASSWORD;
      id = createUser({ name: p.name || 'User', email, password: pw || DEMO_PASSWORD, color: p.color || AVATAR_PALETTE[i % 7], isDemo: true });
      if (pw) sqlite.prepare('UPDATE users SET password_hash=? WHERE id=?').run(p.password, id);
    }
    personKeys[String(p.id)] = id;
  });
  const wsId = createWorkspace('Catlas (migrated)', 'demo', Object.values(personKeys)[0]);
  Object.values(personKeys).forEach((uid, i) => addMembership(wsId, uid, i === 0 ? 'admin' : 'demo'));
  const projIds = new Set((d.projects || []).map(p => p.id));
  for (const pr of (d.projects || [])) {
    wsStmt.projectUpsert().run({ id: pr.id, workspace_id: wsId, name: pr.name, descr: pr.desc || '',
      members: JSON.stringify((pr.members || []).map(m => String(personKeys[m] ?? m))), idx: (d.projects || []).indexOf(pr), color: pr.color || '#7c8cff' });
  }
  let ord = 0;
  for (const t of (d.tasks || [])) {
    wsStmt.taskUpsert().run({ id: t.id, workspace_id: wsId, idx: t.idx ?? ++ord, name: t.name,
      progress: t.progress || 'Pending', urgency: t.urgency || 'Moderate',
      assignee: String(personKeys[t.assignee] ?? t.assignee ?? ''), project: t.project,
      comments: t.comments || 0, ord: ++ord, deleted_at: t.deletedAt || null, created_at: t.createdAt || null });
  }
  for (const it of (d.inbox || [])) {
    sqlite.prepare('INSERT OR IGNORE INTO inbox_items (id,workspace_id,actor_key,text,task,at,ord) VALUES (?,?,?,?,?,?,?)')
      .run(it.id, wsId, String(personKeys[it.who] ?? ''), it.text, it.task, it.at, (d.inbox || []).indexOf(it));
  }
  SEED_CHANNELS.forEach(([cid, topic], i) => {
    sqlite.prepare('INSERT OR IGNORE INTO channels (id,workspace_id,topic,ord) VALUES (?,?,?,?)').run(cid, wsId, topic, i);
    for (const m of ((d.messages || {})[cid] || [])) {
      wsStmt.msgInsert().run(wsId, cid, String(personKeys[m.by] ?? m.by ?? ''), m.text, m.time || '');
    }
  });
  for (const [taskId, list] of Object.entries(d.discussions || {})) {
    for (const c of list) sqlite.prepare('INSERT INTO discussions (workspace_id,task,actor_key,text,at) VALUES (?,?,?,?,?)')
      .run(wsId, taskId, String(personKeys[c.by] ?? c.by ?? ''), c.text, c.at || new Date().toISOString());
  }
  for (const [uidKey, pr] of Object.entries(d.prefsByUser || {})) {
    const uid = personKeys[uidKey]; if (!uid) continue;
    sqlite.prepare('INSERT OR IGNORE INTO prefs (workspace_id,user_id,saved_ids,read_flags,ui) VALUES (?,?,?,?,?)')
      .run(wsId, uid, JSON.stringify(pr.savedIds || []), JSON.stringify(pr.readFlags || {}), JSON.stringify(pr.ui || {}));
  }
  const meta = d.meta || {};
  wsStmt.counterBump().run(wsId, meta.nextTaskNum || 100, meta.nextIdx || 1000);
  setMeta('demo_workspace_id', String(wsId));
  console.log(`[taskhive] migrated legacy db.json → workspace ${wsId} (${(d.tasks||[]).length} tasks, ${d.people.length} people)`);
}

bootstrapStore();

/* ------------------------------------------------------------------ */
/* Sessions (server-side, persisted in SQLite; cookie carries token)   */
/* ------------------------------------------------------------------ */
const COOKIE_NAME = 'taskhive_session';
const SESSION_TTL_MS = 7 * 24 * 3600e3; // one week
const memSessions = new Map();          // fallback when no SQLite (Netlify)

function hashToken(tok) { return crypto.createHash('sha256').update(tok).digest('hex'); }

function createSession(userId, workspaceId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  if (sqlite) {
    sqlite.prepare('INSERT INTO sessions (token_hash,user_id,workspace_id,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(hashToken(token), userId, workspaceId, expires, new Date().toISOString());
    sqlite.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); // opportunistic GC
  } else {
    memSessions.set(token, { userId, workspaceId, expires });
  }
  return token;
}
function destroySession(token) {
  if (sqlite) sqlite.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  memSessions.delete(token);
}
function lookupSession(token) {
  if (sqlite) {
    const s = sqlite.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(token));
    if (!s) return null;
    if (s.expires_at < Date.now()) { destroySession(token); return null; }
    return { userId: s.user_id, workspaceId: s.workspace_id };
  }
  const s = memSessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { memSessions.delete(token); return null; }
  return { userId: s.userId, workspaceId: s.workspaceId };
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(kv => {
    const i = kv.indexOf('=');
    if (i > -1) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(token, maxAgeSec) {
  const secure = process.env.TASKHIVE_COOKIE_SECURE ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

/* Resolve the authenticated user + active workspace for a request.
 * Membership is re-checked on every call, so removed members lose access
 * immediately even with a live session cookie. */
function authContext(req) {
  if (!sqlite) return null;
  const tok = parseCookies(req)[COOKIE_NAME];
  if (!tok) return null;
  const s = lookupSession(tok);
  if (!s) return null;
  const user = sqlite.prepare('SELECT * FROM users WHERE id=?').get(s.userId);
  if (!user) return null;
  let wsId = s.workspaceId;
  let membership = null;
  if (wsId) membership = sqlite.prepare('SELECT * FROM memberships WHERE workspace_id=? AND user_id=?').get(wsId, user.id);
  if (!membership) {
    const anyWs = sqlite.prepare('SELECT workspace_id FROM memberships WHERE user_id=? LIMIT 1').get(user.id);
    if (!anyWs) return null;
    wsId = anyWs.workspace_id;
    membership = sqlite.prepare('SELECT * FROM memberships WHERE workspace_id=? AND user_id=?').get(wsId, user.id);
  }
  const workspace = sqlite.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  if (!workspace) return null;
  return { user, workspace, membership, token: tok };
}

function publicUser(u) {
  return {
    id: String(u.id),
    dbId: u.id,
    name: u.name,
    email: u.email,
    initials: initialsFrom(u.name),
    color: u.avatar_color,
    createdAt: u.created_at,
    emailVerified: !!u.email_verified,
    lastLogin: u.last_login,
    isDemo: !!u.is_demo,
  };
}
/* Person view used by the UI (avatars, assignee dropdowns). */
function personView(u) {
  return { id: String(u.id), name: u.name, initials: initialsFrom(u.name), color: u.avatar_color, email: u.email };
}

/* ------------------------------------------------------------------ */
/* Security middleware: rate limiting, headers, CORS                  */
/* ------------------------------------------------------------------ */
const rateBuckets = new Map(); // key -> { count, reset }
function rateLimit(key, limit, windowMs) {
  // Test hook: TASKHIVE_RATE_LIMIT_BYPASS=1 disables all rate limiting so the
  // smoke suite can run many auth attempts. The suite re-enables the limiter
  // for its dedicated 429 test by restarting the server without this env var.
  if (process.env.TASKHIVE_RATE_LIMIT_BYPASS === '1') return { allowed: true, retryAfter: 0 };
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
  b.count++;
  if (rateBuckets.size > 5000) { // housekeeping
    for (const [k, v] of rateBuckets) if (v.reset <= now) rateBuckets.delete(k);
  }
  return { allowed: b.count <= limit, retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
}
function clientIp(req) {
  if (process.env.TASKHIVE_TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
};
function corsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const self = req.headers.host ? `http://${req.headers.host}` : null;
  const selfT = req.headers.host ? `https://${req.headers.host}` : null;
  if (origin === self || origin === selfT) return origin;
  const allow = (process.env.TASKHIVE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allow.includes(origin) ? origin : null;
}

/* ------------------------------------------------------------------ */
/* Router helpers                                                      */
/* ------------------------------------------------------------------ */
const VALID_PROGRESS = ['Ongoing', 'In review', 'Completed', 'Pending', 'On hold'];
const VALID_URGENCY  = ['Critical', 'Moderate', 'Minor'];

function send(res, status, body, headers = {}, raw) {
  const payload = raw !== undefined ? raw : (typeof body === 'string' ? body : JSON.stringify(body));
  const base = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (res && typeof res.writeHead === 'function' && !('headersSent' in res)) {
    res.writeHead(status, { ...base, ...SECURITY_HEADERS, ...headers });
    res.end(payload);
    return;
  }
  res.writeHead(status, { ...base, ...SECURITY_HEADERS, ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req._body !== undefined) return resolve(req._body || {});   // serverless shim
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

function guardWrite(res) {
  if (READONLY_API) { send(res, 503, { error: 'this deployment is read-only (serverless preview); use the Render service for writes' }); return true; }
  return false;
}

function sanitizeTask(input, existing = {}, ctx = null) {
  const t = { ...existing };
  if (typeof input.name === 'string' && input.name.trim()) t.name = cleanStr(input.name, 200);
  if (input.progress !== undefined) {
    if (!VALID_PROGRESS.includes(input.progress)) throw new Error(`invalid progress "${input.progress}"`);
    t.progress = input.progress;
  }
  if (input.urgency !== undefined) {
    if (!VALID_URGENCY.includes(input.urgency)) throw new Error(`invalid urgency "${input.urgency}"`);
    t.urgency = input.urgency;
  }
  if (input.assignee !== undefined) {
    const a = cleanStr(String(input.assignee ?? ''), 40);
    if (!a) { t.assignee = null; }               /* "Unassigned" is a valid choice */
    else if (/^inv-/.test(a)) {
      /* Pending invites are assignable right away; they show as "Invited"
       * avatars until the person signs up with that email. */
      const invOk = sqlite.prepare('SELECT 1 AS x FROM invited_members WHERE workspace_id=? AND id=? AND user_id IS NULL')
        .get(ctx.workspace.id, Number(a.slice(4)));
      if (!invOk) throw new Error(`assignee not in your workspace`);
      t.assignee = a;
    } else if (ctx) {
      const ok = sqlite.prepare('SELECT 1 AS x FROM memberships WHERE workspace_id=? AND user_id=?').get(ctx.workspace.id, Number(a));
      if (!ok) throw new Error(`assignee not in your workspace`);
      t.assignee = a;
    } else {
      if (!/^\d+$/.test(a)) throw new Error(`unknown assignee "${a}"`);
      t.assignee = a;
    }
  }
  if (input.project !== undefined) {
    const pid = cleanStr(String(input.project ?? ''), 80);
    if (!pid) { t.project = null; }        /* "No project" is a valid choice */
    else {
      if (ctx && !wsStmt.projectById().get(ctx.workspace.id, pid)) throw new Error(`unknown project "${pid}"`);
      t.project = pid;
    }
  }
  if (input.comments !== undefined) {
    const n = Number(input.comments);
    if (!Number.isInteger(n) || n < 0) throw new Error('comments must be a non-negative integer');
    t.comments = n;
  }
  return t;
}

function writeTaskRow(ctx, t) {
  wsStmt.taskUpsert().run({
    id: t.id, workspace_id: ctx.workspace.id, idx: t.idx ?? null, name: t.name,
    progress: t.progress, urgency: t.urgency, assignee: t.assignee ?? null,
    project: t.project ?? null, comments: t.comments ?? 0, ord: t.ord ?? 0,
    deleted_at: t.deletedAt || null, created_at: t.createdAt || new Date().toISOString(),
  });
}

function userPrefs(ctx) {
  const row = wsStmt.prefsGet().get(ctx.workspace.id, ctx.user.id);
  const p = row ? {
    savedIds: JSON.parse(row.saved_ids || '[]'),
    readFlags: JSON.parse(row.read_flags || '{}'),
    ui: JSON.parse(row.ui || '{}'),
  } : { savedIds: [], readFlags: {}, ui: {} };
  if (!Array.isArray(p.savedIds)) p.savedIds = [];
  if (!p.readFlags || typeof p.readFlags !== 'object') p.readFlags = {};
  if (!p.ui || typeof p.ui !== 'object') p.ui = {};
  return p;
}
function savePrefs(ctx, p) {
  const j = [JSON.stringify(p.savedIds), JSON.stringify(p.readFlags), JSON.stringify(p.ui)];
  sqlite.prepare('INSERT INTO prefs (workspace_id,user_id,saved_ids,read_flags,ui) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(workspace_id,user_id) DO UPDATE SET saved_ids=excluded.saved_ids, read_flags=excluded.read_flags, ui=excluded.ui')
    .run(ctx.workspace.id, ctx.user.id, ...j);
}

function workspacePeople(ctx) {
  const active = sqlite.prepare(`SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id
    WHERE m.workspace_id=? ORDER BY u.id`).all(ctx.workspace.id).map(personView);
  /* Pending invites appear in the same list (avatars, assignee dropdowns) and
   * become real accounts automatically when that email signs up. */
  let invited = [];
  try {
    invited = sqlite.prepare(`SELECT id, name, email FROM invited_members WHERE workspace_id=? AND user_id IS NULL ORDER BY id`)
      .all(ctx.workspace.id)
      .map(r => ({ id: 'inv-' + r.id, name: r.name, initials: initialsFrom(r.name), color: '#8a93a6', email: r.email, invited: true }));
  } catch (_) {}
  return [...active, ...invited];
}

function bootstrapPayload(ctx) {
  const prefs = userPrefs(ctx);
  const people = workspacePeople(ctx);
  const byKey = Object.fromEntries(people.map(p => [p.id, p]));
  const projects = wsStmt.projectsAll().all(ctx.workspace.id).map(projectFromRow);
  const tasks = wsStmt.tasksAll().all(ctx.workspace.id).map(taskFromRow);
  const inbox = wsStmt.inboxAll().all(ctx.workspace.id).map(it => {
    const actor = byKey[it.actor_key] || { name: 'Someone', initials: '?', color: '#888' };
    return { id: it.id, who: actor.name, initials: actor.initials, color: actor.color,
             text: it.text, task: it.task, at: it.at, unread: !prefs.readFlags[it.id] };
  });
  const messages = {};
  const discussions = {};
  const channels = [];
  const channelMeta = {};   /* { id: { topic } } so the client can hydrate its CHANNELS map */
  for (const ch of wsStmt.channelsAll().all(ctx.workspace.id)) {
    channels.push(ch.id);
    channelMeta[ch.id] = { topic: ch.topic || '' };
    messages[ch.id] = wsStmt.msgsByChannel().all(ctx.workspace.id, ch.id).map(m => {
      const actor = byKey[m.actor_key] || { name: 'Someone', initials: '?', color: '#888' };
      return { by: m.actor_key, who: actor.name, initials: actor.initials, color: actor.color, text: m.text, time: m.time };
    });
  }
  for (const t of tasks) {
    const list = wsStmt.discByTask().all(ctx.workspace.id, t.id);
    if (list.length) discussions[t.id] = list.map(c => {
      const actor = byKey[c.actor_key] || { name: 'Someone', initials: '?', color: '#888' };
      return { by: c.actor_key, who: actor.name, initials: actor.initials, color: actor.color, text: c.text, at: c.at };
    });
  }
  return {
    user: publicUser(ctx.user),
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name, kind: ctx.workspace.kind,
                 role: ctx.membership.role, readOnly: ctx.workspace.kind === 'demo',
                 createdAt: ctx.workspace.created_at },
    people, projects: projects.map(p => ({ ...p, open: tasks.filter(t => t.project === p.id && t.progress !== 'Completed').length })),
    tasks, inbox, discussions, messages, channels: channelMeta,
    savedIds: prefs.savedIds, readFlags: prefs.readFlags, ui: prefs.ui,
  };
}

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */
async function authHandler(req, res, ctx, routeKey, method) {
if (!sqlite) return send(res, 503, { error: 'database unavailable' });
    // Global auth bucket applies only to credential endpoints (login/signup/demo).
    // Read-only session checks (/me, /logout) must not consume or trip it.
    if (routeKey !== 'me' && routeKey !== 'logout') {
      const rl = rateLimit(`auth:${clientIp(req)}`, 20, 60e3);
      if (!rl.allowed) return send(res, 429, { error: 'Too many attempts — try again later' }, { 'Retry-After': String(rl.retryAfter) });
    }

    /* GET /api/auth/me — restore the session on app load */
    if (routeKey === 'me' && method === 'GET') {
      if (!ctx) return send(res, 401, { error: 'not authenticated' });
      return send(res, 200, { user: publicUser(ctx.user),
        workspace: { id: ctx.workspace.id, name: ctx.workspace.name, kind: ctx.workspace.kind,
                     role: ctx.membership.role, readOnly: ctx.workspace.kind === 'demo' } });
    }

    /* POST /api/auth/signup */
    if (routeKey === 'signup' && method === 'POST') {
      if (guardWrite(res)) return;
      const sr = rateLimit(`signup:${clientIp(req)}`, 5, 15 * 60e3);
      if (!sr.allowed) return send(res, 429, { error: 'Too many sign-ups from this address — try again later' }, { 'Retry-After': String(sr.retryAfter) });
      let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
      const name = cleanStr(b.name, 80);
      const email = normalizeEmail(b.email);            // shared normalization (trim + lowercase)
      const password = typeof b.password === 'string' ? b.password : '';
      const errors = [];
      if (name.length < 2) errors.push('Please enter your name (min 2 characters)');
      if (!EMAIL_RE.test(email)) errors.push('Please enter a valid email address');
      if (password.length < 8) errors.push('Password must be at least 8 characters');
      if (errors.length) return send(res, 400, { error: errors.join('. ') });
      if (getUserByEmail(email)) {
        return send(res, 409, { error: 'That email is already registered. Try logging in instead.' });
      }
      const color = AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)];
      /* If the INSERT fails (constraint or disk error) createUser now throws —
       * answer 500 instead of pretending signup succeeded. */
      let userId;
      try { userId = createUser({ name, email, password, color, isDemo: false }); }
      catch (e) { console.error('[auth] signup insert failed:', e.message); return send(res, 500, { error: 'could not create account' }); }
      claimInvitationsForUser(userId, email);   /* pending "Add person" invites become Active now */
      /* Sample data is strictly OPT-IN: only seed when the checkbox was ticked.
   * (Previously everything except explicit false/0/'false' counted as a yes,
   * so unchecked forms / non-boolean payloads still got the demo board.) */
  const wantsSample = b.sampleData === true || b.sampleData === 1 || b.sampleData === 'true';
      const wsId = provisionUser(userId, { sample: wantsSample });
      sqlite.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), userId);
      const token = createSession(userId, wsId);
      const fresh = sqlite.prepare('SELECT * FROM users WHERE id=?').get(userId);
      return send(res, 201, { user: publicUser(fresh), workspace: { id: wsId, readOnly: false } },
        { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }

    /* POST /api/auth/login */
    if (routeKey === 'login' && method === 'POST') {
      if (guardWrite(res)) return;
      const lr = rateLimit(`login:${clientIp(req)}`, 10, 60e3);
      if (!lr.allowed) return send(res, 429, { error: 'Too many login attempts — try again later' }, { 'Retry-After': String(lr.retryAfter) });
      let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
      const email = normalizeEmail(b.email);            // same shared normalization as signup
      const password = typeof b.password === 'string' ? b.password : '';
      const u = getUserByEmail(email, true);
      /* Temporary login-failure diagnostics: reason only — never the password,
       * and only a salted fingerprint of the email to correlate rows. The
       * client always gets the same generic message either way. */
      if (!u) {
        logAuthFail('login', email, 'user not found');
        return send(res, 401, { error: 'Invalid email or password' });
      }
      const ok = verifyPassword(password, u.password_hash);
      if (!ok) {
        logAuthFail('login', email, `password mismatch (user id ${u.id}, stored-hash-format ${String(u.password_hash).slice(0, 2)})`);
        return send(res, 401, { error: 'Invalid email or password' });   // generic on purpose
      }
      if (ok === 'migrate') sqlite.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), u.id);
      const ws = sqlite.prepare('SELECT w.* FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY m.workspace_id LIMIT 1').get(u.id);
      const token = createSession(u.id, ws ? ws.id : null);
      sqlite.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), u.id);
      const fresh = sqlite.prepare('SELECT * FROM users WHERE id=?').get(u.id);
      return send(res, 200, { user: publicUser(fresh), workspace: ws ? { id: ws.id, kind: ws.kind, readOnly: ws.kind === 'demo' } : null },
        { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }

    /* Claim any pending invitations for a freshly created account: an invited
   * person added via "Add person" becomes an Active member the moment they
   * sign up with the same (normalized) email. Parameterized only. */
function claimInvitationsForUser(userId, email) {
  if (!sqlite) return;
  try {
    const rows = sqlite.prepare('SELECT id, workspace_id FROM invited_members WHERE email=? AND user_id IS NULL').all(email);
    for (const r of rows) {
      addMembership(r.workspace_id, userId, 'member');
      sqlite.prepare('UPDATE invited_members SET user_id=? WHERE id=?').run(userId, r.id);
    }
  } catch (_) {}
}

/* POST /api/auth/demo — log into the shared, resettable demo workspace */
    if (routeKey === 'demo' && method === 'POST') {
      if (guardWrite(res)) return;
      const dr = rateLimit(`demo:${clientIp(req)}`, 10, 60e3);
      if (!dr.allowed) return send(res, 429, { error: 'Too many attempts — try again later' }, { 'Retry-After': String(dr.retryAfter) });
      const demoWsId = Number(getMeta('demo_workspace_id'));
      const u = sqlite.prepare('SELECT * FROM users WHERE email=?').get('parth@catlas.inc');
      if (!demoWsId || !u) return send(res, 503, { error: 'demo workspace not available' });
      const token = createSession(u.id, demoWsId);
      sqlite.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), u.id);
      return send(res, 200, { user: publicUser(sqlite.prepare('SELECT * FROM users WHERE id=?').get(u.id)),
                              workspace: { id: demoWsId, kind: 'demo', readOnly: true } },
        { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }

    /* POST /api/auth/demo/reset — restore pristine demo data (only inside demo ws) */
    if (routeKey === 'demo/reset' && method === 'POST') {
      if (guardWrite(res)) return;
      if (!ctx || ctx.workspace.kind !== 'demo') return send(res, 403, { error: 'only available in the demo workspace' });
      sqlite.prepare('DELETE FROM workspaces WHERE id=?').run(ctx.workspace.id);
      const wsId = seedDemoWorkspace();
      const token = createSession(ctx.user.id, wsId);
      return send(res, 200, { ok: true, workspace: { id: wsId } }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }

    /* POST /api/auth/logout — always 200 + always clear the cookie. The old
     * code only cleared it when a valid session was still found, so logging in
     * from another device (or any stale/foreign cookie) left our cookie live;
     * combined with opportunistic server-side session GC that is exactly how a
     * user ends up "signed out" while their next login reads a dead row. */
    if (routeKey === 'logout' && method === 'POST') {
      const tok = parseCookies(req)[COOKIE_NAME];
      if (tok) destroySession(tok);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('deleted', 0) });
    }

    /* Nothing matched under /api/auth/* */
    return send(res, 404, { error: 'unknown auth endpoint' });
}

async function handleApi(req, res, url) {
  let pathname = url.pathname;
  /* Normalization: tolerate trailing slashes and deploy-time base prefixes
   * (e.g. Render/Nginx serving the app under /taskhive). Without this, a
   * path like /base/api/auth/signup would parse as seg='base' and every
   * auth call would fall through to "unknown auth endpoint". */
  const apiIdx = pathname.indexOf('/api/');
  if (apiIdx > 0) pathname = pathname.slice(apiIdx);           // strip prefix before /api/
  pathname = pathname.replace(/\/+$/, '') || '/';              // drop trailing slash(es)
  const parts = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const seg = parts[0] || '';
  const param = parts[1];
  const method = req.method;
  const routeKey = parts.join('/');
  if (process.env.TASKHIVE_DEBUG_ROUTES) console.error(`[routes] ${method} ${url.pathname} -> seg=${seg} routeKey=${routeKey}`);

  /* --- health check (unauthenticated; used by Render health probes) --- */
  if (seg === 'health' && method === 'GET') {
    const counts = sqlite ? sqlite.prepare('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL) t').get() : { u: 0, t: 0 };
    return send(res, 200, { ok: true, service: 'taskhive', uptime: Math.round(process.uptime()) + 's',
                            users: counts.u, tasks: counts.t, storage: sqlite ? 'sqlite-relational' : 'none' });
  }

  const ctx = authContext(req);

  /* ================= AUTH API (/api/auth/*) ================= */
  if (seg === 'auth') return authHandler(req, res, ctx, parts.slice(1).join('/'), method);

  /* Legacy aliases kept for older clients: /api/login /api/logout /api/session.
   * NOTE: do NOT re-enter handleApi here — with the path normalization above,
   * /api/login would be rewritten to /api/auth/login and dispatch back into
   * the auth block, recursing until the stack overflows (crashing the whole
   * process). Delegate straight to the canonical handler instead. */
  if ((seg === 'login' || seg === 'logout') && !sqlite) return send(res, 503, { error: 'database unavailable' });
  /* authHandler signature is (req, res, ctx, routeKey, method) — pass the HTTP
   * method as the 5th argument, NOT a path fragment (previously parts.slice(1)
   * landed in `method`, so 'login' !== undefined and every legacy call fell
   * through to the 404 "unknown auth endpoint"). */
  if (seg === 'login'  && method === 'POST') return authHandler(req, res, ctx, 'login',  method);
  if (seg === 'logout' && method === 'POST') return authHandler(req, res, ctx, 'logout', method);
  if (seg === 'session' && method === 'GET') {
    return send(res, 200, ctx ? { user: publicUser(ctx.user) } : { user: null });
  }

  /* ================= PROTECTED DATA API ================= */
  /* Every route below requires a session (401 otherwise) and is scoped to
   * the caller's active workspace — cross-workspace ids simply 404. */
  if (!ctx) return send(res, 401, { error: 'authentication required', login: '/login' });
  if (method !== 'GET' && guardWrite(res)) return;

  const wsId = ctx.workspace.id;
  const readOnly = ctx.workspace.kind === 'demo' && ctx.membership.role === 'demo';
  const denyReadOnly = () => { send(res, 403, { error: 'demo workspace is read-only — create your own account to edit' }); return true; };

  /* --- bootstrap: everything the frontend needs in one call --- */
  if (seg === 'bootstrap' && method === 'GET') {
    return send(res, 200, bootstrapPayload(ctx));
  }

  /* --- export: JSON snapshot of THIS workspace only --- */
  if (routeKey === 'export' && method === 'GET') {
    const snap = bootstrapPayload(ctx);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), version: 3, scope: 'workspace', db: snap }, null, 2);
    return send(res, 200, undefined, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="taskhive-backup-${stamp}.json"`,
    }, body);
  }

  /* --- import: replace THIS workspace's content with an export snapshot (admins only) --- */
  if (routeKey === 'import' && method === 'POST') {
    if (ctx.membership.role !== 'admin') return send(res, 403, { error: 'only your workspace admin can import' });
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const incoming = (b && b.db) ? b.db : b;
    if (!incoming || !Array.isArray(incoming.tasks) || !Array.isArray(incoming.people)) {
      return send(res, 400, { error: 'invalid snapshot: expected an export JSON with tasks[] and people[]' });
    }
    const tx = sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM tasks WHERE workspace_id=?').run(wsId);
      sqlite.prepare('DELETE FROM projects WHERE workspace_id=?').run(wsId);
      sqlite.prepare('DELETE FROM inbox_items WHERE workspace_id=?').run(wsId);
      sqlite.prepare('DELETE FROM channel_messages WHERE workspace_id=?').run(wsId);
      sqlite.prepare('DELETE FROM discussions WHERE workspace_id=?').run(wsId);
      const peopleKeys = {};
      for (const p of incoming.people) {
        let id = sqlite.prepare('SELECT id FROM users WHERE email=?').get(String(p.email || '').toLowerCase())?.id;
        if (!id) id = createUser({ name: p.name || 'Imported user', email: p.email || `imported-${p.id}@catlas.invalid`, password: DEMO_PASSWORD, color: p.color || '#888', isDemo: true });
        addMembership(wsId, id, 'member');
        peopleKeys[String(p.id)] = String(id);
      }
      const mapKey = (k) => k == null ? null : (peopleKeys[String(k)] ?? String(k));
      (incoming.projects || []).forEach((pr, i) => {
        wsStmt.projectUpsert().run({ id: pr.id, workspace_id: wsId, name: cleanStr(pr.name, 120), descr: cleanStr(pr.desc, 500),
          members: JSON.stringify((pr.members || []).map(mapKey)), idx: i,
          color: /^#[0-9a-fA-F]{6}$/.test(String(pr.color || '')) ? String(pr.color) : '#7c8cff' });
      });
      (incoming.tasks || []).forEach((t, i) => {
        wsStmt.taskUpsert().run({ id: t.id, workspace_id: wsId, idx: t.idx ?? (1000 + i), name: cleanStr(t.name, 200),
          progress: VALID_PROGRESS.includes(t.progress) ? t.progress : 'Pending',
          urgency: VALID_URGENCY.includes(t.urgency) ? t.urgency : 'Moderate',
          assignee: mapKey(t.assignee), project: t.project, comments: t.comments || 0, ord: i + 1,
          deleted_at: null, created_at: t.createdAt || new Date().toISOString() });
      });
      (incoming.inbox || []).forEach((it, i) => {
        sqlite.prepare('INSERT OR IGNORE INTO inbox_items (id,workspace_id,actor_key,text,task,at,ord) VALUES (?,?,?,?,?,?,?)')
          .run(it.id, wsId, mapKey(SEED_PEOPLE.find(x => x.name === it.who)?.key), cleanStr(it.text, 300), it.task, it.at || new Date().toISOString(), i);
      });
      const maxNum = (incoming.tasks || []).reduce((m, t) => Math.max(m, parseInt(String(t.id).replace(/\D/g, ''), 10) || 0), 99);
      const maxIdx = (incoming.tasks || []).reduce((m, t) => Math.max(m, t.idx || 0), 0);
      wsStmt.counterBump().run(wsId, maxNum + 1, maxIdx + 100);
    });
    tx();
    return send(res, 200, { ok: true, tasks: incoming.tasks.length, people: incoming.people.length });
  }

  /* --- purge: permanently remove soft-deleted task rows in this workspace --- */
  if (routeKey === 'purge' && method === 'POST') {
    const info = sqlite.prepare('DELETE FROM tasks WHERE workspace_id=? AND deleted_at IS NOT NULL').run(wsId);
    return send(res, 200, { ok: true, purged: info.changes || 0 });
  }

  /* --- reset demo workspace back to pristine seed (any member of the demo ws) --- */
  if (routeKey === 'reset-demo' && method === 'POST') {
    if (ctx.workspace.kind !== 'demo') return send(res, 403, { error: 'only the demo workspace can be reset' });
    sqlite.prepare('DELETE FROM workspaces WHERE id=?').run(wsId);
    const newId = seedDemoWorkspace();
    const token = createSession(ctx.user.id, newId);
    return send(res, 200, { ok: true, workspace: { id: newId } }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  /* --- people (workspace members only) --- */
  if (seg === 'people') {
    if (method === 'GET' && !param) return send(res, 200, workspacePeople(ctx));
    if (param) {
      const target = sqlite.prepare('SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=? AND u.id=?').get(wsId, Number(param));
      if (!target) return send(res, 404, { error: 'person not found' });
      if (method === 'GET') return send(res, 200, personView(target));
      if (method === 'PATCH' || method === 'PUT') {
        if (readOnly) return denyReadOnly();
        if (ctx.user.id !== target.id) return send(res, 403, { error: 'you can only edit your own profile' });
        const b = await readBody(req);
        const upd = {};
        if (typeof b.name === 'string' && cleanStr(b.name, 80).length >= 2) upd.name = cleanStr(b.name, 80);
        if (typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color)) upd.color = b.color;
        if (typeof b.email === 'string' && EMAIL_RE.test(normalizeEmail(b.email))) {
          const em = normalizeEmail(b.email);
          if (sqlite.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(em, target.id)) {
            return send(res, 409, { error: 'That email is already registered' });
          }
          upd.email = em;
        }
        if (b.password !== undefined) {
          const np = String(b.password);
          if (np.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
          upd.hash = hashPassword(np);
        }
        if (upd.name) sqlite.prepare('UPDATE users SET name=? WHERE id=?').run(upd.name, target.id);
        if (upd.color) sqlite.prepare('UPDATE users SET avatar_color=? WHERE id=?').run(upd.color, target.id);
        if (upd.email) sqlite.prepare('UPDATE users SET email=? WHERE id=?').run(upd.email, target.id);
        if (upd.hash) sqlite.prepare('UPDATE users SET password_hash=? WHERE id=?').run(upd.hash, target.id);
        const fresh = sqlite.prepare('SELECT * FROM users WHERE id=?').get(target.id);
        return send(res, 200, personView(fresh));
      }
      return send(res, 405, { error: 'method not allowed' });
    }
  }

  /* --- inbox (workspace notifications + per-user read flags) --- */
  if (seg === 'inbox') {
    const prefs = userPrefs(ctx);
    const byKey = Object.fromEntries(workspacePeople(ctx).map(p => [p.id, p]));
    const shape = (it) => {
      const actor = byKey[it.actor_key] || { name: 'Someone', initials: '?', color: '#888' };
      return { id: it.id, who: actor.name, initials: actor.initials, color: actor.color,
               text: it.text, task: it.task, at: it.at, unread: !prefs.readFlags[it.id] };
    };
    if (method === 'GET' && !param) return send(res, 200, wsStmt.inboxAll().all(wsId).map(shape));
    if (method === 'PATCH' && param === 'read-all') {
      if (readOnly) return denyReadOnly();
      wsStmt.inboxAll().all(wsId).forEach(it => { prefs.readFlags[it.id] = true; });
      savePrefs(ctx, prefs);
      return send(res, 200, { ok: true });
    }
    const it = wsStmt.inboxById().get(wsId, param);
    if (!it) return send(res, 404, { error: 'inbox item not found' });
    if (method === 'PATCH' || method === 'PUT') {
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      if (b.unread === false || b.read === true) prefs.readFlags[it.id] = true;
      if (b.unread === true) delete prefs.readFlags[it.id];
      savePrefs(ctx, prefs);
      return send(res, 200, shape(it));
    }
    if (method === 'DELETE') {
      if (readOnly) return denyReadOnly();
      sqlite.prepare('DELETE FROM inbox_items WHERE workspace_id=? AND id=?').run(wsId, param);
      return send(res, 200, { deleted: true, id: param });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- task discussions (Properties panel comments) --- */
  if (seg === 'discussions') {
    const shapeList = () => wsStmt.discByTask().all(wsId, param).map(c => {
      const byKey = Object.fromEntries(workspacePeople(ctx).map(p => [p.id, p]));
      const actor = byKey[c.actor_key] || { name: 'Someone', initials: '?', color: '#888' };
      return { by: c.actor_key, who: actor.name, initials: actor.initials, color: actor.color, text: c.text, at: c.at };
    });
    if (method === 'GET' && param) return send(res, 200, shapeList());
    if (method === 'POST' && param) {
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      const text = cleanStr(b.text, 2000);
      if (!text) return send(res, 400, { error: 'text is required' });
      const task = wsStmt.taskById().get(wsId, param);
      if (!task || task.deleted_at) return send(res, 404, { error: 'task not found' });
      wsStmt.discInsert().run(wsId, param, String(ctx.user.id), text, new Date().toISOString());
      const comments = (task.comments || 0) + 1;
      writeTaskRow(ctx, { ...taskFromRow(task), comments });
      return send(res, 201, { comment: { by: String(ctx.user.id), who: ctx.user.name, initials: initialsFrom(ctx.user.name),
                                         color: ctx.user.avatar_color, text, at: new Date().toISOString() }, comments });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- workspace members incl. pending invitations (admins manage) --- */
  if (seg === 'members') {
    const listPeople = workspacePeople(ctx);
    let invites = [];
    try {
      invites = sqlite.prepare('SELECT * FROM invited_members WHERE workspace_id=? ORDER BY id').all(wsId);
    } catch (_) {}
    const rows = listPeople.map(p => ({ ...p, status: p.invited ? 'invited' : 'active', role: 'member' }));
    for (const r of rows) {
      const m = sqlite.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(wsId, Number(r.id));
      if (m) r.role = m.role;
    }
    const invRows = invites.filter(i => !i.user_id).map(i => ({
      id: 'inv-' + i.id, name: i.name, email: i.email, role: i.role,
      status: 'invited', initials: initialsFrom(i.name), color: '#8a93a6', invited: true,
    }));
    if (method === 'GET' && !param) return send(res, 200, [...rows, ...invRows]);
    if (method === 'POST' && !param) {
      if (ctx.membership.role !== 'admin') return send(res, 403, { error: 'only workspace admins can add people' });
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      const name = cleanStr(b.name, 80);
      const email = normalizeEmail(String(b.email || ''));
      const role = b.role === 'admin' ? 'admin' : 'member';
      if (name.length < 2) return send(res, 400, { error: 'Please enter a full name (min 2 characters)' });
      if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Please enter a valid email address' });
      const existing = getUserByEmail(email);
      if (existing) {
        const already = sqlite.prepare('SELECT 1 AS x FROM memberships WHERE workspace_id=? AND user_id=?').get(wsId, existing.id);
        if (already) return send(res, 409, { error: `${email} is already a member of this workspace` });
        addMembership(wsId, existing.id, role);
        try { sqlite.prepare('INSERT OR IGNORE INTO invited_members (workspace_id,email,name,role,invited_by,user_id,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(wsId, email, name, role, ctx.user.id, existing.id, new Date().toISOString()); } catch (_) {}
        return send(res, 201, { ok: true, joined: true, person: personView(sqlite.prepare('SELECT * FROM users WHERE id=?').get(existing.id)) });
      }
      const dupInvite = invites.find(i => i.email === email && !i.user_id);
      if (dupInvite) return send(res, 409, { error: `${email} has already been invited to this workspace` });
      let invId;
      try {
        invId = sqlite.prepare('INSERT INTO invited_members (workspace_id,email,name,role,invited_by,created_at) VALUES (?,?,?,?,?,?)')
          .run(wsId, email, name, role, ctx.user.id, new Date().toISOString()).lastInsertRowid;
      } catch (e) { return send(res, 409, { error: `${email} has already been invited to this workspace` }); }
      return send(res, 201, { ok: true, invited: true, person: { id: 'inv-' + invId, name, email, role, status: 'invited',
        initials: initialsFrom(name), color: '#8a93a6', invited: true } });
    }
    if (method === 'DELETE' && param) {
      if (ctx.membership.role !== 'admin') return send(res, 403, { error: 'only workspace admins can remove people' });
      if (readOnly) return denyReadOnly();
      if (String(param).startsWith('inv-')) {
        const invNum = Number(param.slice(4));
        const info = sqlite.prepare('DELETE FROM invited_members WHERE workspace_id=? AND id=? AND user_id IS NULL').run(wsId, invNum);
        if (!info.changes) return send(res, 404, { error: 'invitation not found' });
        /* Removing an invite unassigns their tasks but never deletes them. */
        sqlite.prepare('UPDATE tasks SET assignee = NULL WHERE workspace_id=? AND assignee=?').run(wsId, 'inv-' + invNum);
        return send(res, 200, { deleted: true, id: param, unassignedTasks: true });
      }
      const uid = Number(param);
      if (!uid) return send(res, 400, { error: 'invalid member id' });
      if (uid === ctx.user.id) return send(res, 400, { error: 'you cannot remove yourself' });
      const target = sqlite.prepare('SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=? AND u.id=?').get(wsId, uid);
      if (!target) return send(res, 404, { error: 'person not found in this workspace' });
      const owner = sqlite.prepare('SELECT owner_id FROM workspaces WHERE id=?').get(wsId);
      if (owner && owner.owner_id === uid) return send(res, 400, { error: 'the workspace owner cannot be removed' });
      const tx = sqlite.transaction(() => {
        sqlite.prepare('UPDATE tasks SET assignee = NULL WHERE workspace_id=? AND assignee=?').run(wsId, String(uid));
        sqlite.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(wsId, uid);
        try { sqlite.prepare('DELETE FROM invited_members WHERE workspace_id=? AND user_id=?').run(wsId, uid); } catch (_) {}
      });
      tx();
      return send(res, 200, { deleted: true, id: param, unassignedTasks: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- projects --- */
  if (seg === 'projects') {
    const tasks = wsStmt.tasksAll().all(wsId);
    if (method === 'GET' && !param) {
      return send(res, 200, wsStmt.projectsAll().all(wsId).map(projectFromRow)
        .map(p => ({ ...p, open: tasks.filter(t => t.project === p.id && t.progress !== 'Completed').length })));
    }
    if (method === 'POST' && !param) {
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      const name = cleanStr(b.name, 120);
      if (!name) return send(res, 400, { error: 'name is required' });
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + crypto.randomBytes(2).toString('hex');
      const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color || '')) ? String(b.color) : '#7c8cff';
      const proj = { id, name, desc: cleanStr(b.desc, 500), members: [String(ctx.user.id)],
                     idx: wsStmt.projectsAll().all(wsId).length, color };
      wsStmt.projectUpsert().run({ id, workspace_id: wsId, name: proj.name, descr: proj.desc, members: JSON.stringify(proj.members), idx: proj.idx, color });
      return send(res, 201, proj);
    }
    const prow = wsStmt.projectById().get(wsId, param);
    if (!prow) return send(res, 404, { error: 'project not found' });
    const proj = projectFromRow(prow);
    if (method === 'GET') return send(res, 200, proj);
    if (method === 'PATCH' || method === 'PUT') {
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      if (b.name) proj.name = cleanStr(b.name, 120);
      if (b.desc !== undefined) proj.desc = cleanStr(b.desc, 500);
      if (Array.isArray(b.members)) proj.members = b.members.map(String).slice(0, 200);
      if (/^#[0-9a-fA-F]{6}$/.test(String(b.color || ''))) proj.color = String(b.color);
      wsStmt.projectUpsert().run({ id: proj.id, workspace_id: wsId, name: proj.name, descr: proj.desc, members: JSON.stringify(proj.members), idx: proj.idx, color: proj.color });
      return send(res, 200, proj);
    }
    if (method === 'DELETE') {
      if (readOnly) return denyReadOnly();
      wsStmt.projectDelete().run(wsId, param);
      for (const t of tasks.filter(t => t.project === param)) {
        wsStmt.taskSoftDel().run(new Date().toISOString(), wsId, t.id);
      }
      return send(res, 200, { deleted: true, id: param });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- tasks --- */
  if (seg === 'tasks') {
    if (method === 'GET' && !param) {
      let list = wsStmt.tasksAll().all(wsId).map(taskFromRow);
      if (url.searchParams.has('project'))  list = list.filter(t => t.project === url.searchParams.get('project'));
      if (url.searchParams.has('progress')) list = list.filter(t => t.progress === url.searchParams.get('progress'));
      if (url.searchParams.has('urgency'))  list = list.filter(t => t.urgency === url.searchParams.get('urgency'));
      if (url.searchParams.has('assignee')) list = list.filter(t => String(t.assignee) === url.searchParams.get('assignee'));
      if (url.searchParams.has('q')) {
        const q = String(url.searchParams.get('q')).toLowerCase();
        list = list.filter(t => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
      }
      if (url.searchParams.has('limit') || url.searchParams.has('offset')) {
        const rawLimit = url.searchParams.get('limit');
        const rawOffset = url.searchParams.get('offset');
        // Reject non-numeric / negative values instead of silently coercing them.
        if ((rawLimit !== null && !/^\d+$/.test(rawLimit)) ||
            (rawOffset !== null && !/^\d+$/.test(rawOffset))) {
          return send(res, 400, { error: 'limit and offset must be non-negative integers' });
        }
        const limit  = Math.min(500, Math.max(1, Number(rawLimit)  || 25));
        const offset = Math.max(0, Number(rawOffset) || 0);
        return send(res, 200, { total: list.length, limit, offset, items: list.slice(offset, offset + limit) });
      }
      return send(res, 200, list);
    }
    if (method === 'POST' && !param) {
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      const name = cleanStr(b.name, 200);
      if (!name) return send(res, 400, { error: 'name is required' });
      const projects = wsStmt.projectsAll().all(wsId);
      const defaultProject = b.project || null;   /* tasks may live outside any project */
      if (b.project && !projects.some(p => p.id === b.project)) return send(res, 400, { error: `unknown project "${b.project}"` });
      const { ids, idxs } = allocIds(wsId, 1);
      let task;
      try {
        task = sanitizeTask(b, {
          id: ids[0], name, progress: b.progress || 'Pending', urgency: b.urgency || 'Moderate',
          assignee: b.assignee || String(ctx.user.id), project: defaultProject,
          comments: 0, idx: idxs[0], createdAt: new Date().toISOString(),
        }, ctx);
      } catch (e) { return send(res, 400, { error: e.message }); }
      if (!task.progress || !VALID_PROGRESS.includes(task.progress)) task.progress = 'Pending';
      if (!task.urgency || !VALID_URGENCY.includes(task.urgency)) task.urgency = 'Moderate';
      task.ord = wsStmt.taskMaxOrd().get(wsId).n;
      writeTaskRow(ctx, task);
      return send(res, 201, task);
    }
    const findTask = () => {
      let row = wsStmt.taskById().get(wsId, param);
      if (!row && /^\d+$/.test(param)) row = wsStmt.taskByIdx().get(wsId, Number(param));
      return row;
    };
    const row = findTask();
    if (!row) {
      if (method === 'GET') {
        const gone = wsStmt.taskDeleted().get(wsId, param);
        if (gone) return send(res, 410, { error: 'task deleted', id: gone.id, deletedAt: gone.deleted_at });
      }
      return send(res, 404, { error: 'task not found' });
    }
    const task = taskFromRow(row);
    if (row.deleted_at && method !== 'GET') return send(res, 404, { error: 'task not found' });
    if (method === 'GET') return send(res, 200, task);
    if (method === 'PATCH' || method === 'PUT') {
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      let updated;
      try { updated = sanitizeTask(b, task, ctx); }
      catch (e) { return send(res, 400, { error: e.message }); }
      updated.ord = row.ord;
      writeTaskRow(ctx, updated);
      return send(res, 200, updated);
    }
    if (method === 'DELETE') {
      if (readOnly) return denyReadOnly();
      wsStmt.taskSoftDel().run(new Date().toISOString(), wsId, task.id);
      return send(res, 200, { deleted: true, id: task.id });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- board-level bulk update (drag & drop persistence) --- */
  if (seg === 'board' && method === 'PATCH') {
    if (readOnly) return denyReadOnly();
    const b = await readBody(req);
    if (!Array.isArray(b.order)) return send(res, 400, { error: 'order must be an array of task ids' });
    const rows = wsStmt.tasksAll().all(wsId);
    const known = new Set(rows.map(t => t.id));
    if (!b.order.every(id => known.has(id))) return send(res, 400, { error: 'order contains unknown task ids' });
    const tx = sqlite.transaction(() => {
      b.order.forEach((id, i) => sqlite.prepare('UPDATE tasks SET ord=? WHERE workspace_id=? AND id=?').run(i + 1, wsId, id));
      let next = b.order.length + 1;
      for (const t of rows) if (!b.order.includes(t.id)) sqlite.prepare('UPDATE tasks SET ord=? WHERE workspace_id=? AND id=?').run(next++, wsId, t.id);
    });
    tx();
    return send(res, 200, { ok: true });
  }

  /* --- saved items / read flags / ui (per-user prefs) --- */
  if (seg === 'prefs') {
    const pr = userPrefs(ctx);
    if (method === 'GET') return send(res, 200, { savedIds: pr.savedIds, readFlags: pr.readFlags, ui: pr.ui });
    if (method === 'PATCH' || method === 'PUT') {
      const b = await readBody(req);
      if (Array.isArray(b.savedIds)) pr.savedIds = b.savedIds.filter(x => typeof x === 'string').slice(0, 5000);
      if (b.readFlags && typeof b.readFlags === 'object') pr.readFlags = b.readFlags;
      if (b.ui && typeof b.ui === 'object') pr.ui = { ...pr.ui, ...b.ui };
      savePrefs(ctx, pr);
      return send(res, 200, { savedIds: pr.savedIds, readFlags: pr.readFlags, ui: pr.ui });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /* --- channel messages --- */
  if (seg === 'channels') {
    const shapeMsg = (m) => ({ by: m.actor_key, who: m.who, initials: m.initials, color: m.color, text: m.text, time: m.time });
    /* POST /api/channels — create a new channel (slugified, unique per workspace) */
    if (method === 'POST' && !param) {
      if (readOnly) return denyReadOnly();
      const b = await readBody(req);
      const raw = cleanStr(b.name, 60);
      const slug = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (slug.length < 2 || slug.length > 30) return send(res, 400, { error: 'channel name must be 2 to 30 characters (letters and numbers)' });
      if (wsStmt.channelById().get(wsId, slug)) return send(res, 409, { error: `#${slug} already exists in this workspace` });
      const topic = cleanStr(b.topic, 200);
      const maxOrd = sqlite.prepare('SELECT COALESCE(MAX(ord),0)+1 AS n FROM channels WHERE workspace_id=?').get(wsId).n;
      wsStmt.channelInsert().run(slug, wsId, topic, maxOrd);
      return send(res, 201, { id: slug, topic, ord: maxOrd });
    }
    if (method === 'GET' && param) {
      if (!wsStmt.channelById().get(wsId, param)) return send(res, 404, { error: 'channel not found' });
      const byKey = Object.fromEntries(workspacePeople(ctx).map(p => [p.id, p]));
      return send(res, 200, wsStmt.msgsByChannel().all(wsId, param).map(m => {
        const actor = byKey[m.actor_key] || { name: 'Someone', initials: '?', color: '#888' };
        return { by: m.actor_key, who: actor.name, initials: actor.initials, color: actor.color, text: m.text, time: m.time };
      }));
    }
    if (method === 'POST' && param) {
      if (readOnly) return denyReadOnly();
      if (!wsStmt.channelById().get(wsId, param)) return send(res, 404, { error: 'channel not found' });
      const b = await readBody(req);
      const text = cleanStr(b.text, 2000);
      if (!text) return send(res, 400, { error: 'text is required' });
      wsStmt.msgInsert().run(wsId, param, String(ctx.user.id), text, new Date().toTimeString().slice(0, 5));
      return send(res, 201, { by: String(ctx.user.id), who: ctx.user.name, initials: initialsFrom(ctx.user.name),
                              color: ctx.user.avatar_color, text, time: new Date().toTimeString().slice(0, 5) });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  return send(res, 404, { error: 'unknown API endpoint', endpoint: '/api/' + parts.join('/') });
}

/* ------------------------------------------------------------------ */
/* Static file serving                                                 */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};
const PUBLIC_FILES = new Set(['/index.html', '/app.js', '/styles.css', '/robots.txt']);

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); }
  catch (_) {
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
if (IS_MODULE) {
  /* Netlify wrapper (netlify/functions/api.mjs) calls loadDbAsync/flushSaves;
   * the relational store needs a persistent disk, so these are no-ops there —
   * the wrapper sets TASKHIVE_READONLY_API and auth reads still work in memory. */
  module.exports = { handleApi, readBody, seedData: () => null,
                    loadDbAsync: async () => {}, flushSaves: async () => {} };
} else {
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  /* CORS: same-origin by default; other origins only via TASKHIVE_ALLOWED_ORIGINS. */
  const origin = corsOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!sqlite && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/health')) {
    return send(res, 503, { error: 'database unavailable — run npm install better-sqlite3' });
  }

  if (url.pathname.startsWith('/api/')) {
    /* Rate-limit all API traffic per IP (generous ceiling; auth has tighter limits). */
    const rl = rateLimit(`api:${clientIp(req)}`, 600, 60e3);
    if (!rl.allowed) return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(rl.retryAfter) });
    try {
      await handleApi(req, res, url);
    } catch (e) {
      send(res, e.message === 'invalid JSON' || e.message === 'body too large' ? 400 : 500,
           { error: e.message });
    }
    return;
  }
  if (url.pathname === '/api' || url.pathname === '/api/') {
    return send(res, 200, { name: 'TaskHive API', version: 3, endpoints: [
      'POST   /api/auth/signup          POST /api/auth/login      POST /api/auth/logout',
      'GET    /api/auth/me              POST /api/auth/demo       POST /api/auth/demo/reset',
      'GET    /api/bootstrap',
      'GET    /api/people               GET/PATCH /api/people/:id',
      'GET    /api/projects             POST /api/projects',
      'GET    /api/projects/:id         PATCH/DELETE /api/projects/:id',
      'GET    /api/tasks?project=&progress=&urgency=&assignee=&q=&limit=&offset=',
      'POST   /api/tasks                GET/PATCH/DELETE /api/tasks/:id',
      'PATCH  /api/board                (bulk reorder)',
      'GET    /api/prefs                PATCH /api/prefs  (per-user)',
      'GET    /api/channels/:id         POST /api/channels/:id',
      'GET    /api/discussions/:taskId  POST /api/discussions/:taskId',
      'GET    /api/inbox                PATCH /api/inbox/:id  PATCH /api/inbox/read-all',
      'GET    /api/export               POST /api/import        (per-workspace snapshot)',
      'POST   /api/purge                POST /api/reset-demo    (maintenance)',
    ]});
  }
  serveStatic(req, res, url);
});

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`TaskHive backend running at http://localhost:${PORT}`);
  console.log(`  API base:  http://localhost:${PORT}/api`);
  console.log(`  Database:  ${SQLITE_FILE}`);
});
} /* end else (classic server mode) */

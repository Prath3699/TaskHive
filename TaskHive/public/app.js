/* Issue Tracker Dashboard — SPA: hash router, pages, modals, toasts */

/* ---- escape hatch for inline onclick handlers (script is strict-mode) ---- */
window.__app = {};

/* ============================ DATA ============================ */

const PROGRESS = {
  Ongoing:     { dot: 'dot-ongoing',     pill: 'prog-ongoing' },
  Completed:   { dot: 'dot-completed',   pill: 'prog-completed' },
  'In review': { dot: 'dot-review',      pill: 'prog-review' },
  Pending:     { dot: 'dot-pending',     pill: 'prog-pending' },
  'On hold':   { dot: 'dot-on-hold',     pill: 'prog-hold' },
};

const URGENCY = { Critical: 'pill-critical', Moderate: 'pill-moderate', Minor: 'pill-minor' };

/* ---- in-memory state, replaced by GET /api/bootstrap at boot ---- */
let PEOPLE = [];
let TASKS = [];
let PROJECTS = [];
let INBOX_ITEMS = [];
let DISCUSSIONS = {};          // taskId -> [{ who, initials, color, text, at }]

let ME = null;                 // current user id — set from GET /api/auth/me + /api/bootstrap
let WS = null;                 // active workspace { name, kind, readOnly } — drives trial banner & demo mode
const TRIAL_DAYS = 14;         // personal workspaces show "N days left in your trial" from created_at
const mePerson = () => ME ? PEOPLE.find(p => p.id === ME) : null;
const meName  = () => (mePerson() || { name: 'Guest' }).name;
const meInitials = () => (mePerson() || { initials: '??' }).initials;
const meColor = () => (mePerson() || { color: '#888' }).color;
const personById = (id) => PEOPLE.find(p => p.id === id) || PEOPLE[0] || { name: 'Unknown', initials: '?', color: '#888' };

// Task list exactly as in the design (15 tasks) — ids unique server-side;
// the real data now comes from the backend via GET /api/bootstrap.

/* Channels are loaded from the backend (GET /api/bootstrap -> channels[]).
   The static list below is only the fallback used before bootstrap finishes. */
let CHANNELS = {
  engineering:    { topic: 'Builds, incidents and API chatter for the platform team.' },
  docs:           { topic: 'Everything documentation — PRDs, guides, changelogs.' },
  teams:          { topic: 'Cross-team coordination and people ops.' },
  initiatives:    { topic: 'Quarterly strategic initiatives and OKRs.' },
  'active-sprint':{ topic: 'Daily standups and blockers for the current sprint.' },
  design:         { topic: 'Design critiques, mockups and the design system.' },
  marketing:      { topic: 'Campaigns, launches and growth experiments.' },
};
const channelName = (key) => key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
/* Re-render the sidebar "Your channels" group from the live CHANNELS map so
   newly created channels appear immediately without a page reload. */
function renderChannelNav() {
  const side = document.querySelector('.sidebar');
  if (!side) return;
  const head = [...side.children].find(n => n.classList.contains('nav-section') && n.textContent.trim() === 'Your channels');
  if (!head) return;
  let node = head.nextElementSibling;
  while (node && node.classList.contains('nav-item') && node.classList.contains('channel')) {
    const next = node.nextElementSibling; node.remove(); node = next;
  }
  for (const [key, ch] of Object.entries(CHANNELS)) {
    const a = document.createElement('a');
    a.href = `#/channel/${key}`;
    a.className = 'nav-item channel';
    a.dataset.route = 'channel'; a.dataset.param = key;
    a.innerHTML = `<span class="ch-hash">#</span>${esc(channelName(key))}`;
    a.addEventListener('click', () => setSidebar(false));
    node ? side.insertBefore(a, node) : side.appendChild(a);
  }
}

/* Channel messages come from the backend (GET /api/channels/:id) */
let CHANNEL_MESSAGES = {};

/* Per-task metadata used by the Properties panel */
const TASK_META = {
  category:  ['API Documentation', 'Engineering', 'Design', 'Performance', 'Security'],
  department: ['💻 Engineering', '🎨 Design', '📈 Marketing', '🛡 Security', '📚 Docs'],
  tags: [['Features', 'Improvements'], ['Bugs'], ['Features', 'Bugs', 'Improvements'], ['Improvements']],
  dates: ['March 15, 2025', 'April 2, 2025', 'April 18, 2025', 'May 1, 2025'],
  deadlines: ['May 15, 2025', 'June 1, 2025', 'June 20, 2025', 'July 10, 2025'],
};

/* Discussions (Properties-panel comments) come from the backend:
   GET /api/bootstrap -> discussions map, POST /api/discussions/:taskId to add one. */
const meComment = () => ({ who: meName(), initials: meInitials(), color: meColor() });

const ATTACHMENTS = [
  { cls: 'xls', label: 'XLS', name: 'Client_Proposal.xls', sub: 'Today · 4 MB' },
  { cls: 'doc', label: 'DOC', name: 'PRD.docx', sub: 'Yesterday' },
  { cls: 'gdoc', label: 'G', name: 'Google Docs', sub: 'Linked document' },
];

/* ============================ BACKEND API CLIENT ============================ */

// API base: same-origin by default (backend serves frontend). If you split hosting
// (e.g. Netlify for UI + Render for API), set window.TASKHIVE_API in an inline script
// before app.js loads, e.g. <script>window.TASKHIVE_API='https://taskhive-api.onrender.com'</script>
const API_BASE = (window.TASKHIVE_API || '') + '/api';

async function api(method, path, body) {
  /* paths starting with '/' are API-relative (/tasks → /api/tasks);
     paths already carrying the /api prefix pass through untouched. */
  const url = path.startsWith('/api') ? API_BASE.replace(/\/api$/, '') + path : API_BASE + path;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',   // always send the httpOnly session cookie
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/* Auth gate: mutations that come back 401 drop you on the login screen. */
let authExpired = false;
function handleAuthError(err) {
  if (err && err.status === 401 && !authExpired) {
    authExpired = true;
    ME = null;
    showLoginScreen('Your session expired — please sign in again.');
  }
}

/* Fire-and-forget mutation with optimistic UI + rollback on failure */
function mutate(path, method, body, onSuccess, label) {
  return api(method, path, body).catch(err => {
    if (err.status === 401) { handleAuthError(err); return; }
    console.error(`${method} ${path} failed:`, err);
    toast(`⚠ ${label || 'Server update failed'} — retrying locally only`);
    if (method === 'PATCH') {           // best-effort single retry for edits
      setTimeout(() => api(method, path, body).catch(() => {}), 1200);
    }
  });
}

const patchTask    = (task, body, label) => mutate(`/tasks/${encodeURIComponent(task.id)}`, 'PATCH', body, null, label || 'Save failed');
/* Demo workspaces answer 403 on mutations — surface the friendly copy and
 * skip the optimistic-UI retry loop for those. */
function guardDemoErr(err) {
  if (err && err.status === 403) { toast('🔒 Demo workspace is read-only — create your own account to edit'); return true; }
  return false;
}
const deleteTaskApi = (task) => api('DELETE', `/tasks/${encodeURIComponent(task.id)}`)
  .catch(err => { if (!guardDemoErr(err)) { console.error('delete failed:', err); toast('⚠ Delete failed — try again'); } });
const patchPrefs   = () => mutate('/prefs', 'PATCH', { savedIds, readFlags, ui: uiPrefs }, null, 'Preference sync failed');
const patchInboxRead = (id) => api('PATCH', `/inbox/${encodeURIComponent(id)}`, { unread: false })
  .catch(err => { if (!guardDemoErr(err)) console.error('read sync failed', err); });
const patchInboxReadAll = () => api('PATCH', '/inbox/read-all', {})
  .catch(err => { if (!guardDemoErr(err)) console.error('read sync failed', err); });
const postComment = (taskId, text) => api('POST', `/discussions/${encodeURIComponent(taskId)}`, { text });
const postChannelMsg = (key, text) => api('POST', `/channels/${encodeURIComponent(key)}`, { text });
const saveProject = (name) => api('POST', '/projects', { name });
const saveBoardOrder = (order) => api('PATCH', '/board', { order })
  .catch(err => { if (!guardDemoErr(err)) console.error('board order not saved', err); });
const updateProfile = (body) => api('PATCH', `/people/${encodeURIComponent(ME)}`, body);

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'Yesterday';
  return `${Math.floor(s / 86400)} days ago`;
}

/* ============================ HELPERS ============================ */

const $ = (sel, root = document) => root.querySelector(sel);
const pageEl = $('#page');
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let savedIds = [];     // task ids (strings) — canonical copy lives on the server (/api/prefs)
let readFlags = {};    // inbox item id -> true (server-persisted; localStorage is a fast cache)
let uiPrefs = { darkMode: null, emailNotifications: true, weeklyDigest: false }; // per-user UI toggles (server-persisted)

/* Toggle state is single-sourced from uiPrefs (the server-persisted object),
   so every re-render paints the checkboxes exactly as the app believes them to
   be — independent per setting, no cross-talk, correct after nav/reload. */
const toggleState = (key) => !!uiPrefs[key];
let _themeFromServer = false; // true once the server-stored theme has been applied this session
let nextTaskNum = 100; // provisional TSK-### counter for optimistic rows; server assigns the real id
let sortState = { key: null, dir: 1 };
const undoStack = [];
const LS_KEY = 'issueTracker.v1';

/* localStorage is only a fast cache — and it must be scoped per user so two
   people sharing a browser never see each other's saved items / read flags. */
function lsKey() { return ME ? `${LS_KEY}.${ME}` : LS_KEY; }

try {
  const s = JSON.parse(localStorage.getItem(lsKey()) || '{}');
  savedIds = Array.isArray(s.saved) ? s.saved : [];
  readFlags = s.read || {};
} catch (_) {}

function persist() {
  try {
    localStorage.setItem(lsKey(), JSON.stringify({ saved: savedIds, read: readFlags }));
  } catch (_) { /* private mode / storage disabled — server copy still persists */ }
  if (ME) patchPrefs(); // sync to backend (fire-and-forget, retried on failure)
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function fallbackCopy(input, done) {
  try { input.select(); document.execCommand('copy'); } catch (_) {}
  done();
}

function metaFor(task) {
  const i = Math.max(0, TASKS.findIndex(x => x.idx === task.idx)); // position-based so metadata stays stable after deletes/inserts
  return {
    category: TASK_META.category[i % TASK_META.category.length],
    department: TASK_META.department[i % TASK_META.department.length],
    tags: TASK_META.tags[i % TASK_META.tags.length],
    added: TASK_META.dates[i % TASK_META.dates.length],
    deadline: TASK_META.deadlines[i % TASK_META.deadlines.length],
  };
}

/* ---------- undo history (persisted across page loads) ---------- */
let undoHistory = [];
try { undoHistory = JSON.parse(localStorage.getItem('undoHist') || '[]'); } catch (_) {}
function pushHistory(label) {
  undoHistory.unshift({ label, time: Date.now() });
  undoHistory = undoHistory.slice(0, 30);
  try { localStorage.setItem('undoHist', JSON.stringify(undoHistory)); } catch (_) {}
}

/* ============================ FILTERS / SORT / VISIBLE SET ============================ */

const STATUS_ORDER = ['Ongoing', 'In review', 'Completed', 'Pending', 'On hold'];
const URGENCY_ORDER = { Critical: 0, Moderate: 1, Minor: 2 };

let filterState = { progress: '', urgency: '', assignee: '' };

function visibleTasks() {
  let list = filteredTasks(); // search term applied
  if (currentRoute === 'mytasks' && myTaskFilter) list = list.filter(t => t.progress === myTaskFilter);
  const f = filterState;
  if (f.progress) list = list.filter(t => t.progress === f.progress);
  if (f.urgency)  list = list.filter(t => t.urgency === f.urgency);
  if (f.assignee !== '') list = list.filter(t => String(t.assignee) === String(f.assignee));
  if (sortState.key) {
    const k = sortState.key, dir = sortState.dir;
    list = [...list].sort((a, b) => {
      let r = 0;
      if (k === 'feature')  r = a.name.localeCompare(b.name);
      if (k === 'progress') r = STATUS_ORDER.indexOf(a.progress) - STATUS_ORDER.indexOf(b.progress);
      if (k === 'urgency')  r = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
      if (k === 'assignee') r = personById(a.assignee).name.localeCompare(personById(b.assignee).name);
      return r * dir || a.idx - b.idx;
    });
  }
  return list;
}

function toolbarHtml() {
  const active = filterState.progress || filterState.urgency || filterState.assignee !== '';
  return `
  <div class="table-toolbar">
    <select id="flt-progress" class="tool-select" aria-label="Filter by progress">
      <option value="">All progress</option>${Object.keys(PROGRESS).map(k => `<option ${filterState.progress === k ? 'selected' : ''}>${k}</option>`).join('')}
    </select>
    <select id="flt-urgency" class="tool-select" aria-label="Filter by urgency">
      <option value="">All urgency</option>${Object.keys(URGENCY).map(k => `<option ${filterState.urgency === k ? 'selected' : ''}>${k}</option>`).join('')}
    </select>
    <select id="flt-assignee" class="tool-select" aria-label="Filter by owner">
      <option value="">All owners</option>${PEOPLE.map(p => `<option value="${p.id}" ${String(filterState.assignee) === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
    </select>
    ${active ? '<button id="clear-filters" class="btn btn-ghost btn-sm">Clear filters ✕</button>' : ''}
    <span class="toolbar-spacer"></span>
    <button data-export class="btn btn-ghost btn-sm" title="Download tasks as CSV">⬇ Export CSV</button>
  </div>`;
}

function applyFiltersAndSort() {
  const host = $('#board-body');
  if (!host) return;
  const rows = visibleTasks();
  host.innerHTML = rows.length ? taskTableHtml(rows)
    : `<div class="empty-state">No tasks match your filters.<br><button id="clear-filters" class="btn btn-ghost btn-sm" style="margin-top:8px">Clear filters</button></div>`;
  const bulk = $('.bulkbar');
  if (bulk) bulk.remove();
}

function exportCsv(tasks) {
  const head = ['ID', 'Name', 'Progress', 'Urgency', 'Assignee', 'Comments'];
  const lines = [head.join(',')].concat(tasks.map(t =>
    [t.id, `"${t.name.replace(/"/g, '""')}"`, t.progress, t.urgency, personById(t.assignee).name, t.comments].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tasks.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}

/* ============================ MUTATIONS (edit / status / delete / undo) ============================
   All mutations are optimistic: update in-memory state + UI immediately, then sync to the
   backend via PATCH/DELETE /api/tasks/:id. On failure mutate() surfaces a warning toast and
   retries; Undo reverses both the local change and the server copy.                       */

const byIdx = (idx) => TASKS.find(x => x.idx === idx);

function updateTaskRow(idx) {
  const tr = document.querySelector(`.task-table tbody tr[data-idx="${idx}"]`);
  const t = byIdx(idx);
  if (!tr || !t) return;
  const fresh = document.createElement('tr');
  fresh.innerHTML = taskRowHtml(t);
  fresh.dataset.idx = idx; fresh.tabIndex = 0;
  fresh.className = tr.className;
  [...fresh.children].forEach((td, i) => {
    const lbl = tr.children[i] && tr.children[i].getAttribute('data-label');
    if (lbl) td.setAttribute('data-label', lbl);
  });
  tr.replaceWith(fresh);
}

function startRename(idx) {
  const cell = document.querySelector(`.task-table tbody tr[data-idx="${idx}"] .feature-name`);
  const t = byIdx(idx);
  if (!cell || !t || cell.querySelector('input')) return;
  cell.innerHTML = `<input class="rename-input" type="text" value="${esc(t.name)}" aria-label="Rename task" />`;
  const inp = cell.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  function commit() {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (v && v !== t.name) {
      const old = t.name; t.name = v;
      patchTask(t, { name: v }, 'Rename not saved');
      pushHistory(`Renamed “${old}” → “${v}”`);
      undoStack.push({ label: `Rename of “${v}”`, run: () => { t.name = old; patchTask(t, { name: old }); render(); } });
      render();
      showUndoToast(`✏ Renamed “${v}”`);
    } else render();
  }
  inp.addEventListener('blur', () => commit());
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { done = true; render(); }
  });
}

function cycleStatus(idx) {
  const t = byIdx(idx); if (!t) return;
  const old = t.progress;
  t.progress = STATUS_ORDER[(STATUS_ORDER.indexOf(old) + 1) % STATUS_ORDER.length];
  patchTask(t, { progress: t.progress }, 'Status not saved');
  pushHistory(`“${t.name}”: ${old} → ${t.progress}`);
  undoStack.push({ label: `Status change of “${t.name}”`, run: () => { t.progress = old; patchTask(t, { progress: old }); render(); } });
  if ($('#board-body')) renderBoardBody(); else render(); // board pages vs mytasks/home/saved tables
  showUndoToast(`“${t.name}”: ${old} → ${t.progress}`);
}

function deleteTask(idx) {
  const pos = TASKS.findIndex(x => x.idx === idx); if (pos < 0) return;
  const removed = TASKS[pos];
  deleteTaskApi(removed);
  savedIds = savedIds.filter(id => id !== removed.id); persist();
  pushHistory(`Deleted “${removed.name}”`);
  undoStack.push({
    label: `Deleted “${removed.name}”`,
    run: async () => {
      TASKS.splice(pos, 0, removed);
      try {                                  // re-create on the server; keep the client row in sync
        const created = await api('POST', '/tasks', {
          name: removed.name, progress: removed.progress, urgency: removed.urgency,
          assignee: removed.assignee, project: removed.project, comments: removed.comments,
        });
        Object.assign(removed, { id: created.id, idx: created.idx });
      } catch (_) { /* stays local-only until next full reload */ }
    },
  });
  TASKS.splice(pos, 1);
  render();
  showUndoToast(`🗑 Deleted “${removed.name}”`);
}
function bulkDelete() {
  const boxes = [...document.querySelectorAll('.row-check:checked')];
  if (!boxes.length) return;
  const idxs = new Set(boxes.map(b => +b.dataset.idx));
  const removed = TASKS.filter(t => idxs.has(t.idx));
  removed.forEach(deleteTaskApi);
  savedIds = savedIds.filter(id => !removed.some(t => t.id === id)); persist();
  TASKS = TASKS.filter(t => !idxs.has(t.idx));
  pushHistory(`Deleted ${removed.length} tasks`);
  undoStack.push({
    label: `Deleted ${removed.length} tasks`,
    run: async () => {
      for (const t of removed) {
        TASKS.push(t);
        try {
          const created = await api('POST', '/tasks', {
            name: t.name, progress: t.progress, urgency: t.urgency,
            assignee: t.assignee, project: t.project, comments: t.comments,
          });
          Object.assign(t, { id: created.id, idx: created.idx });
        } catch (_) {}
      }
    },
  });
  render();
  showUndoToast(`🗑 Deleted ${removed.length} tasks`);
}

async function undoLast() {
  const op = undoStack.pop();
  if (!op) return toast('Nothing to undo');
  await op.run(); render(); toast(`↩ Undone: ${op.label}`);
}

function showUndoToast(msg) {
  const t = $('#toast');
  t.innerHTML = `${esc(msg)} <button id="undo-btn" class="undo-btn">Undo</button>`;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 6000);
}

window.__app.undoLast = undoLast;

window.__app.startRename = startRename;
window.__app.cycleStatus = cycleStatus;

const URGENCY_CYCLE = ['Critical', 'Moderate', 'Minor'];
window.__app.cycleUrgency = function (idx) {
  const t = TASKS.find(x => x.idx === idx); if (!t) return;
  const old = t.urgency;
  t.urgency = URGENCY_CYCLE[(URGENCY_CYCLE.indexOf(old) + 1) % URGENCY_CYCLE.length];
  patchTask(t, { urgency: t.urgency }, 'Urgency not saved');
  pushHistory(`“${t.name}”: urgency ${old} → ${t.urgency}`);
  undoStack.push({ label: `Urgency change of “${t.name}”`, run: () => { t.urgency = old; patchTask(t, { urgency: old }); render(); } });
  if ($('#board-body')) renderBoardBody(); else render();
  showUndoToast(`“${t.name}”: ${old} → ${t.urgency}`);
};

/* ============================ MODAL (with focus trap) ============================ */

let lastFocused = null;

function openModal(title, html) {
  lastFocused = document.activeElement;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
  const first = $('#modal-body button, #modal-body input, #modal-body select, #modal-body textarea');
  (first || $('#modal-close')).focus();
}
function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  if (lastFocused && lastFocused.focus) lastFocused.focus();
  lastFocused = null;
}
document.addEventListener('keydown', (e) => {
  const overlay = $('#modal-overlay');
  if (overlay.classList.contains('hidden')) return;
  if (e.key !== 'Tab') return;
  const focusables = [...overlay.querySelectorAll('button, input, select, textarea, a[href]')]
    .filter(el => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeColMenus(); closeModal(); } });

/* close column menus on scroll/resize so they don't float detached */
window.addEventListener('scroll', () => { if (document.querySelector('.col-menu')) closeColMenus(); }, true);
window.addEventListener('resize', () => { if (document.querySelector('.col-menu')) closeColMenus(); });

/* Keyboard shortcuts: C/N = new task, / or Ctrl/Cmd+K = focus search (when not typing) */
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
    e.preventDefault(); toggleDarkMode(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); focusGlobalSearch(); return;
  }
  if (e.key === 'Escape') { closeSearchResults(); closeSplitMenu(); closeModal(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); focusGlobalSearch(); }
  const k = e.key.toLowerCase();
  if (k === 'c' || k === 'n') { e.preventDefault(); showNewFeatureModal(); }
});

/* ============================ SHARED COMPONENTS ============================ */

/* ---- Mobile card layout for task tables (data-labels come from th text) ---- */
function tagCardLabels() {
  document.querySelectorAll('table.task-table').forEach(tbl => {
    const heads = [...tbl.querySelectorAll('thead th')];
    tbl.querySelectorAll('tbody tr').forEach(tr => {
      [...tr.children].forEach((td, i) => {
        const h = heads[i];
        if (!h) return;
        const label = (h.getAttribute('data-col-name') || h.textContent || '').trim();
        if (label) td.setAttribute('data-label', label);
      });
    });
  });
}

function taskRowHtml(t) {
  const p = personById(t.assignee);
  return `
    <tr data-idx="${t.idx}" tabindex="0">
      <td class="check-cell"><input type="checkbox" class="row-check" data-idx="${t.idx}" aria-label="Select ${esc(t.name)}" /></td>
      <td><div class="feature-cell"><span class="tsk-id">${t.id}</span><span class="feature-name" title="Double-click to rename">${esc(t.name)}</span></div></td>
      <td><button class="progress-cell progress-btn ${PROGRESS[t.progress]?.pill || 'prog-hold'}" onclick="__app.cycleStatus(${t.idx})" title="Click to change status"><span class="status-dot ${PROGRESS[t.progress]?.dot || 'dot-on-hold'}"></span>${t.progress}</button></td>
      <td><button class="urgency-cell pill ${URGENCY[t.urgency]}" onclick="__app.cycleUrgency(${t.idx})" title="Click to change urgency">${t.urgency}</button></td>
      <td>
        <div class="assignee">
          <button class="avatar link-avatar" style="--a:${p.color}" data-person="${t.assignee}" title="${p.name}">${p.initials}</button>
          <span class="assignee-name">${p.name}</span>
          ${t.comments ? `<span class="comment-count" title="${t.comments} comments">💬 ${t.comments}</span>` : ''}
        </div>
      </td>
      <td class="row-actions">
        <button class="icon-btn edit-btn" onclick="__app.startRename(${t.idx})" title="Rename" aria-label="Rename task">✎</button>
        <button class="icon-btn del-btn" data-del="${t.idx}" title="Delete" aria-label="Delete task">🗑</button>
      </td>
    </tr>`;
}

function sortIcon(key) {
  if (sortState.key !== key) return '<span class="sort-ind">↕</span>';
  return `<span class="sort-ind on">${sortState.dir === 1 ? '↑' : '↓'}</span>`;
}

/* ---- column header: sort + filter dropdown menu ---- */

function colHead(key, label) {
  const canFilter = key !== 'feature';
  const fVal = canFilter ? (key === 'assignee' ? filterState.assignee : filterState[key]) : '';
  const filtered = canFilter && fVal !== '' && fVal !== undefined;
  const sorted = sortState.key === key;
  const arrow = sorted ? (sortState.dir === 1 ? '↑' : '↓') : '';
  return `<button class="th-btn${filtered ? ' is-filtered' : ''}" data-menu="col:${key}"
      aria-haspopup="true" aria-expanded="false" title="${canFilter ? 'Sort & filter' : 'Sort'} by ${label}">
    <span>${label}</span>${arrow ? `<span class="th-arrow">${arrow}</span>` : ''}
    ${filtered ? '<span class="th-filter-dot" aria-hidden="true"></span>' : ''}
    <svg class="th-caret" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
  </button>`;
}

function colMenuHtml(key) {
  const labels = { feature: 'Feature', progress: 'Progress', urgency: 'Urgency', assignee: 'Assigned to' };
  const dirOpts = [
    { act: `sort:${key}:asc`, icon: '↑', label: 'A → Z', active: sortState.key === key && sortState.dir === 1 },
    { act: `sort:${key}:desc`, icon: '↓', label: 'Z → A', active: sortState.key === key && sortState.dir === -1 },
  ];
  let filterOpts = [];
  if (key === 'progress') filterOpts = Object.keys(PROGRESS).map(k => ({ val: k, label: k, dot: PROGRESS[k].dot }));
  if (key === 'urgency')  filterOpts = Object.keys(URGENCY).map(k => ({ val: k, label: k, pill: URGENCY[k] }));
  if (key === 'assignee') filterOpts = PEOPLE.map(p => ({ val: p.id, label: p.name, avatar: p }));
  const cur = key === 'assignee' ? filterState.assignee : filterState[key];
  const isFiltered = cur !== '' && cur !== undefined;
  return `
    <div class="menu-sec">Sort ${labels[key]}</div>
    ${dirOpts.map(o => `<button class="menu-item${o.active ? ' active' : ''}" data-menuact="${o.act}">
      <span class="mi-icon mi-arrow">${o.icon}</span><span class="mi-label">${o.label}</span>${o.active ? '<span class="mi-check">✓</span>' : ''}</button>`).join('')}
    ${filterOpts.length ? `
      <div class="menu-sep"></div>
      <div class="menu-sec">Filter ${labels[key]}</div>
      <button class="menu-item${!isFiltered ? ' active' : ''}" data-menuact="clearf:${key}">
        <span class="mi-icon">◎</span><span class="mi-label">All</span>${!isFiltered ? '<span class="mi-check">✓</span>' : ''}</button>
      ${filterOpts.map(o => `<button class="menu-item${String(cur) === o.val ? ' active' : ''}" data-menuact="setf:${key}:${encodeURIComponent(o.val)}">
        <span class="mi-icon">${o.dot ? `<span class="status-dot ${o.dot}"></span>` : o.pill ? `<span class="pill ${o.pill} pill-xs">${esc(o.label)}</span>` : o.avatar ? `<span class="avatar avatar-xs" style="--a:${o.avatar.color}">${o.avatar.initials[0]}</span>` : ''}</span>
        <span class="mi-label">${esc(o.label)}</span>${String(cur) === o.val ? '<span class="mi-check">✓</span>' : ''}</button>`).join('')}
    ` : ''}`;
}

function closeColMenus() {
  document.querySelectorAll('.col-menu').forEach(m => m.remove());
  document.querySelectorAll('.th-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

function openColMenu(btn) {
  const wasOpen = btn.getAttribute('aria-expanded') === 'true';
  closeColMenus();
  if (wasOpen) return;
  btn.setAttribute('aria-expanded', 'true');
  const key = btn.dataset.menu.split(':')[1];
  const menu = document.createElement('div');
  menu.className = 'col-menu';
  menu.innerHTML = colMenuHtml(key);
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function refreshViews() {
  // re-render whatever table views are on screen so sort/filter changes apply everywhere
  if (currentRoute === 'mytasks') { render(); return; }
  if ($('#board-body')) { kanbanMode ? renderKanban() : renderBoardBody(); return; }
  render();
}

function taskTableHtml(tasks) {
  return `
    <table class="task-table">
      <thead><tr>
        <th class="check-cell"></th>
        <th>${colHead('feature', 'Feature')}</th>
        <th>${colHead('progress', 'Progress')}</th>
        <th>${colHead('urgency', 'Urgency')}</th>
        <th>${colHead('assignee', 'Assigned to')}</th>
        <th class="row-actions"></th>
      </tr></thead>
      <tbody id="task-rows">${tasks.map(taskRowHtml).join('')}</tbody>
    </table>`;
}

function propertiesPanelHtml(task) {
  const m = metaFor(task);
  const owner = personById(task.assignee);
  const comments = DISCUSSIONS[task.id] || [];
  const isSaved = savedIds.includes(task.id);
  return `
  <aside class="properties">
    <div class="props-head"><h2>Properties</h2>
      <div class="props-actions">
        <button id="save-toggle" class="icon-btn" data-idx="${task.idx}" title="${isSaved ? 'Remove from saved' : 'Save item'}">${isSaved ? '★' : '☆'}</button>
        <button class="icon-btn" id="edit-task-btn" data-idx="${task.idx}" title="Rename task">✎</button>
        <button class="icon-btn danger-icon" id="delete-task-btn" data-del="${task.idx}" title="Delete task">🗑</button>
      </div>
    </div>
    <dl class="props-list">
      <div class="prop-row"><dt>Task ID</dt><dd>${task.id}</dd></div>
      <div class="prop-row"><dt>Progress</dt><dd>
        <select id="prop-status" data-idx="${task.idx}" class="prop-select" aria-label="Change progress">
          ${Object.keys(PROGRESS).map(k => `<option ${k === task.progress ? 'selected' : ''}>${k}</option>`).join('')}
        </select></dd></div>
      <div class="prop-row"><dt>Category</dt><dd>${m.category}</dd></div>
      <div class="prop-row"><dt>Task owner</dt><dd><button class="avatar avatar-xs link-avatar" style="--a:${owner.color}" data-person="${task.assignee}">${owner.initials[0]}</button>${owner.name.split(' ')[0]}</dd></div>
      <div class="prop-row"><dt>Urgency</dt><dd><span class="pill ${URGENCY[task.urgency]}">${task.urgency}</span></dd></div>
      <div class="prop-row"><dt>Department</dt><dd>${m.department}</dd></div>
      <div class="prop-row"><dt>Date added</dt><dd>${m.added}</dd></div>
      <div class="prop-row"><dt>Deadline</dt><dd>${m.deadline}</dd></div>
      <div class="prop-row tags-row"><dt>Tags</dt><dd class="tags">${m.tags.map(t => `<span class="tag">${t}</span>`).join('')}</dd></div>
    </dl>
    <div class="props-section">
      <h3>Attachments</h3>
      ${ATTACHMENTS.map(a => `
        <a href="#" class="attachment" data-attachment="${a.name}">
          <span class="file-icon ${a.cls}">${a.label}</span>
          <span class="att-meta"><span class="att-name">${a.name}</span><span class="att-sub">${a.sub}</span></span>
        </a>`).join('')}
    </div>
    <div class="props-section discussion">
      <h3>Discussion</h3>
      <ul class="comments" id="comment-list">
        ${comments.map(c => `
        <li>
          <span class="avatar avatar-sm" style="--a:${c.color}">${c.initials}</span>
          <div class="comment-body"><div class="comment-author">${c.who}</div><p>${esc(c.text)}</p></div>
        </li>`).join('')}
      </ul>
      <form id="comment-form" class="comment-input">
        <input id="comment-box" data-idx="${task.idx}" type="text" placeholder="Write a comment (Enter to send)" aria-label="Write a comment" />
        <button id="comment-send" class="btn btn-primary btn-sm" type="submit">Send</button>
      </form>
    </div>
  </aside>`;
}

function boardSectionHtml(title, tabs, activeTab, tasks) {
  return `
    <section class="board">
      <div class="board-head">
        <h1 class="project-title">${esc(title)}</h1>
        <div class="tabs">
          ${tabs.map((tb, i) => `<button class="tab ${i === activeTab ? 'active' : ''}" data-tab="${i}">${tb}</button>`).join('')}
        </div>
        <button id="share-btn" class="btn btn-ghost share-btn">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3.5 16.5 8 11 12.5"/><path d="M16 8H7.5A4 4 0 0 0 3.5 12v1.5"/><path d="M16 8V16"/></svg>
          Share
        </button>
      </div>
      ${tasks.length ? `<div class="view-toggle" role="group" aria-label="Board view">
        <button class="vt-btn ${kanbanMode ? '' : 'active'}" data-view="table" title="Table view">☰ Table</button>
        <button class="vt-btn ${kanbanMode ? 'active' : ''}" data-view="kanban" title="Kanban board view">▦ Kanban</button>
      </div>` : ''}
      <div id="board-body">
        ${tasks.length ? `${toolbarHtml()}${taskTableHtml(tasks)}`
          : `<div class="empty-state">No tasks yet. Create your first task<br><button class="btn btn-primary btn-sm new-task-empty" style="margin-top:10px">＋ New task</button></div>`}
      </div>
    </section>`;
}

/* ---------- Kanban view ---------- */
let kanbanDragIdx = null;

function setKanban(on) {
  kanbanMode = on;
  document.querySelectorAll('.view-toggle .vt-btn').forEach(b => b.classList.toggle('active', (b.dataset.view === 'kanban') === on));
  if (on) renderKanban(); else renderBoardBody();
}

function kanbanColsHtml(tasks) {
  return `
    <div class="kanban">
      ${STATUS_ORDER.map(st => {
        const col = tasks.filter(t => t.progress === st);
        return `
        <div class="kb-col" data-status="${st}">
          <div class="kb-head"><span class="status-dot ${PROGRESS[st].dot}"></span><strong>${st}</strong><span class="kb-count">${col.length}</span></div>
          <div class="kb-drop">
            ${col.map(t => {
              const p = personById(t.assignee);
              return `<div class="kb-card" draggable="true" data-idx="${t.idx}" tabindex="0">
                <div class="kb-name">${esc(t.name)}</div>
                <div class="kb-meta"><span class="tsk-id">${t.id}</span><span class="pill ${URGENCY[t.urgency]}">${t.urgency}</span>
                  <span class="avatar avatar-xs" style="--a:${p.color}" title="${p.name}">${p.initials[0]}</span></div>
              </div>`;
            }).join('') || '<div class="kb-empty">Drop tasks here</div>'}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function wireKanban(host) {
  host.querySelectorAll('.kb-card').forEach(card => {
    card.addEventListener('dragstart', () => { kanbanDragIdx = +card.dataset.idx; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); kanbanDragIdx = null; });
    card.addEventListener('click', () => { location.hash = `#/task/${card.dataset.idx}`; });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = `#/task/${card.dataset.idx}`; });
  });
  host.querySelectorAll('.kb-col').forEach(col => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('over');
      if (kanbanDragIdx == null) return;
      const t = TASKS.find(x => x.idx === kanbanDragIdx);
      const st = col.dataset.status;
      if (t && t.progress !== st) {
        const old = t.progress; t.progress = st;
        patchTask(t, { progress: st }, 'Move not saved');
        saveBoardOrder(TASKS.map(x => x.id)); // persist column order server-side
        pushHistory(`Moved “${t.name}” → ${st}`);
        undoStack.push({ label: `Move of “${t.name}”`, run: () => { t.progress = old; patchTask(t, { progress: old }); render(); } });
        refreshViews();
        showUndoToast(`Moved “${t.name}” → ${st}`);
      }
    });
  });
}

function renderKanban() {
  const host = $('#board-body'); if (!host) return;
  const tasks = visibleTasks();
  if (!tasks.length) { host.innerHTML = '<div class="empty-state">No tasks match your filters.</div>'; return; }
  host.innerHTML = kanbanColsHtml(tasks);
  wireKanban(host);
}

function renderBoardBody() {
  const host = $('#board-body'); if (!host) return;
  const activeTab = document.querySelector('.tab.active');
  const isOverview = ['project', 'task'].includes(currentRoute) && activeTab && activeTab.dataset.tab === '0';
  if (isOverview) { host.innerHTML = overviewHtml(); return; }
  const rows = visibleTasks();
  host.innerHTML = toolbarHtml() + (rows.length ? taskTableHtml(rows)
    : `<div class="empty-state">No tasks match your search or filters.<br><button id="clear-filters" class="btn btn-ghost btn-sm" style="margin-top:8px">Clear filters</button></div>`);
  tagCardLabels();
  updateBulkBar();
}

/* ============================ ROUTER ============================ */

const routes = {}; // filled below
let currentRoute = '';
let rmFilter = 'all';   // roadmap quarter filter chip state (persists across re-renders)

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const parts = h.split('/');
  return { name: parts[0], param: parts[1] || null };
}

/* ============================ AUTH SCREENS (#/login · #/signup) ============ */
/* Full-page overlay rendered outside the router; shown whenever no session
 * exists. The hash route decides which card is painted; a route guard in
 * render() keeps unauthenticated visitors on #/login or #/signup.          */

let loginNotice = '';
let pendingRoute = null;      // originally requested route, replayed after login

function showLoginScreen(notice) {
  if (notice !== undefined) loginNotice = notice;
  document.body.classList.add('show-login');
}

function hideLoginScreen() {
  loginNotice = '';
  document.body.classList.remove('show-login');
}

const eyeIcon = () => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z"/><circle cx="10" cy="10" r="2.4"/></svg>`;
const eyeOffIcon = () => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 6.6C1.9 8.2 2 10 2 10s3 5.5 8 5.5c1.6 0 3-.5 4.2-1.2M7.8 5.2A7.6 7.6 0 0 1 10 4.5c5 0 8 5.5 8 5.5a13 13 0 0 1-1.7 2.4M8.4 8.4a2.3 2.3 0 0 0 3.2 3.2M3 3l14 14"/></svg>`;

function pwField(id, label, placeholder, autocomplete) {
  return `<label>${label}<span class="pw-wrap">
      <input id="${id}" type="password" required placeholder="${placeholder}" autocomplete="${autocomplete}" minlength="8" />
      <button type="button" class="pw-toggle" data-toggle="${id}" aria-label="Show password" aria-pressed="false">${eyeIcon()}</button>
    </span></label>`;
}

function renderLoginScreen() {
  const screen = $('#login-screen');
  if (!screen) return;
  const mode = parseHash().name === 'signup' ? 'signup' : 'login';
  const brand = `
    <div class="login-brand">
      <div class="org-avatar" aria-hidden="true">
        <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 8.5h16M4.5 14h19M6 19.5h16" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M8 4h12l3 4.5H5L8 4Zm-3.5 5.5h19L26 14H2l2.5-4.5ZM5 19.5h18l-2.5 4.5H7.5L5 19.5Z" fill="#fff" opacity=".28"/>
        </svg>
      </div>
      <h1>TaskHive</h1>
      <p>${mode === 'signup' ? 'Create your workspace' : 'Sign in to your workspace'}</p>
    </div>`;
  const notice = loginNotice ? `<div class="login-notice" role="alert">${esc(loginNotice)}</div>` : '';
  const demoBtn = `<button id="demo-login" class="btn btn-ghost btn-block" type="button">Try the demo workspace</button>
      <div class="login-hint">Explore TaskHive with the classic Catlas sample board — read-only, resettable, no account needed.</div>`;
  if (mode === 'signup') {
    screen.innerHTML = `
    <div class="login-card">
      ${brand}${notice}
      <form id="signup-form" autocomplete="on" novalidate>
        <label>Name<input id="signup-name" type="text" required placeholder="Ada Lovelace" autocomplete="name" /></label>
        <label>Email<input id="signup-email" type="email" required placeholder="ada@example.com" autocomplete="email" /></label>
        ${pwField('signup-password', 'Password (min 8 characters)', '••••••••', 'new-password')}
        <label class="check-row"><input id="signup-sample" type="checkbox" /> Start with sample data (a demo board to explore — you can add it anytime)</label>
        <button type="submit" class="btn btn-primary btn-block" id="signup-submit">Create account</button>
      </form>
      <div class="login-alt">Already registered? <a href="#/login" class="link-btn">Sign in</a></div>
      ${demoBtn}
    </div>`;
  } else {
    screen.innerHTML = `
    <div class="login-card">
      ${brand}${notice}
      <form id="login-form" autocomplete="on" novalidate>
        <label>Email<input id="login-email" type="email" required placeholder="you@example.com" autocomplete="username" /></label>
        ${pwField('login-password', 'Password', '••••••••', 'current-password')}
        <button type="submit" class="btn btn-primary btn-block" id="login-submit">Sign in</button>
      </form>
      <div class="login-alt">New here? <a href="#/signup" class="link-btn">Create an account</a></div>
      ${demoBtn}
    </div>`;
  }
  /* wire show/hide password toggles */
  screen.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.toggle);
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.setAttribute('aria-pressed', String(show));
      btn.innerHTML = show ? eyeOffIcon() : eyeIcon();
    });
  });
}

/* Shared submit handler: loading state on the button + inline error notice. */
function runAuthForm(kind, body, btnId, busyLabel) {
  const btn = $('#' + btnId);
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = busyLabel; }
  const fail = (err) => {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Submit'; }
    loginNotice = err.message || 'Something went wrong — try again';
    renderLoginScreen();
  };
  api('POST', `/auth/${kind}`, body)
    .then(afterAuthSuccess)
    .catch(fail);
}

/* Trial banner: driven by the real workspace creation date (14-day trial). */
const TRIAL_LEN_DAYS = 14;
function trialDaysLeft() {
  if (!WS || !WS.createdAt) return null;
  const ms = Date.now() - new Date(WS.createdAt).getTime();
  return Math.max(0, TRIAL_LEN_DAYS - Math.floor(ms / 86400e3));
}
/* Gate the "Add person" menu item: only workspace owners/admins may add people.
   Non-admins get it hidden; in the read-only demo workspace it stays visible
   but disabled with a tooltip explaining why. Re-applied on every render(), so
   it survives topbar re-renders and route changes. */
function canManagePeople() {
  return !!(WS && (WS.role === 'admin' || WS.role === 'owner') && !WS.readOnly);
}
function syncAddPersonItem() {
  const btn = document.querySelector('#new-split-menu [data-new="person"]');
  if (!btn) return;
  const readOnlyDemo = !!(WS && WS.readOnly);
  if (canManagePeople()) {
    btn.hidden = false; btn.disabled = false; btn.removeAttribute('title');
  } else if (readOnlyDemo) {
    btn.hidden = false; btn.disabled = true;
    btn.title = 'The demo workspace is read-only — create your own account to add people';
  } else {
    btn.hidden = true; btn.disabled = true;
  }
}

function updateTrialCard() {
  const card = document.querySelector('.trial-card');
  if (!card) return;
  if (!ME) { card.style.display = 'none'; return; }
  if (WS && WS.kind === 'demo') {
    card.style.display = '';
    card.innerHTML = `<p>You are viewing the <strong>demo workspace</strong> — read-only.<br/>Create your own account to save changes.</p>
      <button id="reset-demo-btn" class="btn btn-primary btn-sm">Reset demo data</button>`;
    return;
  }
  const left = trialDaysLeft();
  if (left === null) { card.style.display = 'none'; return; }
  card.style.display = '';
  card.innerHTML = left > 0
    ? `<p>There${left === 1 ? ' is <strong>1 day</strong>' : ` are <strong>${left} days</strong>`} left in your trial.<br />Upgrade for unlimited access.</p>
       <button id="upgrade-btn" class="btn btn-primary btn-sm">Upgrade</button>`
    : `<p>Your trial has ended. Upgrade to keep your workspace.</p>
       <button id="upgrade-btn" class="btn btn-primary btn-sm">Upgrade</button>`;
}

function afterAuthSuccess(d) {
  authExpired = false;
  ME = d.user.id;
  WS = d.workspace || null;
  try { localStorage.setItem('th_session_hint', '1'); } catch (_) {}   // skeleton hint for next boot
  hideLoginScreen();
  return loadBootstrap().then(() => {
    if (pendingRoute && !/^#\/(login|signup|home)$/.test(pendingRoute)) {
      location.hash = pendingRoute;
    } else if (/^#?\/?(login|signup)?$/.test(location.hash.replace('#', ''))) {
      location.hash = '#/home';
    }
    pendingRoute = null;
    render();
    toast(`👋 Welcome, ${meName().split(' ')[0]}!`);
  });
}

function doLogin(email, password) {
  return api('POST', '/auth/login', { email, password }).then(afterAuthSuccess);
}

function doDemoLogin() {
  return api('POST', '/auth/demo', {}).then(afterAuthSuccess).catch(err => {
    loginNotice = err.message || 'Demo workspace unavailable';
    renderLoginScreen();
  });
}

function doLogout() {
  return api('POST', '/auth/logout', {}).catch(() => {}).then(() => {
    ME = null; WS = null; savedIds = []; readFlags = {};
    PEOPLE = []; TASKS = []; PROJECTS = []; INBOX_ITEMS = []; DISCUSSIONS = {}; CHANNEL_MESSAGES = {};
    try { localStorage.removeItem('th_session_hint'); } catch (_) {}
    pendingRoute = null;
    updateTrialCard();
    if (location.hash !== '#/login') location.hash = '#/login';
    else { renderLoginScreen(); showLoginScreen('Signed out.'); }
  });
}

/* ---- loading skeletons: shown while a section's data is in flight ---- */
function skeletonHtml(kind) {
  const row = (w) => `<div class="sk-row"><span class="sk-b" style="width:${w}%"></span><span class="sk-b sk-sm" style="width:${10 + (w % 25)}%"></span></div>`;
  if (kind === 'board') {
    return `<section class="page-pad">
      <div class="sk-title sk-b"></div>
      <div class="sk-table">${[92, 78, 85, 64, 88, 70, 80, 55].map(row).join('')}</div>
    </section>`;
  }
  if (kind === 'kanban') {
    return `<section class="page-pad"><div class="sk-kanban">${
      [0, 1, 2, 3, 4].map(() => `<div class="sk-col"><span class="sk-b" style="width:60%;height:14px"></span>${row(80)}${row(65)}</div>`).join('')
    }</div></section>`;
  }
  if (kind === 'cards') {
    return `<section class="page-pad"><div class="sk-cards">${
      [0, 1, 2, 3].map(() => '<div class="sk-card"><span class="sk-b" style="width:40%;height:16px"></span><span class="sk-b" style="width:80%;height:10px"></span><span class="sk-b" style="width:60%;height:10px"></span></div>').join('')
    }</div></section>`;
  }
  return `<section class="page-pad"><div class="sk-title sk-b"></div>${row(70)}${row(50)}</section>`;
}

/* Error boundary: a crashing route never leaves the user on a blank page. */
let lastFatalError = null;
window.addEventListener('error', (e) => { if (e.message) lastFatalError = e.message; });
window.addEventListener('unhandledrejection', (e) => {
  lastFatalError = (e.reason && e.reason.message) || String(e.reason || 'Unknown error');
});

function renderErrorView(err) {
  pageEl.innerHTML = `<section class="page-pad">
    <div class="empty-state error-boundary">
      <div class="eb-icon">⚠️</div>
      <div class="eb-title">Something went wrong</div>
      <div class="eb-detail">${esc(String((err && err.message) || err || 'Unexpected error'))}</div>
      <div class="eb-actions">
        <button class="btn-primary" id="eb-retry">Try again</button>
        <button class="btn-ghost" id="eb-home">Back to Home</button>
      </div>
    </div>
  </section>`;
  $('#eb-retry')?.addEventListener('click', () => { try { render(); } catch (_) {} });
  $('#eb-home')?.addEventListener('click', () => {
    if (location.hash === '#/home' || !location.hash) { try { render(); } catch (_) {} }   // same hash → no hashchange event, re-render manually
    else location.hash = '#/home';
  });
}

function render() {
  const { name, param } = parseHash();

  /* ---- route guard: unauthenticated visitors only ever see #/login or #/signup ---- */
  if (!ME) {
    if (name !== 'login' && name !== 'signup') {
      pendingRoute = location.hash || '#/home';
      loginNotice = 'Please sign in to continue.';
      location.hash = '#/login';          // fires hashchange → render() again, guarded below
      return;
    }
    renderLoginScreen();
    showLoginScreen();
    return;
  }
  /* authenticated users never sit on the auth screens */
  if (name === 'login' || name === 'signup') {
    hideLoginScreen();
    location.hash = '#/home';
    return;
  }

  const fn = routes[name] || routes.home;
  currentRoute = name;
  updateTrialCard();
  syncAddPersonItem();   // gate "Add person" (admin-only / demo tooltip) every render
  // Show skeletons when navigating before bootstrap data has arrived.
  // (If loadBootstrap already painted them, keep its markup — don't re-inject.)
  if (!PEOPLE.length && !document.body.classList.contains('show-login') && !pageEl.querySelector('.sk-row,.sk-card,.sk-col')) {
    pageEl.innerHTML = skeletonHtml(name === 'projects' ? 'cards' : 'board');
  } else if (PEOPLE.length || TASKS.length || PROJECTS.length) {
    try {
      pageEl.innerHTML = fn(param);
    } catch (err) {
      console.error('render crashed:', err);
      renderErrorView(err);
    }
  }
  // else: skeleton already painted by loadBootstrap — leave it until data arrives
  setActiveNav(name, param);
  tagCardLabels();   // mobile card layout: label each td from its th
  if (name === 'mytasks' && mtView === 'board') {
    const c = $('.mt-content');
    if (c) wireKanban(c);
  }
  window.scrollTo(0, 0);
}

function setActiveNav(name, param) {
  document.querySelectorAll('.sidebar .nav-item').forEach(a => {
    const r = a.dataset.route;
    a.classList.toggle('active', r === name && (!a.dataset.param || a.dataset.param === param));
  });
  // bottom tab bar highlights the closest top-level section
  const topOf = { project: 'projects', task: 'projects', channel: 'home', saved: 'inbox' }[name] || name;
  document.querySelectorAll('.bt-item').forEach(a => a.classList.toggle('active', a.dataset.route === topOf));
}

function setCrumbs(items) { // items: [{label, hash}] last is current
  $('#crumbs').innerHTML = items.map((it, i) => {
    const last = i === items.length - 1;
    return `${i ? '<span class="sep">/</span>' : ''}<a href="${it.hash || '#'}" class="${last ? 'current' : ''}">${esc(it.label)}</a>`;
  }).join('');
}

window.addEventListener('hashchange', render);

/* ============================ MOBILE SIDEBAR DRAWER ============================ */

const menuBtn = $('#menu-btn');
const sidebarEl = document.querySelector('.sidebar');
const scrimEl = $('#sidebar-scrim');
const sidebarCloseBtn = $('#sidebar-close');

function setSidebar(open) {
  if (!sidebarEl || !scrimEl || !menuBtn) return;
  document.body.classList.toggle('nav-open', open);
  scrimEl.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  sidebarEl.setAttribute('aria-hidden', 'false');
}

if (menuBtn) menuBtn.addEventListener('click', () => setSidebar(!document.body.classList.contains('nav-open')));
if (scrimEl) scrimEl.addEventListener('click', () => setSidebar(false));
if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', () => setSidebar(false));
// close drawer after choosing a destination on phones
document.querySelectorAll('.sidebar .nav-item').forEach(a => a.addEventListener('click', () => {
  if (window.matchMedia('(max-width: 820px)').matches) setSidebar(false);
}));
window.addEventListener('hashchange', () => setSidebar(false));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSidebar(false); });

/* ============================ PAGES ============================ */

routes.home = () => {
  setCrumbs([{ label: 'Overview' }, { label: 'Home' }]);
  const counts = { Ongoing: 0, Completed: 0, 'In review': 0, Pending: 0 };
  TASKS.forEach(t => counts[t.progress]++);
  const mine = TASKS.filter(t => t.assignee === ME);
  return `
    <section class="page-pad">
      <div class="page-head">
        <h1>Welcome back, ${esc(meName().split(' ')[0])} 👋</h1>
        <p>Here's what's happening across your workspace today.</p>
      </div>
      <div class="stat-grid">
        <button class="stat-card" data-goto="#/mytasks"><span class="stat-num">${TASKS.length}</span><span class="stat-label">Total tasks</span></button>
        <button class="stat-card" data-goto="#/projects"><span class="stat-num">${PROJECTS.length}</span><span class="stat-label">Active projects</span></button>
        <button class="stat-card" data-goto="#/inbox"><span class="stat-num">${INBOX_ITEMS.filter(i => !readFlags[i.id]).length}</span><span class="stat-label">Unread inbox</span></button>
        <button class="stat-card" data-goto="#/saved"><span class="stat-num">${savedIds.length}</span><span class="stat-label">Saved items</span></button>
      </div>
      <h2 class="section-title">Progress overview</h2>
      <div class="bar-chart">
        ${Object.entries(counts).map(([k, v]) => `
          <div class="bar-row">
            <span class="bar-label"><span class="status-dot ${PROGRESS[k].dot}"></span>${k}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round(v / Math.max(TASKS.length, 1) * 100)}%"></div></div>
            <span class="bar-count">${v}</span>
          </div>`).join('')}
      </div>
      <h2 class="section-title">Recent activity</h2>
      <ul class="activity-list">
        ${INBOX_ITEMS.slice(0, 5).map((it) => `
          <li data-inbox="${it.id}" style="cursor:pointer"><span class="avatar avatar-sm" style="--a:${it.color}">${it.initials}</span>
              <span><strong>${esc(it.who)}</strong> ${esc(it.text)} <em>${timeAgo(it.at)}</em></span></li>`).join('')}
      </ul>
      <h2 class="section-title">Your tasks</h2>
      ${mine.length ? taskTableHtml(mine)
        : '<div class="empty-state">Nothing assigned to you right now. Check the <a href="#/projects">Projects</a> board or create a new task.</div>'}
    </section>`;
};

routes.inbox = () => {
  setCrumbs([{ label: 'Overview' }, { label: 'Inbox' }]);
  return `
    <section class="page-pad">
      <div class="page-head">
        <h1>Inbox</h1>
        <p>Notifications and mentions across your projects.
          <button id="mark-all-read" class="btn btn-ghost btn-sm">Mark all as read</button></p>
      </div>
      <ul class="inbox-list">
        ${INBOX_ITEMS.map((it) => {
          const unread = !readFlags[it.id];
          return `
          <li class="inbox-item ${unread ? 'unread' : ''}" data-inbox="${it.id}">
            <span class="avatar avatar-sm" style="--a:${it.color}">${it.initials}</span>
            <div class="inbox-body">
              <div class="inbox-top"><strong>${esc(it.who)}</strong><span class="inbox-time">${timeAgo(it.at)}</span></div>
              <p>${esc(it.text)}</p>
            </div>
            ${unread ? '<span class="unread-dot"></span>' : ''}
          </li>`;
        }).join('')}
      </ul>
    </section>`;
};

routes.saved = () => {
  setCrumbs([{ label: 'Overview' }, { label: 'Saved items' }]);
  const items = TASKS.filter(t => savedIds.includes(t.id));
  return `
    <section class="page-pad">
      <div class="page-head"><h1>Saved items</h1><p>Tasks you bookmarked with ☆ in the Properties panel.</p></div>
      ${items.length ? taskTableHtml(items) : '<div class="empty-state">Nothing saved yet. Open a task and hit ☆ to save it.</div>'}
    </section>`;
};

/* ---- My Tasks page: view mode (grouped / table / board) ---- */
let mtView = (() => { try { return localStorage.getItem('mtView') || 'grouped'; } catch (_) { return 'grouped'; } })();
function setMtView(v) {
  mtView = v;
  try { localStorage.setItem('mtView', v); } catch (_) {}
  render();
}

function mtToolbarHtml() {
  const f = filterState;
  const chips = [];
  if (myTaskFilter) chips.push({ key: 'status', label: `Status: ${myTaskFilter}` });
  if (f.progress)   chips.push({ key: 'progress', label: `Progress: ${f.progress}` });
  if (f.urgency)    chips.push({ key: 'urgency', label: `Urgency: ${f.urgency}` });
  if (f.assignee !== '') { const ap = PEOPLE.find(p => p.id === f.assignee); chips.push({ key: 'assignee', label: `Owner: ${ap ? ap.name : f.assignee}` }); }
  const chipHtml = chips.map(c => `<button class="mt-chip" data-mtchip="${c.key}" title="Remove filter">${esc(c.label)}<span class="mt-chip-x">✕</span></button>`).join('');
  const seg = (v, icon, label) => `<button class="mt-seg-btn${mtView === v ? ' active' : ''}" data-mtview="${v}" aria-pressed="${mtView === v}" title="${label} view">${icon}<span>${label}</span></button>`;
  return `
  <div class="mt-toolbar">
    <div class="mt-search-wrap">
      <svg class="mt-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
      <input id="mt-search" class="mt-search" type="search" placeholder="Search your tasks…" value="${esc(searchTerm)}" aria-label="Search my tasks">
    </div>
    ${chipHtml}
    ${chips.length ? '<button id="clear-mytasks-filter" class="btn btn-ghost btn-sm">Clear all ✕</button>' : ''}
    <span class="toolbar-spacer"></span>
    <div class="mt-seg" role="group" aria-label="View mode">${seg('grouped', '▤', 'Grouped')}${seg('table', '☰', 'Table')}${seg('board', '▦', 'Board')}</div>
    <button data-export class="btn btn-ghost btn-sm" title="Download tasks as CSV">⬇ CSV</button>
  </div>`;
}

routes.mytasks = () => {
  setCrumbs([{ label: 'Overview', hash: '#/home' }, { label: 'My tasks' }]);
  const me = personById(ME);
  const allMine = TASKS.filter(t => t.assignee === ME);
  const mine = visibleTasks().filter(t => t.assignee === ME); // search + status pills + column filters/sorts
  const done = allMine.filter(t => t.progress === 'Completed').length;
  const pct = allMine.length ? Math.round(done / allMine.length * 100) : 0;
  const dueSoon = allMine.filter(t => {
    if (t.progress === 'Completed') return false;
    const d = metaFor(t).deadline.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)/i);
    if (!d) return false;
    const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const dt = new Date(2026, months.indexOf(d[1].toLowerCase()), +d[2]);
    return dt >= new Date() && dt - Date.now() < 14 * 864e5;
  }).length;
  const critOpen = allMine.filter(t => t.urgency === 'Critical' && t.progress !== 'Completed').length;

  /* hero band */
  const initials = me.initials;
  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  const hero = `
    <header class="mt-hero">
      <div class="avatar avatar-lg" style="--a:${me.color}">${initials}</div>
      <div class="mt-hero-txt">
        <h1>${greeting}, ${esc(me.name.split(' ')[0])} 👋</h1>
        <p>${allMine.length ? `${critOpen ? `<strong>${critOpen} critical task${critOpen > 1 ? 's' : ''}</strong> need attention · ` : ''}${dueSoon ? `${dueSoon} due this week · ` : ''}you're <strong>${pct}% complete</strong>` : 'Nothing on your plate right now.'}</p>
      </div>
      <div class="mt-ring" style="--p:${pct}" role="img" aria-label="${pct}% of your tasks completed">
        <span class="mt-ring-num">${pct}%</span>
      </div>
    </header>`;

  /* status filter pills */
  const pills = `
    <div class="mt-pills" role="group" aria-label="Filter by status">
      <button class="mt-pill${!myTaskFilter ? ' active' : ''}" data-status="">All<span class="mt-pill-n">${allMine.length}</span></button>
      ${STATUS_ORDER.map(st => {
        const n = allMine.filter(t => t.progress === st).length;
        return `<button class="mt-pill${st === myTaskFilter ? ' active' : ''}" data-status="${st}">
          <span class="status-dot ${PROGRESS[st].dot}"></span>${st}<span class="mt-pill-n">${n}</span></button>`;
      }).join('')}
    </div>`;

  let body;
  if (!allMine.length) {
    body = `<div class="empty-state">No tasks assigned to you yet.<br><button class="btn btn-primary btn-sm" style="margin-top:10px" data-goto="#/project/q3-plan">Browse the Q3 Plan board</button></div>`;
  } else {
    const q = searchTerm.trim().toLowerCase();
    const noneShown = !mine.length;
    let content;
    if (noneShown) {
      content = `<div class="empty-state">No matching tasks${q ? ` for “${esc(searchTerm)}”` : ''}.<br>
        <button id="clear-mytasks-filter" class="btn btn-ghost btn-sm" style="margin-top:8px">Clear search &amp; filters</button></div>`;
    } else if (mtView === 'table') {
      content = taskTableHtml(mine);
    } else if (mtView === 'board') {
      content = kanbanColsHtml(mine);
    } else { /* grouped */
      content = STATUS_ORDER.map(st => {
        const list = mine.filter(t => t.progress === st);
        if (!list.length) return '';
        return `
        <section class="mtask-group">
          <h2 class="mtask-group-title"><span class="status-dot ${PROGRESS[st].dot}"></span>${st}<span class="group-count">${list.length}</span></h2>
          ${taskTableHtml(list)}
        </section>`;
      }).join('');
    }
    body = `${pills}${mtToolbarHtml()}<div class="mt-content">${content}</div>`;
  }

  return `<section class="page-pad mtask-page">${hero}${body}</section>`;
};

let myTaskFilter = '';

routes.projects = () => {
  setCrumbs([{ label: 'Workspace' }, { label: 'Projects' }]);
  return `
    <section class="page-pad">
      <div class="page-head"><h1>Projects</h1>
        <p><button id="new-project-btn" class="btn btn-primary btn-sm">＋ New project</button></p></div>
      <div class="project-grid">
        ${PROJECTS.map(pr => `
          <button class="project-card" data-project="${pr.id}">
            <div class="pc-avatar" style="--a:${(personById(pr.members && pr.members[0]) || PEOPLE[0] || { color: '#43b3ff' }).color}">${pr.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>
            <h3>${esc(pr.name)}</h3><p>${esc(pr.desc)}</p>
            <div class="pc-meta"><span>${(pr.members || []).length} members</span><span>${typeof pr.open === 'number' ? pr.open : TASKS.filter(t => t.project === pr.id && t.progress !== 'Completed').length} open tasks</span></div>
          </button>`).join('')}
      </div>
    </section>`;
};

routes.project = (param) => {
  const pr = PROJECTS.find(p => p.id === param || slugify(p.name) === param);
  if (!pr) { location.hash = '#/projects'; return ''; }
  currentProject = pr.id;                       // scope board/filters/search to this project
  const tasks = scopedTasks();
  setCrumbs([{ label: 'Overview', hash: '#/home' }, { label: 'Projects', hash: '#/projects' }, { label: pr.name }]);
  const selected = tasks[0] || TASKS[0];
  return `
    <div class="content-split">
      ${boardSectionHtml(pr.name, ['Overview', `Tasks ${tasks.length}`, 'Board'], tasks.length ? (kanbanMode ? 2 : 1) : 1, tasks)}
      ${propertiesPanelHtml(selected)}
    </div>`;
};

/* Board view mode toggle (table ↔ kanban) */
let kanbanMode = false;

/* Active project scope — boards, filters and search only show this project's tasks */
let currentProject = 'q3-plan';
function scopedTasks() { return TASKS.filter(t => t.project === currentProject); }

routes.calendar = () => {
  setCrumbs([{ label: 'Workspace' }, { label: 'Calendar' }]);
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  const monthName = now.toLocaleString('en', { month: 'long' });
  const firstDow = new Date(year, month, 1).getDay(); // 0 = Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const events = {};
  TASKS.forEach(t => {
    const d = metaFor(t).deadline.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)/i);
    if (d) {
      const dayNum = +d[2];
      (events[dayNum] = events[dayNum] || []).push(`<span class="cal-ev ev-purple" title="${esc(t.name)}">${esc(t.name)}</span>`);
    }
  });
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-day empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    let ev = (events[d] || []).slice(0, 3).join('');
    if (d % 7 === 2 && !ev) ev = '<span class="cal-ev ev-blue">Standup</span>';
    cells.push(`<button class="cal-day${d === now.getDate() ? ' today' : ''}" data-calday="${d}">${d}${ev}</button>`);
  }
  return `
    <section class="page-pad">
      <div class="page-head"><h1>Calendar — ${monthName} ${year}</h1><p>Deadlines and events from your projects. Click a day to filter tasks.</p></div>
      <div class="calendar">
        <div class="cal-dow">Sun Mon Tue Wed Thu Fri Sat</div>
        <div class="cal-grid">${cells.join('')}</div>
      </div>
    </section>`;
};

routes.roadmaps = () => {
  setCrumbs([{ label: 'Workspace' }, { label: 'Roadmaps' }]);

  /* ---- Live stats from real tasks ---- */
  const doneAll   = TASKS.filter(t => t.progress === 'Completed').length;
  const inrevAll  = TASKS.filter(t => t.progress === 'In review').length;
  const ongoAll   = TASKS.filter(t => t.progress === 'Ongoing').length;
  const pendAll   = TASKS.filter(t => t.progress === 'Pending' || t.progress === 'On hold').length;
  const total     = TASKS.length || 1;
  const overall   = Math.round(((doneAll + inrevAll * 0.6 + ongoAll * 0.3) / total) * 100);
  const critical  = TASKS.filter(t => t.urgency === 'Critical' && t.progress !== 'Completed').length;
  const atRisk    = TASKS.filter(t => (t.progress === 'Pending' || t.progress === 'On hold') && t.urgency === 'Critical').length;
  const health    = atRisk > 2 ? 'At Risk' : overall >= 60 ? 'On Track' : 'Needs Attention';
  const healthCls = atRisk > 2 ? 'warn' : overall >= 60 ? 'good' : 'mid';
  const teamCnt   = new Set(TASKS.map(t => t.assignee)).size;

  /* ---- Phases derived from live project data (last two projects = upcoming quarters) ---- */
  const PHASE_META = [
    { q: 'Q1', tag: 'Foundation', icon: '🧱' },
    { q: 'Q2', tag: 'Growth',     icon: '📈' },
    { q: 'Q3', tag: 'Delivery',   icon: '🚀' },
    { q: 'Q4', tag: 'Scale',      icon: '🌐' },
  ];
  const projPct = (pr) => {
    const ts = TASKS.filter(t => t.project === pr.id);
    if (!ts.length) return 0;
    const d = ts.filter(t => t.progress === 'Completed').length;
    const r = ts.filter(t => t.progress === 'In review').length;
    const o = ts.filter(t => t.progress === 'Ongoing').length;
    return Math.round(((d + r * 0.6 + o * 0.3) / ts.length) * 100);
  };
  const allPhases = [
    ...PROJECTS.slice(0, 2).map((pr, i) => ({ ...PHASE_META[i], pr, pct: 100, shipped: true })),
    ...PROJECTS.slice(2).map((pr, i) => ({ ...PHASE_META[Math.min(2 + i, 3)], pr, pct: projPct(pr), shipped: false })),
  ];
  /* ---- Quarter filter (chips below the stats strip) ---- */
  const quarters = [...new Set(allPhases.map(p => p.q))];
  if (rmFilter !== 'all' && !quarters.includes(rmFilter)) rmFilter = 'all';
  const visible = rmFilter === 'all' ? allPhases : allPhases.filter(p => p.q === rmFilter);
  const phases   = visible.filter(p => p.shipped);
  const upcoming = visible.filter(p => !p.shipped);

  const statusBadge = (p) => {
    const map = { Completed: ['✓ Done', 'ev-green'], 'In review': ['👁 Review', 'ev-blue'], Ongoing: ['▶ Active', 'ev-purple'], Pending: ['◷ Queued', 'ev-gray'], 'On hold': ['⏸ Hold', 'ev-red'] };
    const [label, cls] = map[p] || ['—', 'ev-gray'];
    return `<span class="rm-chip ${cls}">${label}</span>`;
  };
  const urgIcon = (u) => u === 'Critical' ? '<span title="Critical priority" aria-label="Critical priority">🔥</span>'
                     : u === 'Moderate' ? '<span title="Medium priority" aria-label="Medium priority">⚡</span>' : '';

  const phaseCard = (ph, isUpcoming, i = 0) => {
    const pr = ph.pr;
    const ts = TASKS.filter(t => t.project === pr.id)
                    .sort((a, b) => (b.comments || 0) - (a.comments || 0))
                    .slice(0, 4);
    const barColor = ph.pct >= 80 ? 'var(--completed)' : ph.pct >= 40 ? 'var(--accent)' : 'var(--moderate)';
    return `
      <article class="rm-card${isUpcoming ? ' rm-upcoming' : ''}" style="--i:${i}" data-project="${pr.id}" tabindex="0" role="link" aria-label="Open project ${esc(pr.name)}">
        <header class="rm-card-head">
          <div class="rm-badge" aria-hidden="true">${ph.icon}</div>
          <div class="rm-titles">
            <div class="rm-kicker">${ph.q} · ${ph.tag}</div>
            <h3 class="rm-name">${esc(pr.name)}</h3>
          </div>
          <div class="rm-ring" style="--ring:${ph.pct}" title="${ph.pct}% complete" aria-label="${ph.pct}% complete">
            <span>${ph.pct}<em>%</em></span>
          </div>
        </header>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill rm-bar" style="width:${ph.pct}%;background:${barColor}"></div></div>
        <ul class="rm-list">
          ${ts.map(t => `
            <li class="rm-item" data-task="${t.idx ?? t.id}">
              <span class="rm-dot" aria-hidden="true"></span>
              <span class="rm-item-name">${urgIcon(t.urgency)} ${esc(t.name)}</span>
              ${statusBadge(t.progress)}
              <span class="avatar avatar-xs" style="--a:${(personById(t.assignee) || {}).color || '#999'}" title="${esc((personById(t.assignee) || {}).name || '')}">${(personById(t.assignee) || {}).initials || '?'}</span>
            </li>`).join('') || '<li class="rm-item muted">No tasks yet — this quarter is a blank canvas ✨</li>'}
        </ul>
        <footer class="rm-foot">
          <span>${TASKS.filter(t => t.project === pr.id).length} tasks</span>
          <span class="rm-open">Open board →</span>
        </footer>
      </article>`;
  };

  return `
    <section class="page-pad roadmap-page">
      <div class="page-head rm-head">
        <div>
          <h1>Roadmaps</h1>
          <p>Strategic timeline across quarters — live from your workspace.</p>
        </div>
        <div class="rm-health ${healthCls}" role="status">
          <span class="rm-pulse" aria-hidden="true"></span>
          <strong>${health}</strong>
          <em>${overall}% of the year delivered</em>
        </div>
      </div>

      <div class="rm-stats" role="list">
        <div class="rm-stat" role="listitem"><b>${total}</b><span>Total tasks</span></div>
        <div class="rm-stat good" role="listitem"><b>${doneAll}</b><span>Completed</span></div>
        <div class="rm-stat amber" role="listitem"><b>${ongoAll + inrevAll}</b><span>In flight</span></div>
        <div class="rm-stat red" role="listitem"><b>${critical}</b><span>Critical open</span></div>
        <div class="rm-stat" role="listitem"><b>${teamCnt}</b><span>Contributors</span></div>
      </div>

      <div class="rm-filters" role="group" aria-label="Filter roadmap by quarter">
        <button class="rm-chipf ${rmFilter === 'all' ? 'on' : ''}" data-rmf="all">All quarters</button>
        ${quarters.map(q => `<button class="rm-chipf ${rmFilter === q ? 'on' : ''}" data-rmf="${q}">${q}</button>`).join('')}
      </div>

      <div class="rm-track" aria-label="Timeline track">
        <div class="rm-line" aria-hidden="true"></div>
        ${[...phases, ...upcoming].map((ph, i) => `
          <div class="rm-node" style="--i:${i}">
            <span class="rm-node-dot ${i < 2 ? 'done' : ''}" aria-hidden="true"></span>
          </div>`).join('')}
      </div>

      <h2 class="rm-section-title">🏁 Shipped &amp; shipping</h2>
      ${phases.length ? `<div class="rm-grid">${phases.map((p, i) => phaseCard(p, false, i)).join('')}</div>` : ''}

      <h2 class="rm-section-title">🔮 Upcoming quarters</h2>
      ${upcoming.length ? `<div class="rm-grid">${upcoming.map((p, i) => phaseCard(p, true, i + phases.length)).join('')}</div>` : ''}

      ${!phases.length && !upcoming.length ? '<div class="empty-state">No quarters match this filter.</div>' : ''}
    </section>`;
};

routes.channel = (param) => {
  const key = param || 'engineering';
  const ch = CHANNELS[key] || { topic: 'Team conversation.' };
  const name = key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  setCrumbs([{ label: 'Channels' }, { label: '#' + name }]);
  const msgs = CHANNEL_MESSAGES[key] || [];
  return `
    <section class="page-pad">
      <div class="page-head"><h1># ${name}</h1><p>${ch.topic}</p></div>
      <ul class="chat-list">
        ${msgs.map(m => `
          <li><span class="avatar avatar-sm" style="--a:${m.color}">${m.initials}</span>
            <div class="chat-body"><div class="chat-top"><strong>${m.who}</strong><em>${m.time}</em></div>
            <p>${esc(m.text)}</p></div></li>`).join('') || '<div class="empty-state">No messages yet — say hi!</div>'}
      </ul>
      <form id="chat-form" class="comment-input chat-input">
        <input id="chat-box" type="text" placeholder="Message # ${name} (Enter to send)" aria-label="Send a message" />
        <button id="chat-send" class="btn btn-primary btn-sm" type="submit">Send</button>
      </form>
    </section>`;
};

routes.settings = () => {
  setCrumbs([{ label: 'TaskHive' }, { label: 'Settings' }]);
  const me = mePerson() || { name: '', email: '' };
  const darkOn = document.documentElement.classList.contains('dark');
  const myTasks = TASKS.filter(t => t.assignee === ME);
  const openCnt = myTasks.filter(t => t.progress !== 'Completed').length;
  const doneCnt = myTasks.filter(t => t.progress === 'Completed').length;
  const unreadCnt = INBOX_ITEMS.filter(it => !readFlags[it.id]).length;
  return `
    <section class="page-pad settings-page">
      <div class="page-head settings-head">
        <div><h1>Settings</h1><p class="muted">Manage your profile, preferences and workspace.</p></div>
        <a class="btn btn-ghost btn-sm" href="#/home">← Back to workspace</a>
      </div>

      <!-- Profile hero card -->
      <div class="settings-group st-hero">
        <div class="st-hero-top">
          <span class="st-avatar-wrap" title="${esc(me.name || '')}">
            <span class="avatar avatar-lg" style="--a:${esc(me.color || '#888')}">${esc(me.initials || '??')}</span>
            <span class="st-presence" aria-hidden="true"></span>
          </span>
          <div class="st-hero-id">
            <h2>${esc(me.name || '—')}</h2>
            <p class="muted">${esc(me.email || '')}</p>
            <span class="st-badge">Signed in</span>
          </div>
          <div class="st-hero-stats">
            <div class="st-stat"><b>${openCnt}</b><span>Open tasks</span></div>
            <div class="st-stat"><b>${doneCnt}</b><span>Completed</span></div>
            <div class="st-stat"><b>${unreadCnt}</b><span>Unread inbox</span></div>
          </div>
        </div>
      </div>

      <div class="st-grid">
        <!-- Account -->
        <div class="settings-group">
          <h3>👤 Account</h3>
          <p class="st-desc">Your identity across the workspace. Changes save to the server.</p>
          <label class="st-field">Display name<input id="set-name" type="text" value="${esc(me.name)}" autocomplete="name" /></label>
          <label class="st-field">Email<input id="set-email" type="email" value="${esc(me.email || '')}" autocomplete="email" placeholder="you@company.com" /></label>
          <label class="st-field">New password<input id="set-password" type="password" placeholder="leave blank to keep current password" autocomplete="new-password" />
            <span class="st-hint">Used to sign in. Must be at least 4 characters if changed.</span></label>
        </div>

        <!-- Preferences -->
        <div class="settings-group">
          <h3>⚙️ Preferences</h3>
          <p class="st-desc">Toggles are saved instantly and follow you on every device.</p>
          <div class="switch-row">
            <div><strong>Email notifications</strong><p class="muted">Assignments, mentions and reviews</p></div>
            <label class="toggle"><input type="checkbox" role="switch" id="set-email-notif" ${toggleState('emailNotifications') ? 'checked' : ''} aria-checked="${toggleState('emailNotifications')}" aria-label="Email notifications" /><span class="toggle-track"></span></label>
          </div>
          <div class="switch-row">
            <div><strong>Weekly digest</strong><p class="muted">A Monday summary of your workspace</p></div>
            <label class="toggle"><input type="checkbox" role="switch" id="set-digest" ${toggleState('weeklyDigest') ? 'checked' : ''} aria-checked="${toggleState('weeklyDigest')}" aria-label="Weekly digest" /><span class="toggle-track"></span></label>
          </div>
          <div class="switch-row">
            <div><strong>Dark mode</strong><p class="muted">${darkOn ? 'Currently using the dark theme 🌙' : 'Currently using the light theme ☀️'}</p></div>
            <label class="toggle"><input type="checkbox" role="switch" id="set-dark" ${darkOn ? 'checked' : ''} aria-checked="${darkOn}" aria-label="Dark mode" /><span class="toggle-track"></span></label>
          </div>
        </div>

        <!-- Workspace -->
        <div class="settings-group">
          <h3>🗂 Workspace</h3>
          <p class="st-desc">${PROJECTS.length} projects · ${TASKS.length} tracked issues</p>
          <div class="switch-row">
            <div><strong>Export backup</strong><p class="muted">Download a full JSON snapshot of the workspace</p></div>
            <a id="export-data" class="btn btn-ghost btn-sm" href="/api/export" download>Export</a>
          </div>
          <div class="switch-row">
            <div><strong>Purge deleted rows</strong><p class="muted">Permanently remove soft-deleted tasks from storage</p></div>
            <button id="purge-data" class="btn btn-ghost danger btn-sm">Purge</button>
          </div>
          <div class="switch-row">
            <div><strong>Import backup</strong><p class="muted">Restore a JSON snapshot exported earlier (admin only)</p></div>
            <label class="btn btn-ghost btn-sm" for="import-data" style="cursor:pointer">Import</label>
            <input type="file" id="import-data" accept=".json,application/json" hidden />
          </div>
          <div class="switch-row">
            <div><strong>Reset demo data</strong><p class="muted">Reload this workspace from the server copy</p></div>
            <button id="reset-data" class="btn btn-ghost danger btn-sm">Reset</button>
          </div>
        </div>

        <!-- Session -->
        <div class="settings-group">
          <h3>🔐 Session</h3>
          <p class="st-desc">You're signed in as <strong>${esc(me.name || '—')}</strong>. Signing out clears your session cookie on this device.</p>
          <button id="logout-btn" class="btn btn-ghost">Sign out</button>
        </div>
      </div>

      <div class="settings-actions st-savebar">
        <button id="save-settings" class="btn btn-primary">Save account changes</button>
        <span class="muted st-savenote">Preference toggles save automatically.</span>
      </div>
    </section>`;
};

routes.help = () => {
  setCrumbs([{ label: 'Support' }, { label: 'Help & support' }]);
  const faqs = [
    ['How do I create a task?', 'Use the “New task” button in the top bar of any project board.'],
    ['Where are my saved items?', 'Click ☆ in a task’s Properties panel — they appear under Saved items.'],
    ['How does Inbox work?', 'Mentions, assignments and reviews land there; click a notification to jump to its task.'],
    ['Can I share a project?', 'Yes — the Share button copies a workspace link to your clipboard.'],
  ];
  return `
    <section class="page-pad narrow">
      <div class="page-head"><h1>Help &amp; support</h1><p>Frequently asked questions about this workspace.</p></div>
      <div class="faq">
        ${faqs.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}
      </div>
      <div class="settings-actions">
        <button id="contact-support" class="btn btn-primary">Contact support</button>
        <button id="keyboard-shortcuts" class="btn btn-ghost">Keyboard shortcuts</button>
      </div>
    </section>`;
};

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

/* ============================ GLOBAL ACTIONS ============================ */

/* ---- workspace people: shared state + helpers (assignee dropdowns, People list) ----
   PEOPLE is hydrated from GET /api/bootstrap and refreshed by loadMembers()
   after every add/remove, so newly added people (active OR invited) appear
   immediately in every Assignee dropdown without a page reload. */
const normEmail = (s) => String(s == null ? '' : s).trim().toLowerCase();

async function loadMembers() {
  try {
    const list = await api('GET', '/members');
    if (Array.isArray(list)) PEOPLE = list;
  } catch (_) { /* keep the last known list on network failure */ }
  renderPeopleList();               // refresh Settings → People if mounted
  syncAddPersonItem();              // re-apply admin gating after data changes
}

function personStatus(p) {
  if (!p) return '';
  if (p.invited || p.status === 'invited' || String(p.id).startsWith('inv-')) return 'invited';
  return 'active';
}

/* Options for any Assignee <select>: "Unassigned" first, then active members,
   then pending invites (marked), excluding already-removed people. */
function assigneeOptionsHtml(current) {
  const cur = current == null ? '' : String(current);
  const opt = (p, invited) =>
    `<option value="${esc(p.id)}"${cur === String(p.id) ? ' selected' : ''}>${esc(p.name)}${invited ? ' (invited)' : ''}</option>`;
  const act = PEOPLE.filter(p => personStatus(p) === 'active').map(p => opt(p, false));
  const inv = PEOPLE.filter(p => personStatus(p) === 'invited').map(p => opt(p, true));
  return `<option value=""${cur === '' ? ' selected' : ''}>Unassigned</option>` + act.join('') + inv.join('');
}

/* Re-render ONLY the assignee selects that are currently open, so adding or
   removing a person updates the New task dialog / task panel live. */
function refreshAssigneeSelects() {
  document.querySelectorAll('select[data-assignee-select]').forEach(sel => {
    sel.innerHTML = assigneeOptionsHtml(sel.value);
  });
}

/* Settings → People section markup (rendered async so it survives re-renders). */
function peopleSectionHtml() {
  const canManage = canManagePeople();
  const rows = PEOPLE.map(p => {
    const st = personStatus(p);
    const role = esc(p.role || 'member');
    return `<li class="people-row">
      <span class="avatar avatar-sm" style="--a:${esc(p.color || '#8a93a6')}" aria-hidden="true">${esc(p.initials || '?')}</span>
      <span class="people-id"><strong>${esc(p.name)}</strong><small>${esc(p.email || '')}</small></span>
      <span class="people-role">${role}</span>
      <span class="people-status ${st}">${st === 'invited' ? 'Invited' : 'Active'}</span>
      ${canManage && String(p.id) !== String(ME)
        ? `<button class="btn btn-ghost btn-sm people-remove" data-rmperson="${esc(p.id)}" aria-label="Remove ${esc(p.name)} from workspace">Remove</button>`
        : ''}
    </li>`;
  }).join('');
  return `<ul class="people-list">${rows || '<li class="people-empty muted">No people yet.</li>'}</ul>` +
    (canManage
      ? `<button class="btn btn-secondary btn-sm people-add-btn" data-new="person-open">＋ Add person</button>`
      : `<p class="people-note muted">Only workspace admins can add or remove people.</p>`);
}

function renderPeopleList() {
  const box = document.getElementById('people-list');
  if (box) box.innerHTML = peopleSectionHtml();
}

function showUpgradeModal() {
  openModal('Upgrade plan', `
    <p class="modal-lead">Unlock unlimited projects, guests and history.</p>
    <div class="plan-grid">
      <div class="plan"><h3>Starter</h3><div class="plan-price">$0</div><ul><li>3 projects</li><li>15 tasks/project</li></ul><button class="btn btn-ghost btn-sm plan-btn">Current</button></div>
      <div class="plan featured"><h3>Pro</h3><div class="plan-price">$12<span>/mo</span></div><ul><li>Unlimited projects</li><li>Guest access</li><li>Priority support</li></ul><button class="btn btn-primary btn-sm plan-btn" data-plan="Pro">Choose Pro</button></div>
      <div class="plan"><h3>Business</h3><div class="plan-price">$29<span>/mo</span></div><ul><li>SSO & audit logs</li><li>Advanced roadmaps</li></ul><button class="btn btn-primary btn-sm plan-btn" data-plan="Business">Choose Business</button></div>
    </div>`);
}

function showShareModal(projectName) {
  openModal(`Share “${projectName}”`, `
    <label>Invite by email<input id="share-email" type="email" placeholder="teammate@company.com" /></label>
    <label class="switch-row">Can edit<input type="checkbox" checked /></label>
    <div class="share-link-row">
      <input id="share-link" type="text" readonly value="https://app.catlas.inc/p/${slugify(projectName)}" />
      <button id="copy-link" class="btn btn-primary btn-sm">Copy link</button>
    </div>
    <button id="send-invite" class="btn btn-ghost btn-sm">Send invite</button>`);
}

function showNewFeatureModal() {
  /* Assignees = real workspace members (incl. people added via "Add person"),
     with "Unassigned" first; Project list always starts with "No project";
     Urgency defaults to Medium ("Moderate"). */
  const projOpts = `<option value="">No project</option>` + PROJECTS.map(p => `<option value="${esc(p.id)}"${p.id === currentProject ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  openModal('New task', `
    <form id="new-feature-form">
      <label>Name<input id="nf-name" type="text" required placeholder="e.g. Add keyboard shortcuts" /></label>
      <label>Progress<select id="nf-progress">${Object.keys(PROGRESS).map(k => `<option>${k}</option>`).join('')}</select></label>
      <label>Urgency<select id="nf-urgency">${Object.keys(URGENCY).map(k => `<option${k === 'Moderate' ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>Assignee<select id="nf-assignee" data-assignee-select>${assigneeOptionsHtml(ME)}</select></label>
      <label>Project<select id="nf-project">${projOpts}</select></label>
      <button type="submit" class="btn btn-primary">Create task</button>
    </form>`);
}

const PROJECT_COLORS = ['', '#7c5cff', '#43b3ff', '#2fbf71', '#f5a623', '#e5484d', '#9b7bff'];
function showNewProjectModal() {
  openModal('New project', `
    <form id="new-project-form">
      <label>Name<input id="np-name" type="text" required maxlength="120" placeholder="e.g. Mobile App v3" autocomplete="off" /></label>
      <label>Description<textarea id="np-desc" rows="3" placeholder="What is this project about? (optional)"></textarea></label>
      <label>Color<select id="np-color">${PROJECT_COLORS.map((c, i) => `<option value="${c}"${i === 0 ? ' selected' : ''}>${c ? c : 'Default (accent)'}</option>`).join('')}</select></label>
      <p class="field-error hidden" id="np-error" role="alert"></p>
      <button type="submit" class="btn btn-primary">Create project</button>
    </form>`);
}

function showNewChannelModal() {
  openModal('New channel', `
    <form id="new-channel-form">
      <label>Name<input id="nc-name" type="text" required minlength="2" maxlength="30" placeholder="e.g. release-train (2–30 characters)" autocomplete="off" /></label>
      <label>Topic<input id="nc-topic" type="text" maxlength="200" placeholder="What is this channel for? (optional)" autocomplete="off" /></label>
      <p class="field-error hidden" id="nc-error" role="alert"></p>
      <button type="submit" class="btn btn-primary">Create channel</button>
    </form>`);
}

function showAddPersonModal() {
  openModal('Add person', `
    <form id="add-person-form">
      <label>Full name<input id="ap-name" type="text" required maxlength="80" placeholder="e.g. Jordan Lee" autocomplete="off" /></label>
      <label>Email<input id="ap-email" type="email" required maxlength="120" placeholder="jordan@company.com" autocomplete="off" /></label>
      <label>Role<select id="ap-role"><option value="member" selected>Member</option><option value="admin">Admin</option></select></label>
      <p class="field-error hidden" id="ap-error" role="alert"></p>
      <div class="invite-note hidden" id="ap-note"></div>
      <button type="submit" class="btn btn-primary" id="ap-submit">Add person</button>
    </form>`);
}

function setFormError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}
function setSubmitting(btnSel, busy, label = 'Save') {
  const b = $(btnSel);
  if (!b) return;
  b.disabled = busy;
  b.textContent = busy ? 'Working…' : label;
}

/* ============================ EVENT DELEGATION ============================ */

document.body.addEventListener('click', (e) => {
  /* ---- column header menu: handle first, before generic closest() ---- */
  const menuBtn = e.target.closest('.col-menu [data-menuact]');
  if (menuBtn) {
    const [kind, a, b] = menuBtn.dataset.menuact.split(':');
    closeColMenus();
    if (kind === 'sort') sortState = { key: a, dir: b === 'asc' ? 1 : -1 };
    else if (kind === 'setf') filterState[a] = decodeURIComponent(b);
    else if (kind === 'clearf') filterState[a] = '';
    refreshViews();
    return;
  }
  const thBtn = e.target.closest('.th-btn');
  if (thBtn) { openColMenu(thBtn); return; }
  if (document.querySelector('.col-menu')) closeColMenus(); // click outside → dismiss

  const el = e.target.closest('[id],[data-goto],[data-calday],[data-project],[data-inbox],[data-attachment],[data-person],[data-plan],[data-view],[data-export],[data-status],[data-mtview],[data-mtchip],[data-del],[data-rmf]');
  if (!el) return;

  // Roadmap quarter filter chips
  if (el.dataset.rmf) { rmFilter = el.dataset.rmf; render(); return; }

  // My Tasks status pills (must run before the generic closest() id lookup)
  const pill = e.target.closest('.mt-pill');
  if (pill) {
    const st = pill.dataset.status;
    myTaskFilter = (!st || st === myTaskFilter) ? '' : st; // "All" resets; clicking active pill toggles off
    render();
    return;
  }

  // board table/kanban view toggle
  if (el.dataset.view !== undefined && el.classList.contains('vt-btn')) { setKanban(el.dataset.view === 'kanban'); return; }

  // simple navigation shortcuts
  const goto = el.getAttribute('data-goto');
  if (goto) { location.hash = goto; return; }

  if (el.id === 'upgrade-btn') return showUpgradeModal();
  if (el.id === 'new-task-btn' || el.classList.contains('new-task-empty')) return showNewFeatureModal();
  if (el.id === 'new-fab') { e.preventDefault(); return showNewFeatureModal(); }
  if (el.dataset.new !== undefined && el.closest('#new-split-menu')) {
    closeSplitMenu();
    if (el.dataset.new === 'task') return showNewFeatureModal();
    if (el.dataset.new === 'project') return showNewProjectModal();
    if (el.dataset.new === 'channel') return showNewChannelModal();
    if (el.dataset.new === 'person') return showAddPersonModal();
  }
  if (el.dataset.plan) { closeModal(); return toast(`🎉 ${el.dataset.plan} plan selected (demo)`); }
  if (el.id === 'copy-link') {
    const inp = $('#share-link');
    const done = () => toast('Link copied to clipboard');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inp.value).then(done, () => fallbackCopy(inp, done));
    } else fallbackCopy(inp, done);
    return;
  }
  if (el.id === 'send-invite') {
    const v = $('#share-email').value.trim();
    if (!v) return toast('Enter an email first');
    $('#share-email').value = ''; return toast(`Invite sent to ${v}`);
  }
  if (el.id === 'share-btn') {
    const title = el.closest('.board')?.querySelector('.project-title')?.textContent || 'Q3 Plan';
    return showShareModal(title);
  }

  if (el.id === 'mark-all-read') {
    INBOX_ITEMS.forEach(it => { readFlags[it.id] = true; });
    patchInboxReadAll();
    persist(); render(); return toast('Inbox cleared');
  }
  if (el.dataset.inbox !== undefined) {
    const it = INBOX_ITEMS.find(x => x.id === el.dataset.inbox);
    if (!it) return;
    readFlags[it.id] = true; patchInboxRead(it.id); persist();
    if (it.task != null) {
      const t = TASKS.find(x => x.id === it.task);
      if (t) { location.hash = `#/task/${t.idx}`; return; }
    }
    render();
    return;
  }
  if (el.dataset.calday !== undefined) {
    const day = el.dataset.calday;
    const matches = TASKS.filter(t => metaFor(t).deadline.includes(` ${day},`));
    if (!matches.length) return toast(`No deadlines on day ${day}`);
    openModal(`Deadlines on the ${day}th`, `
      <ul class="mini-tasks">${matches.map(t =>
        `<li><span class="status-dot ${PROGRESS[t.progress].dot}"></span><a href="#/task/${t.idx}">${esc(t.name)}</a></li>`).join('')}</ul>`);
    return;
  }
  if (el.dataset.project !== undefined) {
    location.hash = `#/project/${el.dataset.project}`;
    return;
  }
  if (el.id === 'new-project-btn') return showNewProjectModal();
  if (el.dataset.person !== undefined) {
    const p = personById(el.dataset.person);
    return openModal(p.name, `
      <div class="profile-head"><span class="avatar" style="--a:${p.color};width:48px;height:48px;font-size:16px">${p.initials}</span>
      <div><h3>${esc(p.name)}</h3><p>Engineering · TaskHive</p></div></div>
      <p class="modal-lead">Assigned tasks:</p>
      <ul class="mini-tasks">${TASKS.filter(t => t.assignee === el.dataset.person).map(t =>
        `<li><span class="status-dot ${PROGRESS[t.progress].dot}"></span><a href="#/task/${t.idx}">${esc(t.name)}</a></li>`).join('')}</ul>`);
  }
  if (el.dataset.attachment) { e.preventDefault(); return toast(`⬇ Downloading ${el.dataset.attachment}… (demo)`); }

  if (el.id === 'save-toggle') {
    const t = byIdx(+(el.dataset.idx ?? 0));
    if (!t) return;
    if (savedIds.includes(t.id)) { savedIds = savedIds.filter(i => i !== t.id); toast('Removed from saved items'); }
    else { savedIds.push(t.id); toast('★ Saved item'); }
    persist(); render(); return;
  }
  if (el.id === 'save-settings') {
    const nameEl = $('#set-name'), emailEl = $('#set-email'), passEl = $('#set-password');
    const body = {};
    if (nameEl && nameEl.value.trim()) body.name = nameEl.value.trim();
    if (emailEl && emailEl.value.trim()) body.email = emailEl.value.trim();
    if (passEl && passEl.value) body.password = passEl.value;
    if (!ME) return toast('Sign in first');
    updateProfile(body).then(updated => {
      const i = PEOPLE.findIndex(p => p.id === updated.id);
      if (i > -1) PEOPLE[i] = updated; else PEOPLE.push(updated);
      try { localStorage.removeItem(LS_KEY + '.' + ME); } catch (_) {}
      render(); // stay on Settings — hero card re-renders with the new name
      toast('✔ Settings saved');
    }).catch(err => {
      if (err.status === 401) handleAuthError(err);
      else toast(`⚠ ${err.message}`);
    });
    return;
  }
  if (el.id === 'logout-btn') return doLogout().then(() => renderLoginScreen());
  if (el.id === 'reset-data') {
    try { localStorage.clear(); } catch (_) {}
    savedIds = []; readFlags = {};
    patchPrefs();
    location.hash = '#/home';
    loadBootstrap().then(render); return toast('Workspace reloaded from server');
  }
  if (el.id === 'purge-data') {
    mutate('/api/purge', 'POST', {}, (r) => {
      render();
      toast(r.purged ? `🧹 Purged ${r.purged} deleted task row${r.purged > 1 ? 's' : ''}` : 'Nothing to purge — storage is clean');
    }, 'Purge failed');
    return;
  }
  /* ---- import backup: restore a JSON snapshot via POST /api/import ---- */
  if (el.id === 'import-data' && el.files && el.files[0]) {
    const file = el.files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      let snap;
      try { snap = JSON.parse(String(reader.result)); }
      catch (_) { return toast('⚠️ That file isn\'t valid JSON'); }
      try {
        const r = await api('POST', '/api/import', snap);
        await loadBootstrap();
        render();
        toast(`✅ Restored ${r.tasks} tasks · ${r.people} people from ${file.name}`);
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    };
    reader.onerror = () => toast('Could not read that file');
    reader.readAsText(file);
    el.value = ''; // allow re-selecting the same file later
    return;
  }
  if (el.id === 'contact-support') return openModal('Contact support', `<form id="support-form"><label>Subject<input type="text" required /></label><label>Message<textarea rows="4" required></textarea></label><button class="btn btn-primary">Send message</button></form>`);
  if (el.id === 'keyboard-shortcuts') return openModal('Keyboard shortcuts', `<ul class="shortcuts"><li><kbd>C</kbd> New task · <kbd>/</kbd> or <kbd>Ctrl K</kbd> Search</li><li><kbd>/</kbd> Focus search</li><li><kbd>Esc</kbd> Close dialogs</li><li><kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd> Undo last change</li><li><kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> Toggle dark mode</li><li><kbd>Enter</kbd> on a focused row opens the task</li></ul>`);

  // task row selection inside boards
  const tr = e.target.closest('.task-table tbody tr');
  if (tr && !e.target.closest('.link-avatar') && !e.target.closest('button') && !e.target.closest('input')) {
    document.querySelectorAll('.task-table tbody tr.selected').forEach(r => r.classList.remove('selected'));
    tr.classList.add('selected');
    const propsHost = document.querySelector('.content-split .properties') || document.querySelector('.page-pad .properties');
    if (propsHost) {
      const fresh = document.createElement('div');
      fresh.innerHTML = propertiesPanelHtml(byIdx(+tr.dataset.idx));
      propsHost.replaceWith(fresh.firstElementChild);
    } else {
      const t = TASKS.find(x => x.idx === +tr.dataset.idx);
      if (t) location.hash = `#/task/${t.idx}`;
    }
  }

  /* ---- delete with confirm dialog ---- */
  if (el.dataset.del !== undefined) {
    const t = TASKS.find(x => x.idx === +el.dataset.del);
    if (!t) return;
    return openModal('Delete task?', `
      <p class="modal-lead">“${esc(t.name)}” will be removed from the board. You can undo right after.</p>
      <div class="settings-actions">
        <button id="confirm-delete" data-idx="${t.idx}" class="btn btn-primary danger">Delete</button>
        <button id="cancel-delete" class="btn btn-ghost">Cancel</button>
      </div>`);
  }
  if (el.id === 'confirm-delete') { deleteTask(+el.dataset.idx); closeModal(); return; }
  if (el.id === 'cancel-delete') { closeModal(); return; }

  /* ---- rename from Properties panel ---- */
  if (el.id === 'edit-task-btn') { startRename(+el.dataset.idx); return; }

  /* ---- clear filters / export csv / bulk actions / undo ---- */
  if (el.id === 'clear-filters') { filterState = { progress: '', urgency: '', assignee: '' }; renderBoardBody(); return; }
  if (el.id === 'clear-mytasks-filter') { myTaskFilter = ''; searchTerm = ''; sortState = { key: null, dir: 1 }; filterState = { progress: '', urgency: '', assignee: '' }; const gs = $('#global-search'); if (gs) gs.value = ''; render(); return; }
  if (el.classList.contains('mt-pill')) {
    const st = el.dataset.status;
    myTaskFilter = (!st || st === myTaskFilter) ? '' : st; // "All" resets; clicking active pill toggles off
    render();
    return;
  }
  if (el.dataset.mtview) { setMtView(el.dataset.mtview); return; }
  if (el.dataset.mtchip) {
    const k = el.dataset.mtchip;
    if (k === 'status') myTaskFilter = '';
    else filterState[k] = '';
    render();
    return;
  }
  if (el.hasAttribute('data-export')) { exportCsv(visibleTasks()); return toast('⬇ tasks.csv downloaded'); }
  if (el.id === 'bulk-delete') { bulkDelete(); return; }
  if (el.id === 'undo-btn') { undoLast(); return; }

  // tabs on boards
  const tab = e.target.closest('.tab');
  if (tab) {
    const tabsWrap = tab.closest('.tabs');
    tabsWrap.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const i = +tab.dataset.tab;
    const host = $('#board-body');
    if (!host) return;
    if (i === 2) { kanbanMode = true; renderKanban(); return; }
    kanbanMode = false;
    if (currentRoute === 'mytasks') { render(); return; } else {
      host.innerHTML = i === 0 ? overviewHtml() : (toolbarHtml() + (() => { const rows = visibleTasks(); return rows.length ? taskTableHtml(rows) : '<div class="empty-state">No tasks match your search or filters.</div>'; })());
    }
  }
});

/* ---- bulk action bar (appears when rows are checked) ---- */
document.body.addEventListener('change', (e) => {
  if (e.target.classList.contains('row-check')) updateBulkBar();
  if (e.target.id === 'flt-progress') { filterState.progress = e.target.value; refreshViews(); }
  if (e.target.id === 'flt-urgency')  { filterState.urgency = e.target.value; refreshViews(); }
  if (e.target.id === 'flt-assignee') { filterState.assignee = e.target.value; refreshViews(); }
  /* Import backup: file input fires 'change' when a snapshot is selected. */
  if (e.target.id === 'import-data' && e.target.files && e.target.files[0]) {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      let snap;
      try { snap = JSON.parse(String(reader.result)); }
      catch (_) { return toast('⚠️ That file isn\'t valid JSON'); }
      try {
        const r = await api('POST', '/api/import', snap);
        await loadBootstrap();
        render();
        toast(`✅ Restored ${r.tasks} tasks · ${r.people} people from ${file.name}`);
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    };
    reader.onerror = () => toast('Could not read that file');
    reader.readAsText(file);
    e.target.value = ''; // allow re-selecting the same file later
  }
  if (e.target.id === 'prop-status') {
    const idx = +e.target.dataset.idx;
    const t = TASKS.find(x => x.idx === idx);
    if (t) {
      const old = t.progress; t.progress = e.target.value;
      patchTask(t, { progress: t.progress }, 'Status not saved');
      updateTaskRow(idx);
      showUndoToast(`Status → ${t.progress}`);
      undoStack.push({ label: `Status change`, run: () => { t.progress = old; patchTask(t, { progress: old }); render(); } });
    }
  }
});

function updateBulkBar() {
  const n = document.querySelectorAll('.row-check:checked').length;
  let bar = $('.bulkbar');
  if (!n) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'bulkbar';
    bar.innerHTML = `<span id="bulk-count"></span><button id="bulk-delete" class="btn btn-primary btn-sm danger">🗑 Delete selected</button>`;
    ($('.board') || document.body).appendChild(bar);
  }
  bar.querySelector('#bulk-count').textContent = `${n} selected`;
}

/* double-click a task name to rename inline */
document.body.addEventListener('dblclick', (e) => {
  const name = e.target.closest('.feature-name');
  if (name) {
    const tr = name.closest('tr[data-idx]');
    if (tr) startRename(+tr.dataset.idx);
  }
});

/* keyboard: Enter on a focused row opens the task; ↑/↓ move between rows */
document.body.addEventListener('keydown', (e) => {
  const tr = e.target.closest('.task-table tbody tr[data-idx]');
  if (!tr || e.target.tagName === 'INPUT') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const t = TASKS.find(x => x.idx === +tr.dataset.idx);
    if (t) location.hash = `#/task/${t.idx}`;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = [...document.querySelectorAll('.task-table tbody tr[data-idx]')];
    const i = rows.indexOf(tr);
    const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  }
});

/* Overview tab content for the project board */
function overviewHtml() {
  const scope = (currentRoute === 'project' || currentRoute === 'task') ? scopedTasks() : TASKS;
  const counts = {};
  scope.forEach(t => counts[t.progress] = (counts[t.progress] || 0) + 1);
  return `
    <div class="overview">
      <h3>Status breakdown</h3>
      <div class="bar-chart">
        ${Object.entries(counts).map(([k, v]) => `
          <div class="bar-row"><span class="bar-label"><span class="status-dot ${PROGRESS[k].dot}"></span>${k}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(v / Math.max(scope.length,1) * 100)}%"></div></div>
          <span class="bar-count">${v}</span></div>`).join('')}
      </div>
      <h3>Team</h3>
      <div class="team-row">
        ${PEOPLE.map(p => `<button class="avatar link-avatar" data-person="${p.id}" style="--a:${p.color}" title="${p.name}">${p.initials}</button>`).join('')}
      </div>
      <p class="modal-lead">Switch to the <strong>Tasks</strong> tab to see all ${scope.length} tasks.</p>
    </div>`;
}

/* Task detail route */
routes.task = (param) => {
  const t = TASKS.find(x => x.idx === +param);
  if (!t) { location.hash = '#/project/q3-plan'; return ''; }
  currentProject = t.project || 'q3-plan';   // scope the board to this task's project
  const prName = (PROJECTS.find(p => slugify(p.name) === currentProject) || { name: 'Q3 Plan' }).name;
  setCrumbs([{ label: 'Overview', hash: '#/home' }, { label: 'Projects', hash: '#/projects' }, { label: prName, hash: `#/project/${currentProject}` }, { label: t.name }]);
  return `
    <div class="content-split">
      ${boardSectionHtml(prName, ['Overview', `Tasks ${scopedTasks().length}`, 'Board'], kanbanMode ? 2 : 1, filteredTasks())}
      ${propertiesPanelHtml(t)}
    </div>`;
};

/* ============================ SEARCH ============================ */

let searchTerm = '';
function filteredTasks() {
  const q = searchTerm.trim().toLowerCase();
  const base = (currentRoute === 'project' || currentRoute === 'task') ? scopedTasks() : TASKS;
  return base.filter(t => !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
}

document.body.addEventListener('input', (e) => {
  if (e.target.id === 'mt-search') {
    searchTerm = e.target.value;
    render(); // full re-render keeps pills, chips, counts and all grouped sections in sync
  }
});

/* ============================ GLOBAL SEARCH (dropdown) ============================ */

const searchWrap = () => $('#search-wrap');
let searchPickIdx = -1;

function focusGlobalSearch() {
  const inp = $('#global-search');
  if (!inp) return;
  searchWrap().classList.add('mobile-open');           // expands the icon-only input on phones
  $('#search-icon-btn')?.setAttribute('aria-expanded', 'true');
  inp.focus();
  updateSearchResults(inp.value);
}

function splitMenuItems() {
  return [...document.querySelectorAll('#new-split-menu [role="menuitem"]')].filter(b => !b.disabled && !b.hidden);
}
function openSplitMenu(focusFirst = false) {
  const menu = $('#new-split-menu');
  if (!menu) return;
  menu.classList.remove('hidden');
  $('#new-split-toggle')?.setAttribute('aria-expanded', 'true');
  if (focusFirst) splitMenuItems()[0]?.focus();
}
function closeSplitMenu(returnFocus = false) {
  $('#new-split-menu')?.classList.add('hidden');
  $('#new-split-toggle')?.setAttribute('aria-expanded', 'false');
  if (returnFocus) $('#new-split-toggle')?.focus();
}
$('#new-split-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#new-split-menu');
  if (menu.classList.contains('hidden')) { openSplitMenu(true); }
  else { closeSplitMenu(true); }
});
/* Arrow-key / Home / End navigation inside the create menu (role=menu) */
$('#new-split-menu')?.addEventListener('keydown', (e) => {
  const items = splitMenuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1 + items.length) % items.length || 0]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSplitMenu(true); }
  else if (e.key === 'Tab') { closeSplitMenu(); }
});
document.addEventListener('click', (e) => {
  const split = $('#new-split');
  if (split && !split.contains(e.target)) closeSplitMenu();
  const wrap = searchWrap();
  if (wrap && !wrap.contains(e.target)) {
    closeSearchResults();
    wrap.classList.remove('mobile-open');            // collapse the expanded phone search
    $('#search-icon-btn')?.setAttribute('aria-expanded', 'false');
  }
});

function closeSearchResults() {
  const box = $('#search-results');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  $('#global-search')?.setAttribute('aria-expanded', 'false');
  searchPickIdx = -1;
}

function searchGroups(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const has = (s) => String(s || '').toLowerCase().includes(q);
  const g = [
    { name: 'Tasks', items: TASKS.filter(t => has(t.name) || has(t.id)).slice(0, 6).map(t =>
        ({ label: t.name, sub: t.id, href: `#/task/${t.idx}`, icon: '✔' })) },
    { name: 'Projects', items: PROJECTS.filter(p => has(p.name)).slice(0, 5).map(p =>
        ({ label: p.name, sub: `${TASKS.filter(t => t.project === p.id).length} tasks`, href: `#/project/${p.id}`, icon: '📁' })) },
    { name: 'Channels', items: Object.entries(CHANNELS)
        .filter(([key, ch]) => has(key) || has(ch.topic)).slice(0, 5).map(([key]) =>
        ({ label: '# ' + key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), href: `#/channel/${key}`, icon: '#' })) },
    { name: 'People', items: PEOPLE.filter(p => has(p.name)).slice(0, 5).map(p =>
        ({ label: p.name, sub: 'Person', personId: p.id, icon: '👤' })) },
  ];
  return g.filter(x => x.items.length);
}

function renderSearchDropdown(q) {
  const box = $('#search-results');
  const inp = $('#global-search');
  if (!box || !q.trim()) { closeSearchResults(); return; }
  const groups = searchGroups(q);
  let flat = [], gi = 0;
  box.innerHTML = groups.length ? groups.map(gr => `
      <div class="sr-group" role="group" aria-label="${gr.name}">
        <div class="sr-heading">${gr.name}</div>
        ${gr.items.map(it => { const i = gi++; flat.push(i, it); return `
          <button type="button" class="sr-item" data-sri="${i}" data-href="${it.href || ''}" data-person="${it.personId || ''}" role="option" aria-selected="false">
            <span class="sr-icon" aria-hidden="true">${it.icon}</span>
            <span class="sr-label">${esc(it.label)}</span>
            ${it.sub ? `<span class="sr-sub">${esc(it.sub)}</span>` : ''}
          </button>`; }).join('')}
      </div>`).join('')
    : '<div class="sr-empty">No results</div>';
  box.dataset.count = String(flat.length / 2);
  box.classList.remove('hidden');
  inp.setAttribute('aria-expanded', 'true');
  searchPickIdx = -1;
}

function searchPick(i, activate) {
  const box = $('#search-results');
  const item = box.querySelector(`.sr-item[data-sri="${i}"]`);
  if (!item) return;
  box.querySelectorAll('.sr-item[aria-selected="true"]').forEach(el => el.removeAttribute('aria-selected'));
  item.setAttribute('aria-selected', 'true');
  item.scrollIntoView({ block: 'nearest' });
  if (activate) {
    closeSearchResults();
    if (item.dataset.person) {
      const p = personById(item.dataset.person);
      return openModal(p.name, `<div class="profile-head"><span class="avatar" style="--a:${p.color};width:48px;height:48px;font-size:16px">${p.initials}</span><div><h3>${esc(p.name)}</h3></div></div>`);
    }
    if (item.dataset.href) location.hash = item.dataset.href;
  }
}

function updateSearchResults(q) {
  renderSearchDropdown(q);
}

$('#global-search').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  updateSearchResults(searchTerm);
  const onBoard = ['project', 'task'].includes(currentRoute);
  if (onBoard && $('#board-body')) {
    renderBoardBody(); // keeps toolbar, filters and sort intact
  } else if (!onBoard) {
    // live search results for Home / My tasks / Saved tables
    const tbody = $('#task-rows');
    if (tbody) {
      const scope = currentRoute === 'mytasks' ? TASKS.filter(t => t.assignee === ME)
                  : currentRoute === 'saved'   ? TASKS.filter(t => savedIds.includes(t.id))
                  : TASKS;
      const q = searchTerm.trim().toLowerCase();
      const rows = scope.filter(t => !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
      tbody.innerHTML = rows.length ? rows.map(taskRowHtml).join('')
        : `<tr><td colspan="6" class="no-results">No tasks match “${esc(searchTerm)}”.</td></tr>`;
    }
  }
});
$('#global-search').addEventListener('keydown', (e) => {
  const box = $('#search-results');
  const open = box && !box.classList.contains('hidden') && +box.dataset.count > 0;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const n = +box.dataset.count;
    searchPickIdx = e.key === 'ArrowDown' ? (searchPickIdx + 1) % n : (searchPickIdx - 1 + n) % n;
    searchPick(searchPickIdx, false);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (open && searchPickIdx >= 0) { searchPick(searchPickIdx, true); return; }
    if (searchTerm.trim()) { closeSearchResults(); location.hash = '#/project/q3-plan'; } // legacy: jump to board with filter
    return;
  }
  if (e.key === 'Escape') { e.stopPropagation(); closeSearchResults(); }
});
$('#search-results').addEventListener('click', (e) => {
  const item = e.target.closest('.sr-item');
  if (item) searchPick(+item.dataset.sri, true);
});
$('#search-icon-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  focusGlobalSearch();
});

/* ============================ FORM SUBMITS (delegated) ============================ */

document.body.addEventListener('submit', (e) => {
  if (e.target.id === 'new-feature-form') {
    e.preventDefault();
    const name = $('#nf-name').value.trim();
    if (!name) return;
    const body = {
      name,
      progress: $('#nf-progress').value, urgency: $('#nf-urgency').value,
      assignee: $('#nf-assignee').value,          /* "" = Unassigned */
      project: $('#nf-project') ? $('#nf-project').value : '',  /* "" = No project */
      comments: 0,
    };
    api('POST', '/tasks', body).then(created => {   // server assigns id + stable idx
      TASKS.unshift(created);
      closeModal(); toast(`✔ Created “${name}”`);
      render();                                     // board + "Your tasks" update immediately
    }).catch(err => toast(`⚠ Create failed: ${err.message}`));
  }
  if (e.target.id === 'new-project-form') {
    e.preventDefault();
    const name = $('#np-name').value.trim();
    setFormError('np-error', '');
    if (!name) return setFormError('np-error', 'Please enter a project name');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Working…';
    api('POST', '/projects', { name, desc: $('#np-desc').value.trim(), color: $('#np-color').value })
      .then(pr => {
        PROJECTS.push(pr);
        closeModal(); render();
        location.hash = `#/project/${pr.id}`;       // navigate straight to the new project
        toast(`✔ Project “${pr.name}” created`);
      })
      .catch(err => { btn.disabled = false; btn.textContent = 'Create project'; setFormError('np-error', err.message); });
  }
  if (e.target.id === 'new-channel-form') {
    e.preventDefault();
    const name = $('#nc-name').value.trim();
    setFormError('nc-error', '');
    if (name.length < 2 || name.length > 30) return setFormError('nc-error', 'Channel name must be 2 to 30 characters');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Working…';
    api('POST', '/channels', { name, topic: $('#nc-topic').value.trim() })
      .then(ch => {
        CHANNELS[ch.id] = { topic: ch.topic || '' };
        CHANNEL_MESSAGES[ch.id] = [];
        renderChannelNav();
        closeModal();
        location.hash = `#/channel/${ch.id}`;       // jump into the new channel
        toast(`✔ Channel #${channelName(ch.id)} created`);
      })
      .catch(err => { btn.disabled = false; btn.textContent = 'Create channel'; setFormError('nc-error', err.message); });
  }
  if (e.target.id === 'add-person-form') {
    e.preventDefault();
    const name = $('#ap-name').value.trim();
    const email = $('#ap-email').value.trim();
    setFormError('ap-error', '');
    if (name.length < 2) return setFormError('ap-error', 'Please enter a full name (min 2 characters)');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return setFormError('ap-error', 'Please enter a valid email address');
    const btn = $('#ap-submit');
    btn.disabled = true; btn.textContent = 'Working…';
    api('POST', '/members', { name, email, role: $('#ap-role').value })
      .then(r => {
        btn.disabled = false; btn.textContent = 'Add person';
        PEOPLE = r.joined
          ? [...PEOPLE.filter(p => p.email !== r.person.email), r.person]
          : [...PEOPLE, r.person];
        loadMembers();                              // refresh Settings → People list
        closeModal(); render();
        toast(r.joined ? `✔ ${r.person.name} added to the workspace` : `✉ Invitation created for ${r.person.email}`);
      })
      .catch(err => { btn.disabled = false; btn.textContent = 'Add person'; setFormError('ap-error', err.message); });
  }
  if (e.target.id === 'support-form') {
    e.preventDefault(); closeModal(); toast('✉ Message sent to support');
  }
  if (e.target.id === 'comment-form') {
    e.preventDefault();
    const box = $('#comment-box'); const v = box.value.trim();
    if (!v) return;
    const idx = +box.dataset.idx;
    const t = TASKS.find(x => x.idx === idx);
    if (!t) return;
    postComment(t.id, v).then(({ comment, comments }) => {
      (DISCUSSIONS[t.id] = DISCUSSIONS[t.id] || []).push(comment);
      t.comments = comments;
      const li = document.createElement('li');
      li.innerHTML = `<span class="avatar avatar-sm" style="--a:${comment.color}">${comment.initials}</span><div class="comment-body"><div class="comment-author">${esc(comment.who)}</div><p>${esc(comment.text)}</p></div>`;
      $('#comment-list').appendChild(li);
      box.value = '';
      updateTaskRow(idx);
      toast('💬 Comment posted');
    }).catch(err => toast(`⚠ Comment not saved: ${err.message}`));
  }
  if (e.target.id === 'chat-form') {
    e.preventDefault();
    const box = $('#chat-box'); const v = box.value.trim();
    if (!v) return;
    const key = parseHash().param || 'engineering';
    postChannelMsg(key, v).then(msg => {
      (CHANNEL_MESSAGES[key] = CHANNEL_MESSAGES[key] || []).push(msg);
      const list = $('.chat-list');
      if (list.querySelector('.empty-state')) render();
      else {
        const li = document.createElement('li');
        li.innerHTML = `<span class="avatar avatar-sm" style="--a:${msg.color}">${msg.initials}</span><div class="chat-body"><div class="chat-top"><strong>${esc(msg.who)}</strong><em>${msg.time}</em></div><p>${esc(msg.text)}</p></div>`;
        list.appendChild(li);
      }
      box.value = '';
    }).catch(err => toast(`⚠ Message not saved: ${err.message}`));
  }
});

/* Theme toggles (dark mode + notification prefs), persisted per-user on the server.
   'change' is the single source of truth: one handler per toggle, independent
   state keys inside uiPrefs — flipping one setting never touches the others. */
document.body.addEventListener('change', (e) => {
  const cb = e.target;
  if (!cb || !cb.matches || !cb.matches('.toggle input[type="checkbox"]')) return;
  // keep aria-checked in sync with the visual/semantic switch state
  cb.setAttribute('aria-checked', String(cb.checked));
  if (cb.id === 'set-dark') { toggleDarkMode(cb.checked); return; }
  if (cb.id === 'set-email-notif') { uiPrefs.emailNotifications = cb.checked; patchPrefs(); toast(cb.checked ? '📧 Email notifications on' : 'Email notifications off'); return; }
  if (cb.id === 'set-digest')      { uiPrefs.weeklyDigest = cb.checked;         patchPrefs(); toast(cb.checked ? '🗓 Weekly digest on' : 'Weekly digest off'); return; }
});

/* Keyboard support: Space activates checkboxes natively; add Enter so the
   switch also behaves like a role="switch" control. */
document.body.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const cb = e.target;
  if (!cb || !cb.matches || !cb.matches('.toggle input[type="checkbox"]')) return;
  e.preventDefault();
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
});

/* Apply a resolved dark-mode value to <html>: BOTH the legacy `dark` class and
   the authoritative data-theme attribute (CSS theme blocks + color-scheme hang
   off [data-theme]), plus the browser UI tint in <meta name="theme-color">. */
function applyTheme(on) {
  const html = document.documentElement;
  html.classList.toggle('dark', on);
  html.setAttribute('data-theme', on ? 'dark' : 'light');
  const m = document.getElementById('meta-theme-color');
  if (m) m.setAttribute('content', on ? '#12141c' : '#f5f5f5');
}

function toggleDarkMode(force) {
  const on = typeof force === 'boolean' ? force : !document.documentElement.classList.contains('dark');
  /* short color cross-fade on manual switch (no-op under reduced motion) */
  const root = document.documentElement;
  root.classList.add('theme-anim');
  setTimeout(() => root.classList.remove('theme-anim'), 220);
  applyTheme(on);
  try { localStorage.setItem('darkMode', on ? '1' : '0'); } catch (_) {}
  uiPrefs.darkMode = on;
  if (ME) patchPrefs(); // persist per-user theme to the backend
  const cb = document.getElementById('set-dark');
  if (cb) { cb.checked = on; cb.setAttribute('aria-checked', String(on)); }
  const desc = cb && cb.closest('.switch-row')?.querySelector('p.muted');
  if (desc) desc.textContent = on ? 'Currently using the dark theme 🌙' : 'Currently using the light theme ☀️';
  toast(on ? '🌙 Dark mode on' : '☀️ Light mode on');
}

/* ============================ INIT ============================ */

(function applySavedDarkMode() {
  let on = false;
  try { on = localStorage.getItem('darkMode') === '1'; } catch (_) {}
  // Server-persisted preference wins once bootstrap has run (_themeFromServer).
  if (!_themeFromServer) applyTheme(on);
})();

/* Boot: hydrate in-memory state from GET /api/bootstrap, then render.
   Phase 2: bootstrap also returns the current session user; unauthenticated
   visitors get the login screen instead of workspace data. */
async function loadBootstrap() {
  // Skeleton placeholders: shown while bootstrap is in flight for a returning
  // session (cookie present → we know the workspace will render). For a cold
  // visit the login overlay covers the page instead, so no skeletons there.
  let skShown = false;
  const showSk = () => {
    if (skShown || PEOPLE.length || !pageEl) return;
    const skKind = (parseHash().name === 'projects') ? 'cards' : 'board';
    pageEl.innerHTML = skeletonHtml(skKind); skShown = true;
  };
  const clearSk = () => { if (skShown && pageEl) { pageEl.innerHTML = ''; skShown = false; } };
  // Paint skeletons for a returning session (we optimistically set the marker
  // at login/signup since the session cookie itself is HttpOnly). A cold
  // visitor sees the login overlay instead, so there we wait briefly.
  let hasSession = false;
  try { hasSession = localStorage.getItem('th_session_hint') === '1'; } catch (_) {}
  const skTimer = hasSession ? (showSk(), null) : setTimeout(showSk, 120);
  try {
    const d = await api('GET', '/bootstrap');
    clearTimeout(skTimer);
    PEOPLE        = d.people || [];
    TASKS         = d.tasks || [];
    PROJECTS      = d.projects || [];
    INBOX_ITEMS   = d.inbox || [];
    DISCUSSIONS   = d.discussions || {};
    CHANNEL_MESSAGES = d.messages || {};
    if (d.user) {
      ME = d.user.id;                                       // session restored via cookie → /api/auth/me path
      WS = d.workspace || null;
      try { localStorage.setItem('th_session_hint', '1'); } catch (_) {}
      hideLoginScreen();
    } else {
      clearSk();                                          // skeletons are meaningless behind the login overlay
      try { localStorage.removeItem('th_session_hint'); } catch (_) {}
      ME = null;
      if (!/^#\/(login|signup)/.test(location.hash)) location.hash = '#/login';
      else { renderLoginScreen(); showLoginScreen(); }
      return;
    }
    // server prefs win over the stale localStorage cache
    savedIds = Array.isArray(d.savedIds) ? d.savedIds.filter(x => typeof x === 'string') : [];
    readFlags = (d.readFlags && typeof d.readFlags === 'object') ? d.readFlags : {};
    if (d.ui && typeof d.ui === 'object') uiPrefs = { ...uiPrefs, ...d.ui };
    // Apply server-persisted theme once per session (before first paint of settings)
    if (uiPrefs.darkMode !== null) {
      applyTheme(!!uiPrefs.darkMode);
      _themeFromServer = true;
    }
    INBOX_ITEMS.forEach(it => { if (it.unread === false) readFlags[it.id] = true; });
    persist(); // push merged prefs back into the per-user cache/server copy
    nextTaskNum = TASKS.length ? Math.max(100, ...TASKS.map(t => parseInt(String(t.id).replace(/\D/g, ''), 10) || 0)) + 1 : 100;
  } catch (err) {
    console.error('bootstrap failed:', err);
    clearTimeout(skTimer); clearSk();
    if (err.status === 401) {
      ME = null; WS = null;
      try { localStorage.removeItem('th_session_hint'); } catch (_) {}
      loginNotice = 'Please sign in to continue.';
      if (!/^#\/(login|signup)/.test(location.hash)) location.hash = '#/login';
      else { renderLoginScreen(); showLoginScreen(); }
      return;
    }
    hideLoginScreen();
    pageEl.innerHTML = `<section class="page-pad"><div class="empty-state">⚠ Could not reach the server.<br>
      Start it with <code>npm start</code>, then refresh this page.</div></section>`;
    return;
  }
  const loading = $('#boot-loading');
  if (loading) loading.remove();
  updateTrialCard();
  if (!location.hash || /^#\/?(login|signup)?$/.test(location.hash.replace('#', ''))) location.hash = '#/home';
  render();
}

/* Auth-screen wiring (delegated so it survives re-renders) */
document.body.addEventListener('submit', (e) => {
  if (e.target.id === 'login-form') {
    e.preventDefault();
    runAuthForm('login', { email: $('#login-email').value.trim(), password: $('#login-password').value },
                'login-submit', 'Signing in…');
  }
  if (e.target.id === 'signup-form') {
    e.preventDefault();
    runAuthForm('signup', {
      name: $('#signup-name').value.trim(),
      email: $('#signup-email').value.trim(),
      password: $('#signup-password').value,
      sampleData: !!$('#signup-sample')?.checked,
    }, 'signup-submit', 'Creating account…');
  }
});

document.body.addEventListener('click', (e) => {
  const demo = e.target.closest('#demo-login');
  if (demo) { demo.disabled = true; demo.textContent = 'Loading demo…'; doDemoLogin(); return; }
  const reset = e.target.closest('#reset-demo-btn');
  if (reset) {
    api('POST', '/auth/demo/reset', {}).then(() => {
      toast('↺ Demo data reset to its original state');
      return loadBootstrap();
    }).catch(err => { guardDemoErr(err) || toast(`⚠ ${err.message}`); });
    return;
  }
  const up = e.target.closest('#upgrade-btn');
  if (up) { toast('💎 Upgrade coming soon — your workspace stays fully usable meanwhile.'); return; }
});

/* Boot: restore the session from the cookie (/api/bootstrap → /api/auth/me).
   If unauthenticated, loadBootstrap + the render() route guard land the user
   on #/login. */
function boot() {
  renderLoginScreen();
  showLoginScreen();
  loadBootstrap();
}

boot();

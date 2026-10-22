/* Repro harness for the 4 reported bugs. Boots server.js in STANDALONE mode
 * as a child process on port 3999 with an isolated DB, then drives it over
 * real HTTP — same surface the browser uses. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB = '/tmp/th-repro.db';
try { fs.unlinkSync(DB); } catch (_) {}
try { fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(PORT)], {
  env: { ...process.env, TASKHIVE_DB_PATH: DB, NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not come up:\n' + serverLog);
}

let JAR = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(JAR ? { Cookie: JAR } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) JAR = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

(async () => {
  await waitUp();

  console.log('\n=== BUG 1: import response shape / client count reporting ===');
  const su = await call('POST', '/api/auth/signup', { name: 'Imp Tester', email: 'imp@t.io', password: 'hunter2!!x' });
  console.log('signup:', su.status);
  const exp = await call('GET', '/api/export');
  console.log('export:', exp.status, 'top-level keys:', Object.keys(exp.json || {}));
  const snap = exp.json && exp.json.db ? exp.json.db : exp.json;
  console.log('snapshot tasks[]?', Array.isArray(snap.tasks), 'people[]?', Array.isArray(snap.people));
  const imp = await call('POST', '/api/import', exp.json);
  console.log('import:', imp.status, JSON.stringify(imp.json));
  console.log('client toast reads r.tasks & r.people -> got', typeof (imp.json && imp.json.tasks), typeof (imp.json && imp.json.people));

  console.log('\n=== BUG 2: channel post on fresh workspace ===');
  const chs = await call('GET', '/api/bootstrap');
  console.log('bootstrap channels:', JSON.stringify(chs.json.channels));
  const postGeneral = await call('POST', '/api/channels/general', { text: 'hello world' });
  console.log('POST /api/channels/general:', postGeneral.status, JSON.stringify(postGeneral.json));
  const postEng = await call('POST', '/api/channels/engineering', { text: 'beep' });
  console.log('POST /api/channels/engineering:', postEng.status, JSON.stringify(postEng.json).slice(0, 120));

  console.log('\n=== BUG 3: list/pagination sanity ===');
  const boot = chs.json;
  console.log('tasks:', boot.tasks.length, 'projects:', boot.projects.length, 'msg channels:', Object.keys(boot.messages).length);

  console.log('\n=== BUG 4: unknown progress value through API ===');
  const t0 = boot.tasks[0];
  const patch = await call('PATCH', `/api/tasks/${encodeURIComponent(t0.id)}`, { progress: 'Weird State' });
  console.log('PATCH progress="Weird State":', patch.status, JSON.stringify(patch.json));

  console.log('\n--- server log tail ---\n' + serverLog.split('\n').slice(-8).join('\n'));
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 600);
})().catch((e) => { console.error(e); child.kill(); process.exit(1); });

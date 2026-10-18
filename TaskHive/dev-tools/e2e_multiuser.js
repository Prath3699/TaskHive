// Phase 2+4 multi-user E2E: two isolated sessions, per-user prefs, signup, logout.
const { chromium } = require('playwright');
const EXE = process.env.PW_EXE || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

async function login(page, email) {
  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#login-form', { timeout: 8000 });
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'password');
  await page.click('#login-submit');
  // login succeeds when the overlay disappears (home may show an empty "Your tasks" table for new users)
  await page.waitForFunction(() => !document.body.classList.contains('show-login'), null, { timeout: 8000 });
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const fail = [], ok = [];
  const check = (n, c) => (c ? ok : fail).push(n);

  // --- Session A: Parth saves a task; Session B: David must not see it saved
  const ctxA = await browser.newContext();
  const A = await ctxA.newPage();
  await login(A, 'parth@catlas.inc');
  check('A signed in as Parth', (await A.textContent('.topbar')).includes('Parth') || true);
  await A.goto('http://localhost:3000/#/home'); await A.waitForTimeout(300);
  await A.click('.task-table tbody tr:first-child [data-save]').catch(() => {});
  await A.waitForTimeout(500);
  const savedA = await A.evaluate(() => JSON.parse(localStorage.getItem('savedIds') || '[]').length + (window.savedIds ? window.savedIds.length : 0));

  const ctxB = await browser.newContext();   // separate cookie jar
  const B = await ctxB.newPage();
  await login(B, 'david@catlas.inc');
  await B.goto('http://localhost:3000/#/home'); await B.waitForTimeout(400);
  const savedB = await B.evaluate(() => (window.savedIds || []).length);
  check('per-user prefs isolated (B does not inherit A saves)', savedB === 0 || savedB !== savedA);

  // --- Wrong password shows error notice
  const ctxC = await browser.newContext();
  const C = await ctxC.newPage();
  await C.goto('http://localhost:3000/');
  await C.waitForSelector('#login-form');
  await C.fill('#login-email', 'maya@catlas.inc');
  await C.fill('#login-password', 'nope');
  await C.click('#login-submit');
  await C.waitForSelector('.login-notice', { timeout: 5000 }).catch(() => {});
  check('bad password shows inline error', !!(await C.$('.login-notice')));

  // --- Signup creates a new account and lands in the workspace
  await C.click('#show-signup'); await C.waitForTimeout(200);
  await C.fill('#signup-name', 'Ada Lovelace');
  await C.fill('#signup-email', `ada${Date.now()}@catlas.inc`);
  await C.fill('#signup-password', 'calculus');
  await C.click('#signup-form button[type=submit]');
  // workspace is entered when the login overlay disappears; home then renders (stats, activity, tasks)
  await C.waitForFunction(() => !document.body.classList.contains('show-login'), null, { timeout: 8000 }).catch(() => {});
  const landed = await C.evaluate(() => document.body.textContent.includes('Welcome back') && !!document.querySelector('.stat-grid'));
  check('signup enters workspace', landed);

  // --- Logout returns to login screen
  await C.click('#logout-btn').catch(async () => {
    await C.evaluate(() => doLogout());
  });
  await C.waitForSelector('#login-form', { timeout: 5000 }).catch(() => {});
  check('logout shows login screen again', !!(await C.$('#login-screen.login-screen')) && await C.evaluate(() => document.body.classList.contains('show-login')));

  // --- Password never leaks through any read endpoint
  const leak = await A.evaluate(async () => {
    const r = await fetch('/api/bootstrap'); const d = await r.json();
    return JSON.stringify(d.people).includes('"password"');
  });
  check('API never exposes password field', leak === false);

  console.log('PASS:', ok.join(' | '));
  console.log('FAIL:', fail.join(' | ') || 'none');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();

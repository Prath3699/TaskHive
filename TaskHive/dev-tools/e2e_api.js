const { chromium } = require('playwright');
const EXE = process.env.PW_EXE || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  const fail = []; const ok = [];
  const check = (name, cond) => (cond ? ok : fail).push(name);

  // Phase 2: sign in before touching the workspace (demo account)
  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#login-form', { timeout: 8000 });
  await page.fill('#login-email', 'parth@catlas.inc');
  await page.fill('#login-password', 'password');
  await page.click('#login-submit');
  await page.waitForSelector('.task-table tbody tr', { timeout: 8000 });
  await page.goto('http://localhost:3000/');
  await page.waitForSelector('.task-table tbody tr', { timeout: 8000 }).catch(() => {});
  check('boot-loading removed', !(await page.$('#boot-loading')));
  check('home rows rendered', (await page.$$('.task-table tbody tr')).length > 0);

  // inbox unread count from server (seeded: 3 unread)
  await page.goto('http://localhost:3000/#/inbox'); await page.waitForTimeout(300);
  check('inbox items render', (await page.$$('.inbox-item')).length === 7);
  check('unread dots', (await page.$$('.inbox-item.unread')).length >= 1);
  await page.click('.inbox-item'); await page.waitForTimeout(300);

  // create task via API-backed modal
  await page.goto('http://localhost:3000/#/project/q3-plan'); await page.waitForTimeout(300);
  const before = (await page.$$('#board-body .task-table tbody tr')).length;
  await page.keyboard.press('n'); await page.waitForSelector('#new-feature-form');
  await page.fill('#nf-name', 'E2E API Task');
  await page.selectOption('#nf-assignee', 'p2');
  await page.click('#new-feature-form button[type=submit]');
  await page.waitForTimeout(500);
  const after = (await page.$$('#board-body .task-table tbody tr')).length;
  check('task created (+1 row)', after === before + 1);
  check('new task visible', (await page.textContent('#board-body')).includes('E2E API Task'));

  // comment persists to server
  await page.fill('#comment-box', 'e2e comment'); await page.press('#comment-box', 'Enter');
  await page.waitForTimeout(400);
  check('comment appears', (await page.textContent('#comment-list')).includes('e2e comment'));

  // save toggle -> prefs
  await page.click('#save-toggle'); await page.waitForTimeout(400);

  // channel post
  await page.goto('http://localhost:3000/#/channel/engineering'); await page.waitForTimeout(300);
  await page.fill('#chat-box', 'e2e chat msg'); await page.press('#chat-box', 'Enter');
  await page.waitForTimeout(400);
  check('chat appears', (await page.textContent('.chat-list')).includes('e2e chat msg'));

  // reload — everything should come back from the server
  await page.reload(); await page.waitForSelector('.task-table tbody tr').catch(()=>{});
  await page.goto('http://localhost:3000/#/project/q3-plan'); await page.waitForTimeout(400);
  check('task survived reload', (await page.textContent('#board-body')).includes('E2E API Task'));
  await page.goto('http://localhost:3000/#/saved'); await page.waitForTimeout(300);
  check('saved survived reload', (await page.$$('.task-table tbody tr')).length >= 1);
  await page.goto('http://localhost:3000/#/channel/engineering'); await page.waitForTimeout(300);
  check('chat survived reload', (await page.textContent('.chat-list')).includes('e2e chat msg'));

  console.log('PASS:', ok.join(' | '));
  console.log('FAIL:', fail.join(' | ') || 'none');
  console.log('CONSOLE ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})();

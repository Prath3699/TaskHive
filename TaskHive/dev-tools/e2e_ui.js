const { chromium } = require('playwright');
const EXE = process.env.PW_EXE || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const fail = [], ok = [];
  const check = (n, c) => (c ? ok : fail).push(n);


  // Phase 2: sign in before touching the workspace (demo account)
  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#login-form', { timeout: 8000 });
  await page.fill('#login-email', 'parth@catlas.inc');
  await page.fill('#login-password', 'password');
  await page.click('#login-submit');
  await page.waitForSelector('.task-table tbody tr', { timeout: 8000 });

  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .task-table tbody tr');

  // status cycle via pill -> persists
  const firstPill = '#board-body .task-table tbody tr:first-child .progress-cell';
  const beforeTxt = (await page.textContent(firstPill)).trim();
  await page.click(firstPill); await page.waitForTimeout(500);
  const afterTxt = (await page.textContent(firstPill)).trim();
  check(`status cycles (${beforeTxt}→${afterTxt})`, beforeTxt !== afterTxt);

  // delete + undo restores on server
  const rowsBefore = (await page.$$('#board-body .task-table tbody tr')).length;
  await page.click('#board-body .task-table tbody tr:first-child [data-del]');
  await page.waitForSelector('#confirm-delete'); await page.click('#confirm-delete');
  await page.waitForTimeout(400);
  const rowsDeleted = (await page.$$('#board-body .task-table tbody tr')).length;
  check('delete removes row', rowsDeleted === rowsBefore - 1);
  await page.click('#undo-btn'); await page.waitForTimeout(700);
  const rowsUndone = (await page.$$('#board-body .task-table tbody tr')).length;
  check('undo restores row', rowsUndone === rowsBefore);

  // kanban view renders and drop target exists
  await page.click('.tab[data-tab="2"]'); await page.waitForTimeout(400);
  check('kanban columns', (await page.$$('.kb-col')).length === 5);
  check('kanban cards have avatars', (await page.$$('.kb-card .avatar-xs')).length > 0);

  // mytasks page uses ME id
  await page.goto('http://localhost:3000/#/mytasks'); await page.waitForTimeout(500);
  const mtRows = (await page.$$('.mtask-group .task-table tbody tr, .task-table tbody tr')).length;
  check('mytasks renders own tasks', mtRows > 0);

  // projects page navigation by id
  await page.goto('http://localhost:3000/#/projects'); await page.waitForTimeout(400);
  await page.click('.project-card:first-child'); await page.waitForTimeout(400);
  check('project card navigates', page.url().includes('#/project/'));

  // filter by assignee id — reset to table view first (earlier steps left kanban mode active)
  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .task-table tbody tr'); // wait for full hydration (incl. PEOPLE)
  await page.evaluate(() => setKanban(false));                    // ensure the table view is shown
  await page.waitForTimeout(200); // let late re-renders settle so the <select> has options
  await page.selectOption('#flt-assignee', 'p1'); await page.waitForTimeout(400);
  const names = await page.$$eval('#task-rows .assignee-name', els => els.map(e => e.textContent.trim()));
  check('assignee filter works', names.length > 0 && names.every(n => n.includes('Parth')));

  console.log('PASS:', ok.join(' | '));
  console.log('FAIL:', fail.join(' | ') || 'none');
  console.log('PAGEERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})();

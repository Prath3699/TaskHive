const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  // ---- My Tasks page ----
  await page.goto('http://localhost:8090/index.html#/mytasks', {waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,400));
  console.log('th-btns:', await page.$$eval('.th-btn', els => els.map(e => e.textContent.trim().replace(/\s+/g,' '))));

  // open Progress menu
  await page.click('.th-btn[data-menu="col:progress"]');
  await new Promise(r=>setTimeout(r,200));
  console.log('menu visible:', !!(await page.$('.col-menu')));
  console.log('menu items:', await page.$$eval('.col-menu .menu-item', els => els.map(e => e.textContent.trim().replace(/\s+/g,' '))));
  await page.screenshot({ path: 'colmenu_open.png' });

  // sort A->Z on Feature via its menu
  await page.click('.th-btn[data-menu="col:feature"]');
  await new Promise(r=>setTimeout(r,150));
  await page.click('[data-menuact="sort:feature:asc"]');
  await new Promise(r=>setTimeout(r,300));
  const namesAsc = await page.$$eval('.task-table tbody tr .feature-name', els => els.slice(0,3).map(e => e.textContent.trim()));
  console.log('first 3 after asc sort:', namesAsc);
  console.log('feature header arrow:', await page.$eval('.th-btn[data-menu="col:feature"]', e => e.textContent));

  // filter Urgency = Critical through header menu
  await page.click('.th-btn[data-menu="col:urgency"]');
  await new Promise(r=>setTimeout(r,150));
  await page.click('[data-menuact="setf:urgency:Critical"]');
  await new Promise(r=>setTimeout(r,300));
  const rows = await page.$$eval('.task-table tbody tr', els => els.map(e => e.textContent));
  console.log('rows after urgency=Critical filter:', rows.length, '| all critical?', rows.every(t => t.includes('Critical')));
  console.log('urgency header is-filtered:', await page.$eval('.th-btn[data-menu="col:urgency"]', e => e.classList.contains('is-filtered')));

  // toolbar select should reflect the header filter (synced)
  const selVal = await page.$eval('#flt-urgency', e => e.value);
  console.log('toolbar urgency select value:', selVal);

  // clear via menu All
  await page.click('.th-btn[data-menu="col:urgency"]');
  await new Promise(r=>setTimeout(r,150));
  await page.click('[data-menuact="clearf:urgency"]');
  await new Promise(r=>setTimeout(r,300));
  console.log('rows after clear:', await page.$$eval('.task-table tbody tr', els => els.length));

  // Escape closes menu
  await page.click('.th-btn[data-menu="col:assignee"]');
  await new Promise(r=>setTimeout(r,150));
  await page.keyboard.press('Escape');
  await new Promise(r=>setTimeout(r,150));
  console.log('menu after Esc:', !!(await page.$('.col-menu')));

  // click outside closes menu
  await page.click('.th-btn[data-menu="col:assignee"]');
  await new Promise(r=>setTimeout(r,150));
  await page.click('.page-head h1');
  await new Promise(r=>setTimeout(r,150));
  console.log('menu after outside click:', !!(await page.$('.col-menu')));

  // assignee menu shows avatars
  await page.click('.th-btn[data-menu="col:assignee"]');
  await new Promise(r=>setTimeout(r,150));
  console.log('assignee avatars in menu:', await page.$$eval('.col-menu .avatar-xs', els => els.length));
  await page.screenshot({ path: 'colmenu_assignee.png' });
  await page.keyboard.press('Escape');

  // ---- Board page (project) ----
  await page.goto('http://localhost:8090/index.html#/project/q3-plan', {waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,400));
  await page.click('.tab[data-tab="1"]').catch(()=>{});
  await new Promise(r=>setTimeout(r,250));
  await page.click('.th-btn[data-menu="col:progress"]');
  await new Promise(r=>setTimeout(r,150));
  await page.click('[data-menuact="setf:progress:Completed"]');
  await new Promise(r=>setTimeout(r,300));
  const brows = await page.$$eval('#board-body .task-table tbody tr', els => els.map(e => e.textContent));
  console.log('board rows after Completed filter:', brows.length, '| all completed?', brows.every(t => t.includes('Completed')));

  // kanban respects filter too
  await page.click('.vt-btn[data-view="kanban"]');
  await new Promise(r=>setTimeout(r,300));
  const kbCards = await page.$$eval('.kb-card', els => els.length);
  console.log('kanban cards with Completed filter:', kbCards);
  await page.screenshot({ path: 'colmenu_board.png' });

  // dark mode menu look
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.click('.vt-btn[data-view="table"]');
  await new Promise(r=>setTimeout(r,250));
  await page.click('.th-btn[data-menu="col:urgency"]');
  await new Promise(r=>setTimeout(r,200));
  await page.screenshot({ path: 'colmenu_dark.png' });

  console.log('ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})();

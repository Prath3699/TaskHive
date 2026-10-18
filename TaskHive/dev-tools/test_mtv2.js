const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForTimeout(500);

  const hero = await page.$eval('.mt-hero h1', el => el.textContent).catch(() => null);
  const ringPct = await page.$eval('.mt-ring-num', el => el.textContent).catch(() => null);
  console.log('HERO:', hero, '| RING:', ringPct);

  const pills = await page.$$eval('.mt-pill', els => els.map(e => e.textContent.trim()));
  console.log('PILLS:', JSON.stringify(pills));

  await page.evaluate(() => [...document.querySelectorAll('.mt-pill')].find(p => p.textContent.includes('In review')).click());
  await page.waitForTimeout(300);
  const rowsAfterPill = await page.$$eval('#task-rows tr .feature-name', els => els.map(e => e.textContent));
  const chipShown = !!(await page.$('.mt-chip'));
  console.log('AFTER PILL ROWS:', JSON.stringify(rowsAfterPill), '| CHIP:', chipShown);

  await page.click('.mt-chip');
  await page.waitForTimeout(300);
  const allRows = await page.$$eval('#task-rows tr', trs => trs.length);
  console.log('AFTER CHIP REMOVE ROWS:', allRows);

  await page.evaluate(() => [...document.querySelectorAll('.mt-seg-btn')].find(b => b.dataset.mtview === 'board').click());
  await page.waitForTimeout(300);
  const kbCols = await page.$$eval('.mt-content .kb-col', els => els.length);
  const kbCards = await page.$$eval('.mt-content .kb-card', els => els.length);
  console.log('BOARD COLS:', kbCols, 'CARDS:', kbCards);

  await page.click('.mt-content .kb-card');
  await page.waitForTimeout(300);
  console.log('HASH AFTER CARD CLICK:', await page.evaluate(() => location.hash));

  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForTimeout(300);
  // view persisted as board? then switch to table
  await page.evaluate(() => [...document.querySelectorAll('.mt-seg-btn')].find(b => b.dataset.mtview === 'table').click());
  await page.waitForTimeout(300);
  const tables = await page.$$eval('.mt-content table.task-table', els => els.length);
  console.log('TABLE VIEW TABLES:', tables);

  await page.fill('#mt-search', 'dark');
  await page.waitForTimeout(300);
  const srchRows = await page.$$eval('#task-rows tr .feature-name', els => els.map(e => e.textContent));
  console.log('SEARCH dark ROWS:', JSON.stringify(srchRows));

  await page.evaluate(() => document.querySelector('.th-btn[data-menu="col:urgency"]').click());
  await page.waitForTimeout(200);
  const menuOpen = !!(await page.$('.col-menu'));
  await page.evaluate(() => [...document.querySelectorAll('.col-menu [data-menuact]')].find(b => b.dataset.menuact.startsWith('setf:urgency:Critical')).click());
  await page.waitForTimeout(300);
  const critRows = await page.$$eval('#task-rows tr', trs => trs.length);
  const chipsNow = await page.$$eval('.mt-chip', els => els.map(e => e.textContent.replace('✕','').trim()));
  console.log('MENU OPEN:', menuOpen, '| CRITICAL ROWS:', critRows, '| CHIPS:', JSON.stringify(chipsNow));

  await page.click('#clear-mytasks-filter');
  await page.waitForTimeout(300);
  const cleared = await page.$$eval('#task-rows tr', trs => trs.length);
  console.log('CLEARED ROWS:', cleared);

  await page.screenshot({ path: '/workspace/mt_v2_light.png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/workspace/mt_v2_dark.png' });

  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})();

const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8090/index.html#/mytasks', {waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,400));
  await page.screenshot({path:'mytasks_after.png', fullPage:true});
  console.log('cards:', await page.$$eval('.mtask-card', els => els.map(e => e.textContent.trim().replace(/\s+/g,' '))));
  console.log('groups:', await page.$$eval('.mtask-group-title', els => els.map(e => e.textContent.trim())));
  console.log('total rows:', await page.$$eval('.task-table tbody tr[data-idx]', r => r.length));
  // click "In review" card → should filter to only that status
  await page.click('.mtask-card[data-status="In review"]');
  await new Promise(r=>setTimeout(r,300));
  console.log('rows after filter In review:', await page.$$eval('.task-table tbody tr[data-idx]', r => r.length));
  console.log('active card:', await page.$$eval('.mtask-card.active', els => els.map(e=>e.dataset.status)));
  await page.screenshot({path:'mytasks_filtered.png'});
  // toggle off
  await page.click('.mtask-card[data-status="In review"]');
  await new Promise(r=>setTimeout(r,300));
  console.log('rows after toggle off:', await page.$$eval('.task-table tbody tr[data-idx]', r => r.length));
  // search interplay
  await page.fill('#global-search', 'zzz-nothing');
  await new Promise(r=>setTimeout(r,300));
  console.log('empty state visible:', (await page.$('.mtask-page .empty-state')) !== null);
  await page.click('#clear-mytasks-filter').catch(()=>{});
  await new Promise(r=>setTimeout(r,300));
  console.log('rows after clear:', await page.$$eval('.task-table tbody tr[data-idx]', r => r.length));
  // row click opens task detail
  await page.click('.task-table tbody tr[data-idx]');
  await new Promise(r=>setTimeout(r,300));
  console.log('hash after row click:', await page.evaluate(() => location.hash));
  // dark mode screenshot
  await page.goto('http://localhost:8090/index.html#/mytasks', {waitUntil:'networkidle0'});
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await new Promise(r=>setTimeout(r,200));
  await page.screenshot({path:'mytasks_dark.png', fullPage:true});
  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();

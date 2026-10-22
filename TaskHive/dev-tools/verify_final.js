const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  // --- Board page: full board (no project filter) ---
  await p.goto('http://localhost:8090/index.html#/board');
  await p.waitForTimeout(700);
  const sel = 'tr[data-idx] .progress-cell.progress-btn';

  // cycle click on first row: Ongoing -> In review with prog-review class
  const before = await p.$eval(sel, e => ({ t: e.textContent.trim(), cls: e.className }));
  await p.click(sel);
  await p.waitForTimeout(300);
  const after = await p.$eval(sel, e => ({ t: e.textContent.trim(), cls: e.className, bg: getComputedStyle(e).backgroundColor }));
  console.log('CYCLE:', JSON.stringify(before), '->', JSON.stringify(after));

  // Pending filter via column menu
  await p.click('th [data-menu="col:progress"]'); await p.waitForTimeout(250);
  await p.click('[data-menuact="setf:progress:Pending"]'); await p.waitForTimeout(300);
  const pend = await p.$$eval(sel, els => els.map(e => ({ c: e.className.includes('prog-pending'), t: e.textContent.trim() })));
  console.log('PENDING FILTER rows:', pend.length, 'all pending pills:', pend.every(x => x.c), 'labels:', [...new Set(pend.map(x => x.t))]);
  await p.screenshot({ path: 'prog_light.png' });
  await p.click('th [data-menu="col:progress"]'); await p.waitForTimeout(200);
  await p.click('[data-menuact="clearf:progress"]'); await p.waitForTimeout(250);

  // Urgency untouched
  const urg = await p.$eval('td .pill', e => ({ cls: e.className, bg: getComputedStyle(e).backgroundColor }));
  console.log('URGENCY unchanged:', JSON.stringify(urg));

  // dark mode
  await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.waitForTimeout(300);
  await p.screenshot({ path: 'prog_dark.png' });

  // My Tasks redesigned table view
  await p.goto('http://localhost:8090/index.html#/mytasks');
  await p.waitForTimeout(600);
  await p.screenshot({ path: 'prog_mytasks.png' });
  console.log('ERRORS:', errs);
  await b.close();
})();

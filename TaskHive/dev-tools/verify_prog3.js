const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  // fresh localStorage so first row is Ongoing
  await p.goto('http://localhost:8090/index.html');
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://localhost:8090/index.html#/board');
  await p.waitForTimeout(700);

  const sel = 'tr[data-idx] .progress-cell.progress-btn';
  const before = await p.$eval(sel, e => ({ t: e.textContent.trim(), cls: e.className, bg: getComputedStyle(e).backgroundColor }));
  await p.click(sel);
  await p.waitForTimeout(300);
  const after = await p.$eval(sel, e => ({ t: e.textContent.trim(), cls: e.className, bg: getComputedStyle(e).backgroundColor }));
  console.log('CYCLE OK:', JSON.stringify(before), '->', JSON.stringify(after));

  // filter Pending via menu -> all rows should be prog-pending
  await p.click('th [data-menu="col:progress"]'); await p.waitForTimeout(250);
  await p.click('[data-menuact="setf:progress:Pending"]'); await p.waitForTimeout(300);
  const pend = await p.$$eval(sel, els => els.map(e => e.className.includes('prog-pending')));
  console.log('PENDING FILTER all pending pills:', pend.length, pend.every(Boolean));
  await p.screenshot({ path: 'prog_light.png' });
  await p.click('th [data-menu="col:progress"]'); await p.waitForTimeout(200);
  await p.click('[data-menuact="clearf:progress"]'); await p.waitForTimeout(250);

  await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.waitForTimeout(300);
  await p.screenshot({ path: 'prog_dark.png' });

  await p.goto('http://localhost:8090/index.html#/mytasks');
  await p.waitForTimeout(600);
  await p.screenshot({ path: 'prog_mytasks.png' });
  console.log('ERRORS:', errs);
  await b.close();
})();

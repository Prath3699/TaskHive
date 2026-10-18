const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8090/index.html#/board');
  await p.waitForTimeout(700);

  // cycle status with class check
  const firstSel = 'tr[data-idx] .progress-cell.progress-btn';
  const before = await p.$eval(firstSel, e => ({ t: e.textContent.trim(), cls: e.className }));
  await p.click(firstSel);
  await p.waitForTimeout(300);
  const after = await p.$eval(firstSel, e => ({ t: e.textContent.trim(), cls: e.className }));
  console.log('cycle:', JSON.stringify(before), '->', JSON.stringify(after));

  // open progress column menu (correct selector)
  await p.click('th [data-menu="col:progress"]');
  await p.waitForTimeout(250);
  const menuDots = await p.$$eval('.menu-item .status-dot', d => d.length);
  const menuVisible = await p.$eval('.col-menu, .menu-pop, [class*=menu]', e => getComputedStyle(e).display !== 'none').catch(() => 'n/a');
  console.log('menu dots:', menuDots, 'visible:', menuVisible);
  // apply a filter from the menu and confirm pill re-renders colored
  await p.click('[data-menuact^="setf:progress:Pending"]');
  await p.waitForTimeout(300);
  const filtered = await p.$$eval('tr[data-idx] .progress-cell.progress-btn', els => els.map(e => e.className));
  console.log('after Pending filter classes:', filtered.slice(0,3));
  await p.screenshot({ path: 'prog_light.png' });
  // clear
  await p.click('th [data-menu="col:progress"]'); await p.waitForTimeout(200);
  await p.click('[data-menuact="clearf:progress"]'); await p.waitForTimeout(250);

  // dark mode screenshot + colors
  await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.waitForTimeout(300);
  const dark = await p.$$eval('td .progress-cell.progress-btn', els => [...new Set(els.map(e => getComputedStyle(e).backgroundColor))]);
  console.log('dark bgs:', dark);
  await p.screenshot({ path: 'prog_dark.png' });

  // my tasks page pills
  await p.goto('http://localhost:8090/index.html#/mytasks');
  await p.waitForTimeout(600);
  const mt = await p.$$eval('.progress-cell.progress-btn', els => ({ n: els.length, allPill: els.every(e => getComputedStyle(e).borderRadius === '999px') }));
  console.log('mytasks:', JSON.stringify(mt));
  await p.screenshot({ path: 'prog_mytasks.png' });

  console.log('ERRORS:', errs);
  await b.close();
})();

const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8090/index.html#/board');
  await p.waitForTimeout(600);

  // All progress buttons are pills
  const info = await p.$$eval('td .progress-cell.progress-btn', els => els.map(e => {
    const cs = getComputedStyle(e);
    return { text: e.textContent.trim(), radius: cs.borderRadius, border: cs.borderTopWidth + ' ' + cs.borderTopStyle, bg: cs.backgroundColor, color: cs.color, pad: cs.padding, fs: cs.fontSize, fw: cs.fontWeight, h: Math.round(e.getBoundingClientRect().height), dot: !!e.querySelector('.status-dot') };
  }));
  console.log('rows:', info.length);
  console.log(JSON.stringify(info[0], null, 1));
  const uniqBg = [...new Set(info.map(i => i.bg))];
  console.log('distinct backgrounds:', uniqBg);
  const allPill = info.every(i => i.radius === '999px' && parseFloat(i.border) === 0 && i.dot && i.pad === '3px 12px' && i.fs === '12px' && i.fw === '600');
  console.log('ALL_PILL_STYLE:', allPill);

  // Compare with urgency badge metrics
  const urg = await p.$eval('td .pill', e => { const cs = getComputedStyle(e); return { fs: cs.fontSize, fw: cs.fontWeight, pad: cs.padding, radius: cs.borderRadius, h: Math.round(e.getBoundingClientRect().height) }; });
  console.log('urgency metrics:', JSON.stringify(urg), 'progress metrics:', JSON.stringify({fs: info[0].fs, fw: info[0].fw, pad: info[0].pad, radius: info[0].radius, h: info[0].h}));

  // cycle status still works
  const before = await p.$eval('tr td .progress-cell.progress-btn', e => e.textContent.trim());
  await p.click('tr td .progress-cell.progress-btn');
  await p.waitForTimeout(300);
  const after = await p.$eval('tr td .progress-cell.progress-btn', e => ({ t: e.textContent.trim(), cls: e.className }));
  console.log('cycle:', before, '->', after.t, '| class:', after.cls);

  // dropdown filter menu still shows dots
  await p.click('[data-colmenu="progress"] , th [data-menukey="progress"], .col-menu-btn');
  await p.waitForTimeout(200);
  const menuItems = await p.$$eval('.menu-item .mi-icon .status-dot', d => d.length).catch(() => 0);
  console.log('menu dots:', menuItems);

  await p.screenshot({ path: 'prog_light.png' });

  // dark mode
  await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.waitForTimeout(300);
  const dark = await p.$$eval('td .progress-cell.progress-btn', els => els.slice(0,4).map(e => getComputedStyle(e).backgroundColor));
  console.log('dark bgs:', dark);
  await p.screenshot({ path: 'prog_dark.png' });

  // my tasks page table view
  await p.goto('http://localhost:8090/index.html#/mytasks');
  await p.waitForTimeout(500);
  const mt = await p.$$eval('.progress-cell.progress-btn', els => els.map(e => getComputedStyle(e).borderRadius));
  console.log('mytasks pills:', mt.length, mt.every(r => r === '999px'));

  console.log('ERRORS:', errs);
  await b.close();
})();

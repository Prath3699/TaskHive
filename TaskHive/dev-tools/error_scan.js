const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  p.on('console', m => {
    if (m.type() === 'error') errors.push('CONSOLE ERROR: ' + m.text());
  });

  const routes = ['#/board', '#/mytasks', '#/progress', '#/settings', '#/'];
  for (const r of routes) {
    await p.goto('http://localhost:8090/index.html' + r);
    await p.waitForTimeout(600);
    console.log('ROUTE', r, 'ok so far:', errors.length === 0);
  }

  // Interactions on board page
  await p.goto('http://localhost:8090/index.html#/board');
  await p.waitForTimeout(500);

  // open new feature modal
  try {
    await p.click('#new-feature-btn');
    await p.waitForTimeout(300);
    await p.screenshot({ path: '/tmp/modal.png' });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
  } catch (e) { errors.push('INTERACT new-feature: ' + e.message.split('\n')[0]); }

  // column menu
  try {
    await p.click('th [data-menu="col:progress"]');
    await p.waitForTimeout(250);
    await p.click('[data-menuact="setf:progress:Pending"]');
    await p.waitForTimeout(250);
    await p.click('th [data-menu="col:progress"]');
    await p.waitForTimeout(200);
    await p.click('[data-menuact="clearf:progress"]');
    await p.waitForTimeout(200);
  } catch (e) { errors.push('INTERACT colmenu: ' + e.message.split('\n')[0]); }

  // progress pill cycle click
  try {
    await p.click('tr[data-idx] .progress-cell.progress-btn');
    await p.waitForTimeout(250);
  } catch (e) { errors.push('INTERACT pill cycle: ' + e.message.split('\n')[0]); }

  // row select / properties panel
  try {
    await p.click('tr[data-idx] .feature-name');
    await p.waitForTimeout(300);
  } catch (e) { errors.push('INTERACT row select: ' + e.message.split('\n')[0]); }

  // kanban toggle
  try {
    await p.click('.vt-btn');
    await p.waitForTimeout(400);
  } catch (e) { errors.push('INTERACT kanban: ' + e.message.split('\n')[0]); }

  // search
  try {
    await p.fill('#global-search', 'login');
    await p.waitForTimeout(300);
    await p.fill('#global-search', '');
    await p.waitForTimeout(200);
  } catch (e) { errors.push('INTERACT search: ' + e.message.split('\n')[0]); }

  // dark mode toggle
  try {
    await p.goto('http://localhost:8090/index.html#/settings');
    await p.waitForTimeout(400);
    const hasDark = await p.$('#set-dark');
    if (hasDark) { await p.click('#set-dark'); await p.waitForTimeout(250); }
    else errors.push('WARN: #set-dark not found on settings page');
  } catch (e) { errors.push('INTERACT dark: ' + e.message.split('\n')[0]); }

  console.log('\n===== ERRORS (' + errors.length + ') =====');
  errors.forEach(e => console.log(e));
  await b.close();
})();

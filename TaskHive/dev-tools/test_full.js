const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto('file:///workspace/index.html');
  await page.waitForTimeout(500);

  const routes = ['#/','#/inbox','#/saved','#/mytasks','#/projects','#/calendar','#/roadmaps','#/channels','#/settings','#/help','#/board','#/task/2','#/channel/design'];
  for (const r of routes) {
    await page.evaluate(h => location.hash = h, r);
    await page.waitForTimeout(250);
    const txt = await page.evaluate(() => document.querySelector('#main, main, body').innerText.slice(0,60).replace(/\n/g,' | '));
    console.log(r.padEnd(16), '->', txt);
  }
  console.log('\n--- ERRORS ---');
  console.log(errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });

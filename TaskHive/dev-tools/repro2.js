const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  await p.goto('http://localhost:8090/index.html#/mytasks');
  await p.waitForSelector('.mt-hero');

  // --- urgency filter via menu (audit step) ---
  await p.locator('.th-btn[data-menu="col:urgency"]').first().click();
  await p.waitForTimeout(150);
  const acts = await p.$$eval('.col-menu [data-menuact^="setf:urgency"]', els => els.map(e => e.dataset.menuact));
  console.log('menu items:', acts);
  await p.locator('.col-menu [data-menuact^="setf:urgency"]').first().click();
  await p.waitForTimeout(200);
  const st = await p.evaluate(() => document.querySelector('.th-btn.is-filtered')?.textContent || 'no filtered header');
  console.log('filtered header:', st);
  const urg = await p.locator('.task-table tbody .urgency-cell').allInnerTexts();
  console.log('visible urgencies:', [...new Set(urg.map(u => u.trim()))], 'rows:', urg.length);
  await p.screenshot({ path: '/tmp/urg.png' });

  // --- row click -> task detail ---
  await p.evaluate(() => { document.querySelectorAll('.mt-chip').forEach(c => c.click()); });
  await p.waitForTimeout(200);
  const cell = p.locator('.task-table tbody tr').first().locator('td:nth-child(2)');
  await cell.click();
  await p.waitForTimeout(300);
  console.log('url after row click:', p.url());
  console.log('selected rows:', await p.locator('.task-table tbody tr.selected').count());
  console.log('properties present:', await p.locator('.properties').count());
  console.log('hash:', p.url().split('#')[1]);
  console.log('JS ERRORS:', errs);
  await b.close();
})();

const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForSelector('.mt-pill');
  console.log('pills:', await page.locator('.mt-pill').count());
  await page.locator('.mt-pill', { hasText: 'Ongoing' }).first().click();
  await page.waitForTimeout(300);
  console.log('active pill:', await page.locator('.mt-pill.active').innerText().catch(()=>'NONE'));
  console.log('chips:', await page.locator('.mt-chip').count());
  console.log('chip html:', await page.locator('.mt-toolbar').innerHTML().then(h=>h.slice(0,600)));
  console.log('errors:', errs.join(' | ') || 'none');
  await b.close();
})();

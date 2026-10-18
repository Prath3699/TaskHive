const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForSelector('.mt-pill');
  // instrument the handler order
  await page.evaluate(() => {
    window.__log = [];
    document.body.addEventListener('click', e => {
      const el = e.target.closest('[id],[data-goto],[data-calday],[data-project],[data-inbox],[data-attachment],[data-person],[data-plan],[data-view],[data-export]');
      window.__log.push('closest=' + (el ? (el.id || el.className) : 'null'));
    }, false); // runs BEFORE delegated bubble listeners? both on body bubble phase — registration order matters; this added after app's, so app runs first
  });
  await page.locator('.mt-pill', { hasText: 'Ongoing' }).first().click();
  await page.waitForTimeout(300);
  console.log(await page.evaluate(() => window.__log));
  console.log('active pill:', await page.locator('.mt-pill.active').innerText());
  console.log('chips:', await page.locator('.mt-chip').count());
  await b.close();
})();

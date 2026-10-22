const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForSelector('.task-table tbody tr');
  await page.locator('.task-table tbody tr').first().locator('.del-btn').click();
  await page.waitForTimeout(300);
  console.log('modal hidden?', await page.locator('#modal-overlay').evaluate(el => el.className));
  console.log('confirm count:', await page.locator('#confirm-delete').count());
  console.log('modal title:', await page.locator('#modal-title').innerText().catch(()=>'?'));
  await b.close();
})();

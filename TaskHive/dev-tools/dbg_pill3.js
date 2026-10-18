const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForSelector('.mt-pill');
  const info = await page.evaluate(() => {
    const pill = [...document.querySelectorAll('.mt-pill')].find(p => p.textContent.includes('Ongoing'));
    const r = pill.getBoundingClientRect();
    return { rect: [r.x, r.y, r.width, r.height], atPoint: document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.outerHTML.slice(0, 200) };
  });
  console.log(JSON.stringify(info, null, 1));
  // dispatch a real DOM click on the pill itself
  await page.evaluate(() => {
    const pill = [...document.querySelectorAll('.mt-pill')].find(p => p.textContent.includes('Ongoing'));
    pill.click();
  });
  await page.waitForTimeout(200);
  console.log('after .click(): active =', await page.locator('.mt-pill.active').innerText(), '| chips =', await page.locator('.mt-chip').count());
  await b.close();
})();

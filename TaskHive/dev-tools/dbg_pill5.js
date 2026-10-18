const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForSelector('.mt-pill');
  const res = await page.evaluate(() => {
    const pill = [...document.querySelectorAll('.mt-pill')].find(p => p.textContent.includes('Ongoing'));
    // replicate handler's closest selector
    const sel = '[id],[data-goto],[data-calday],[data-project],[data-inbox],[data-attachment],[data-person],[data-plan],[data-view],[data-export]';
    const found = pill.closest(sel);
    return {
      foundTag: found ? (found.id || found.className) : null,
      isPill: found === pill,
      dataset: JSON.stringify({...pill.dataset}),
      hasStatusAttr: pill.hasAttribute('data-status'),
      classList: [...pill.classList],
      containsMtPill: found ? found.classList.contains('mt-pill') : null,
    };
  });
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})();

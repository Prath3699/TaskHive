const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForSelector('.mt-pill');
  const res = await page.evaluate(() => {
    const pill = [...document.querySelectorAll('.mt-pill')].find(p => p.textContent.includes('Ongoing'));
    const r = pill.getBoundingClientRect();
    const cx = r.x + r.width/2, cy = r.y + r.height/2;
    const elAt = document.elementFromPoint(cx, cy);
    // trace ancestors of element at point
    const chain = [];
    let n = elAt; while (n) { chain.push(n.tagName + '.' + (n.className||'').toString().split(' ')[0]); n = n.parentElement; if (chain.length>8) break; }
    return {
      isPillSelf: elAt === pill,
      closestMtPillOfElAt: !!elAt?.closest('.mt-pill'),
      chain,
      pillsTotal: document.querySelectorAll('.mt-pill').length,
      pillsInMain: document.querySelectorAll('#page .mt-pill').length,
      dupes: document.querySelectorAll('.mt-pills').length,
    };
  });
  console.log(JSON.stringify(res));
  await b.close();
})();

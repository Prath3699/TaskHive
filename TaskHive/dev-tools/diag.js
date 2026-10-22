const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://localhost:8090/index.html#/board');
  await p.waitForTimeout(700);
  console.log(await p.evaluate(() => ({
    route: currentRoute, kanbanMode,
    rowsBefore: document.querySelectorAll('tr[data-idx]').length,
    search: searchTerm, filterState,
  })));
  await p.click('th [data-menu="col:progress"]'); await p.waitForTimeout(250);
  await p.click('[data-menuact="setf:progress:Pending"]'); await p.waitForTimeout(300);
  console.log(await p.evaluate(() => ({
    route: currentRoute, kanbanMode,
    rowsAfter: document.querySelectorAll('tr[data-idx]').length,
    filterState,
    boardBody: !!document.querySelector('#board-body'),
    activeTab: document.querySelector('.tab.active')?.textContent,
    firstRowHtml: document.querySelector('tr[data-idx]')?.outerHTML.slice(0,200),
  })));
  await b.close();
})();

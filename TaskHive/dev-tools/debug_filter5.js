const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', e => console.log('PAGEERR:', String(e).slice(0,300)));
  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .task-table tbody tr');
  await page.click('.tab[data-tab="2"]'); await page.waitForTimeout(400);
  await page.goto('http://localhost:3000/#/mytasks'); await page.waitForTimeout(500);
  await page.goto('http://localhost:3000/#/projects'); await page.waitForTimeout(400);
  await page.click('.project-card:first-child'); await page.waitForTimeout(400);
  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .assignee-name');
  await page.selectOption('#flt-assignee', 'p1'); await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({
    activeTab: document.querySelector('.tab.active')?.dataset.tab,
    activeTabText: document.querySelector('.tab.active')?.textContent,
    boardBodyStart: document.querySelector('#board-body')?.innerHTML.slice(0,120),
    hasToolbar: !!document.querySelector('#flt-assignee'),
    rowsInBoard: document.querySelectorAll('#board-body .task-table tbody tr').length,
    taskRowsExists: !!document.querySelector('#task-rows'),
  }));
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})();

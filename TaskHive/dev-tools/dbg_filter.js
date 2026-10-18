const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .task-table tbody tr');
  await page.selectOption('#flt-assignee', 'p1'); await page.waitForTimeout(500);
  const rows = await page.$$eval('#board-body .task-table tbody tr', trs => trs.map(tr => ({
    assignee: tr.querySelector('.assignee-name')?.textContent.trim(),
    avatarTitle: tr.querySelector('.link-avatar')?.title,
  })));
  console.log(JSON.stringify(rows, null, 1));
  console.log('filterState:', await page.evaluate(() => JSON.parse(JSON.stringify(window.filterState || {}))));
  await browser.close();
})();

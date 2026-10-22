const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await (await browser.newContext()).newPage();
  // replicate e2e_ui pre-steps
  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .task-table tbody tr');
  await page.click('.tab[data-tab="2"]'); await page.waitForTimeout(400);   // kanban ON
  await page.goto('http://localhost:3000/#/mytasks'); await page.waitForTimeout(500);
  await page.goto('http://localhost:3000/#/projects'); await page.waitForTimeout(400);
  await page.click('.project-card:first-child'); await page.waitForTimeout(400);
  console.log('url:', page.url());
  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .assignee-name');
  console.log('kanbanMode? kb-cols:', (await page.$$('.kb-col')).length, 'task-rows:', (await page.$$('#task-rows tr')).length);
  await page.selectOption('#flt-assignee', 'p1'); await page.waitForTimeout(400);
  const names = await page.$$eval('.assignee-name', els => els.map(e => e.textContent.trim()));
  console.log('names:', JSON.stringify(names.slice(0,10)));
  await browser.close();
})();

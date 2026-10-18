const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:3000/#/project/q3-plan');
  await page.waitForSelector('#board-body .assignee-name');
  // replicate prior steps quickly? no - just test filter here
  console.log('select options:', await page.$$eval('#flt-assignee option', o => o.map(x => x.value + '=' + x.textContent)));
  await page.selectOption('#flt-assignee', 'p1'); await page.waitForTimeout(400);
  const names = await page.$$eval('#task-rows .assignee-name', els => els.map(e => e.textContent.trim()));
  console.log('names:', JSON.stringify(names));
  await b_close(browser);
  async function b_close(b){ await b.close(); }
})();

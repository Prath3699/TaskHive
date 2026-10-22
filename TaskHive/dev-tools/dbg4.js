const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const p = await b.newPage();
  await p.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await p.click('#show-signup'); await p.waitForTimeout(200);
  await p.fill('#signup-name', 'Ada Lovelace');
  await p.fill('#signup-email', `ada${Date.now()}@catlas.inc`);
  await p.fill('#signup-password', 'calculus');
  await p.click('#signup-form button[type=submit]');
  await p.waitForTimeout(2500);
  console.log(await p.evaluate(() => {
    const tb = document.querySelector('.task-table tbody');
    return JSON.stringify({
      tables: document.querySelectorAll('.task-table').length,
      tbodyExists: !!tb,
      tbodyChildrenTags: tb ? [...tb.children].map(c => c.tagName).slice(0,5) : null,
      tbodyChildCount: tb ? tb.children.length : null,
      tbodyFirstOuter: tb && tb.children[0] ? tb.children[0].outerHTML.slice(0,120) : (tb ? tb.innerHTML.slice(0,200) : null),
    });
  }));
  await b.close();
})();

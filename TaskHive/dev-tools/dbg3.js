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
  console.log('rows:', (await p.$$('.task-table tbody tr')).length);
  console.log(await p.evaluate(() => {
    const t = document.querySelector('.task-table');
    return JSON.stringify({ theadRows: t.querySelectorAll('thead tr').length, tbodyRows: t.querySelectorAll('tbody tr').length, allTr: t.querySelectorAll('tr').length, outerStart: t.outerHTML.slice(0,300) });
  }));
  await b.close();
})();

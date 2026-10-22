const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const p = await (await b.newContext()).newPage();
  await p.goto('http://localhost:3000/');
  await p.waitForSelector('#login-form'); await p.click('#login-submit');
  await p.waitForTimeout(2500);
  const info = await p.evaluate(() => ({
    hash: location.hash,
    rows: document.querySelectorAll('tbody tr[data-idx]').length,
    sk: document.querySelectorAll('.sk-row').length,
    eb: !!document.querySelector('.error-boundary'),
    start: document.getElementById('page').innerHTML.slice(0, 100),
  }));
  console.log('STATE', JSON.stringify(info));
  // same-hash navigation test
  const r = await p.evaluate(() => new Promise(res => {
    location.hash = '#/home';
    setTimeout(() => { location.hash = '#/inbox'; setTimeout(() => { location.hash = '#/home'; setTimeout(() => res(document.querySelectorAll('tbody tr[data-idx]').length), 800); }, 400); }, 400);
  }));
  console.log('rows after eb-home style nav:', r);
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(2); });

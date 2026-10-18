const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto('http://localhost:3000/');
  await p.waitForSelector('#login-form'); await p.click('#login-submit');
  await p.waitForTimeout(2000);
  // reproduce eb-home failure exactly
  await p.evaluate(() => { renderErrorView(new Error('boom-test')); });
  await p.click('#eb-home');
  await p.waitForTimeout(400);
  const s = await p.evaluate(() => ({ hash: location.hash, rows: document.querySelectorAll('tbody tr[data-idx]').length, start: document.getElementById('page').innerHTML.slice(0,80) }));
  console.log('AFTER EB-HOME', JSON.stringify(s));

  // skeleton test on fresh reload with throttled bootstrap (session cookie in ctx)
  const p2 = await ctx.newPage();
  await p2.route('/api/bootstrap', async route => { await new Promise(r => setTimeout(r, 900)); await route.continue(); });
  await p2.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 12; i++) {
    const st = await p2.evaluate(() => ({ sk: document.querySelectorAll('.sk-row,.sk-b').length, boot: !!document.querySelector('#boot-loading'), login: document.body.classList.contains('show-login'), rows: document.querySelectorAll('tbody tr[data-idx]').length })).catch(()=>({}));
    console.log('t'+i, JSON.stringify(st));
    if (st.rows) break;
    await p2.waitForTimeout(200);
  }
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(2); });

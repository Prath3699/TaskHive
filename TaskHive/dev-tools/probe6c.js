const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  // logged-out + slow bootstrap -> skeletons must NOT be visible behind login overlay
  await p.route('/api/bootstrap', async r => { await new Promise(x => setTimeout(x, 700)); await r.continue(); });
  await p.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#login-form', { state: 'visible' });
  const visSk = await p.evaluate(() => [...document.querySelectorAll('.sk-b')].some(e => e.offsetParent !== null));
  console.log('skeleton visible during login boot:', visSk);
  await p.click('#login-submit');
  await p.waitForSelector('tbody tr[data-idx]');
  // eb-home recovery from #/home
  await p.evaluate(() => renderErrorView(new Error('boom')));
  await p.click('#eb-home');
  await p.waitForTimeout(300);
  console.log('rows after eb-home on #/home:', await p.evaluate(() => document.querySelectorAll('tbody tr[data-idx]').length));
  // skeleton visible for logged-in reload?
  const p2 = await ctx.newPage();
  await p2.route('/api/bootstrap', async r => { await new Promise(x => setTimeout(x, 800)); await r.continue(); });
  await p2.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  let saw = false;
  for (let i = 0; i < 15; i++) {
    if (await p2.evaluate(() => [...document.querySelectorAll('.sk-row')].some(e => e.offsetParent !== null))) { saw = true; break; }
    await p2.waitForTimeout(100);
  }
  console.log('skeleton visible during authenticated boot:', saw);
  await p2.waitForSelector('tbody tr[data-idx]');
  console.log('final rows:', await p2.evaluate(() => document.querySelectorAll('tbody tr[data-idx]').length), 'sk gone:', await p2.evaluate(() => !document.querySelector('.sk-row')));
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(2); });

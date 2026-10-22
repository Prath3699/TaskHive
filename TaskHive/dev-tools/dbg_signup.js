const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async()=>{
  const b = await chromium.launch({executablePath:EXE});
  const p = await (await b.newContext()).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push('console:'+m.text())});
  await p.goto('http://localhost:3000/');
  await p.waitForSelector('#login-form');
  await p.click('#show-signup'); await p.waitForTimeout(200);
  await p.fill('#signup-name', 'Ada Lovelace');
  await p.fill('#signup-email', `ada${Date.now()}@catlas.inc`);
  await p.fill('#signup-password', 'calculus');
  const [resp] = await Promise.all([
    p.waitForResponse(r => r.url().includes('/api/signup'), { timeout: 8000 }).catch(e => null),
    p.click('#signup-form button[type=submit]'),
  ]);
  console.log('signup status:', resp ? resp.status() : 'NO RESPONSE CAPTURED');
  if (resp) console.log('body:', (await resp.text()).slice(0,200));
  await p.waitForTimeout(1500);
  console.log('rows:', (await p.$$('.task-table tbody tr')).length);
  console.log('notice:', await p.evaluate(()=>document.querySelector('.login-notice')?.textContent || 'none'));
  console.log('errors:', errs.join(' | ') || 'none');
  await b.close();
})();

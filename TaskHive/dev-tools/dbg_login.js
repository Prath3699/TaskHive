const { chromium } = require('playwright');
const EXE='/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
(async()=>{
  const b = await chromium.launch({executablePath:EXE});
  const p = await (await b.newContext()).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  await p.goto('http://localhost:3000/');
  await p.waitForTimeout(2000);
  console.log('body classes:', await p.evaluate(()=>document.body.className));
  console.log('#login-screen exists:', !!(await p.$('#login-screen')));
  console.log('#login-form exists:', !!(await p.$('#login-form')));
  console.log('index.html has login-screen div:', (await p.content()).includes('id="login-screen"'));
  console.log('errors:', errs.join(' | ') || 'none');
  await b.close();
})();

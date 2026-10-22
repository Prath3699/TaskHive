const { chromium } = require('playwright');
const EXE = process.env.PW_EXE || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#login-email', { timeout: 8000 });
  await page.fill('#login-email', 'parth@catlas.inc');
  await page.fill('#login-password', 'password');
  await page.click('#login-submit');
  await page.waitForTimeout(1500);
  await page.goto('http://localhost:3000/#/settings');
  await page.waitForSelector('.st-hero', { timeout: 8000 });

  // 1. initial state
  for (const id of ['set-email-notif', 'set-digest', 'set-dark']) {
    console.log('initial', id, await page.isChecked('#'+id));
  }

  // 2. click the TRACK (visual part), not the input — simulates user clicking the switch itself
  await page.click('#set-email-notif + .toggle-track');
  await page.waitForTimeout(300);
  console.log('after track-click email:', await page.isChecked('#set-email-notif'));

  // 3. click the LABEL wrapper
  await page.click('label[for], .toggle:has(#set-digest)');
  await page.waitForTimeout(300);
  console.log('after label-click digest:', await page.isChecked('#set-digest'));

  // 4. toggle dark by clicking track; check html.dark + checkbox sync + muted text
  await page.click('#set-dark + .toggle-track');
  await page.waitForTimeout(400);
  console.log('dark class:', await page.evaluate(() => document.documentElement.classList.contains('dark')));
  console.log('set-dark checked:', await page.isChecked('#set-dark'));
  console.log('desc text:', await page.evaluate(() => {
    const cb = document.getElementById('set-dark');
    return cb ? cb.closest('.switch-row').querySelector('p.muted').textContent : 'NO-CB';
  }));

  // 5. navigate away and back — do checkboxes reflect state?
  await page.goto('http://localhost:3000/#/home');
  await page.waitForTimeout(500);
  await page.goto('http://localhost:3000/#/settings');
  await page.waitForSelector('.st-hero', { timeout: 5000 });
  for (const id of ['set-email-notif', 'set-digest', 'set-dark']) {
    console.log('after-nav-back', id, await page.isChecked('#'+id));
  }

  // 6. reload — server persistence
  await page.reload();
  await page.waitForSelector('.st-hero', { timeout: 8000 });
  for (const id of ['set-email-notif', 'set-digest', 'set-dark']) {
    console.log('after-reload', id, await page.isChecked('#'+id));
  }
  console.log('dark after reload:', await page.evaluate(() => document.documentElement.classList.contains('dark')));

  // 7. computed styles of track in current theme
  console.log('track bg:', await page.evaluate(() => getComputedStyle(document.querySelector('#set-dark + .toggle-track')).backgroundColor));
  console.log('checked track bg:', await page.evaluate(() => {
    const t = document.querySelector('#set-email-notif:checked + .toggle-track');
    return t ? getComputedStyle(t).backgroundColor : 'none-checked';
  }));

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
})().catch(e => { console.error('SCRIPT FAIL', e); process.exit(1); });

const { chromium } = require('playwright');
const EXE = process.env.PW_EXE || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let pass = 0, fail = 0;
  const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); c ? pass++ : fail++; };

  // login
  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#login-email', { timeout: 8000 });
  await page.fill('#login-email', 'parth@catlas.inc');
  await page.fill('#login-password', 'password');
  await page.click('#login-submit');
  await page.waitForSelector('.app-shell', { state: 'visible', timeout: 8000 }).catch(()=>{});

  // ---- Roadmap quarter filters ----
  await page.goto('http://localhost:3000/#/roadmaps');
  await page.waitForSelector('.rm-card', { timeout: 8000 });
  const allCards = await page.locator('.rm-card').count();
  ok(await page.locator('.rm-filters .rm-chipf').count() >= 2, `quarter filter chips render (${await page.locator('.rm-filters .rm-chipf').count()} chips)`);
  ok(await page.locator('.rm-chipf.on[data-rmf="all"]').count() === 1, '"All quarters" chip active by default');

  await page.click('.rm-chipf[data-rmf="Q3"]');
  await page.waitForTimeout(300);
  const q3Cards = await page.locator('.rm-card').count();
  ok(q3Cards < allCards && q3Cards >= 1, `Q3 filter narrows cards ${allCards} -> ${q3Cards}`);
  const kicker = await page.locator('.rm-kicker').first().innerText();
  ok(kicker.startsWith('Q3'), `filtered card is Q3 (${kicker})`);

  // filter persists across re-render (nav away and back)
  await page.goto('http://localhost:3000/#/home'); await page.waitForTimeout(200);
  await page.goto('http://localhost:3000/#/roadmaps'); await page.waitForSelector('.rm-card', { timeout: 5000 });
  ok(await page.locator('.rm-chipf.on[data-rmf="Q3"]').count() === 1, 'filter state persists across navigation');

  await page.click('.rm-chipf[data-rmf="all"]'); await page.waitForTimeout(200);
  ok(await page.locator('.rm-card').count() === allCards, 'resetting to All restores full grid');

  // ---- Settings avatar ring ----
  await page.goto('http://localhost:3000/#/settings');
  await page.waitForSelector('.st-avatar-wrap', { timeout: 5000 });
  ok(await page.locator('.st-avatar-wrap .avatar-lg').count() === 1, 'settings avatar wrapped in gradient ring');
  ok(await page.locator('.st-presence').count() === 1, 'online presence dot rendered on avatar');

  // ---- Desktop: bottom tab bar hidden ----
  ok(await page.locator('.bottom-tabs').isVisible() === false, 'bottom tab bar hidden on desktop');

  // ---- Mobile emulation: bottom tab bar (fresh context = no session cookie) ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const mp = await mctx.newPage();
  await mp.setViewportSize({ width: 390, height: 844 });
  await mp.goto('http://localhost:3000/#/home');
  await mp.waitForSelector('#login-email', { timeout: 8000 });
  await mp.fill('#login-email', 'parth@catlas.inc');
  await mp.fill('#login-password', 'password');
  await mp.click('#login-submit');
  await mp.waitForSelector('.bt-item', { state: 'visible', timeout: 8000 });
  ok(await mp.locator('.bt-item').count() === 5, 'mobile: 5-tab bottom bar visible');
  ok(await mp.locator('.bt-item.active[data-route="home"]').count() === 1, 'mobile: Home tab highlighted on #/home');
  await mp.tap('.bt-item[data-route="mytasks"]');
  await mp.waitForTimeout(400);
  ok(mp.url().includes('#/mytasks'), 'mobile: tapping My Tasks navigates');
  ok(await mp.locator('.bt-item.active[data-route="mytasks"]').count() === 1, 'mobile: active tab moves to My Tasks');
  await mp.tap('.bt-item[data-route="projects"]');
  await mp.waitForTimeout(400);
  ok(await mp.locator('.bt-item.active[data-route="projects"]').count() === 1, 'mobile: project detail maps to Projects tab');
  // content not hidden behind fixed bar
  const clear = await mp.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.page-pad')).paddingBottom) >= 70);
  ok(clear, 'mobile: page padding keeps content above the tab bar');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed, page errors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
  process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
})();

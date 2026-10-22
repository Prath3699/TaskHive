const { chromium } = require('playwright');
const EXE = process.env.PW_EXE || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then(c => c.newPage());
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#login-email', { timeout: 8000 });
  await page.fill('#login-email', 'parth@catlas.inc');
  await page.fill('#login-password', 'password');
  await page.click('#login-submit');
  await page.waitForSelector('.rm-card, .board', { timeout: 8000 }).catch(()=>{});
  await page.goto('http://localhost:3000/#/roadmaps');
  await page.waitForSelector('.rm-card', { timeout: 8000 });

  const cards = await page.locator('.rm-card').count();
  console.log(cards >= 4 ? `PASS ${cards} roadmap quarter cards render` : `FAIL only ${cards} cards`);

  // staggered entrance var set on every card
  const withI = await page.evaluate(() => [...document.querySelectorAll('.rm-card')].every(c => c.style.getPropertyValue('--i') !== ''));
  console.log(withI ? 'PASS staggered animation index (--i) applied to all cards' : 'FAIL --i missing on some cards');

  const rings = await page.locator('.rm-ring').count();
  const bars  = await page.locator('.rm-bar').count();
  console.log(rings === cards && bars === cards ? 'PASS progress ring + bar per card' : `FAIL rings=${rings} bars=${bars} cards=${cards}`);

  const stats = await page.locator('.rm-stat b').allInnerTexts();
  console.log(stats.length === 5 && stats.every(s => /^\d+$/.test(s)) ? 'PASS live stats strip populated: ' + stats.join('/') : 'FAIL stats: ' + JSON.stringify(stats));

  const health = await page.locator('.rm-health strong').innerText();
  console.log(/On Track|At Risk|Needs Attention/.test(health) ? `PASS health banner shows "${health}"` : 'FAIL health: ' + health);

  // click-through navigation
  await page.locator('.rm-card').first().click();
  await page.waitForTimeout(500);
  const hash = await page.evaluate(() => location.hash);
  console.log(/^#\/project\//.test(hash) || hash.includes('board') || !hash.includes('roadmaps') ? 'PASS card click navigates to board (' + hash + ')' : 'FAIL nav hash=' + hash);

  // dark mode screenshot of roadmaps
  await page.goto('http://localhost:3000/#/roadmaps');
  await page.waitForSelector('.rm-card');
  await page.screenshot({ path: 'roadmap_light.png', fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'roadmap_dark.png', fullPage: true });
  console.log('PASS roadmap screenshots saved');

  console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'PASS zero page/console errors');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

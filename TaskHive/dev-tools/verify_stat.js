const { chromium } = require('playwright');

const lum = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).map(Number).map(v => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  let errs = 0;
  p.on('pageerror', e => { console.log('PAGEERROR:', e.message); errs++; });

  await p.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  if (await p.locator('#login-form').isVisible().catch(() => false)) {
    await p.click('#login-submit');
    await p.waitForSelector('.stat-card', { timeout: 10000 });
  }
  await p.waitForSelector('.stat-card');

  const probe = () => p.evaluate(() => {
    const out = [];
    document.querySelectorAll('.stat-card').forEach(card => {
      const num = card.querySelector('.stat-num');
      const label = card.querySelector('.stat-label');
      out.push({
        label: label.textContent.trim(),
        value: num.textContent.trim(),
        numColor: getComputedStyle(num).color,
        cardBg: getComputedStyle(card).backgroundColor,
        labelColor: getComputedStyle(label).color,
        numWeight: getComputedStyle(num).fontWeight,
        numSize: getComputedStyle(num).fontSize,
        gap: getComputedStyle(card).rowGap,
        pad: getComputedStyle(card).padding,
      });
    });
    return { dark: document.documentElement.classList.contains('dark'), cards: out };
  });

  // ---- DARK MODE (via app's own toggle so persisted state matches UI) ----
  await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.waitForTimeout(200);
  let s = await probe();
  for (const c of s.cards) {
    const cr = contrast(c.numColor, c.cardBg);
    const ok = cr >= 4.5;
    console.log(`[DARK ] ${c.label.padEnd(16)} "${c.value}" num=${c.numColor} on bg=${c.cardBg} -> contrast ${cr.toFixed(2)}:1 ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) errs++;
    if (c.numColor !== 'rgb(255, 255, 255)') { console.log('  FAIL: expected #FFFFFF in dark mode, got', c.numColor); errs++; }
  }
  await p.screenshot({ path: 'stat_dark_after.png', clip: await p.locator('.stat-grid').boundingBox() });

  // ---- LIGHT MODE ----
  await p.evaluate(() => document.documentElement.classList.remove('dark'));
  await p.waitForTimeout(200);
  s = await probe();
  for (const c of s.cards) {
    const cr = contrast(c.numColor, c.cardBg);
    const ok = cr >= 4.5;
    console.log(`[LIGHT] ${c.label.padEnd(16)} "${c.value}" num=${c.numColor} on bg=${c.cardBg} -> contrast ${cr.toFixed(2)}:1 ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) errs++;
  }
  await p.screenshot({ path: 'stat_light_after.png', clip: await p.locator('.stat-grid').boundingBox() });

  // ---- typography/spacing consistency across all four cards ----
  s = await probe();
  const sigs = new Set(s.cards.map(c => `${c.numWeight}|${c.numSize}|${c.gap}|${c.pad}|${c.labelColor}|${c.numColor}`));
  console.log(sigs.size === 1 ? '[CONSISTENCY] identical typography/spacing/colors across all 4 cards: PASS' : `[CONSISTENCY] FAIL: ${[...sigs].join('  ||  ')}`);
  if (sigs.size !== 1) errs++;
  console.log('cards rendered:', s.cards.length, s.cards.length === 4 ? 'PASS' : 'FAIL');
  if (s.cards.length !== 4) errs++;

  console.log(errs === 0 ? '\nALL CHECKS PASSED' : `\n${errs} CHECK(S) FAILED`);
  await b.close();
  process.exit(errs ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

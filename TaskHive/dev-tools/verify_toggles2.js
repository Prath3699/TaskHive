const { chromium } = require('playwright');
const EXE = process.env.PW_EXE || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + m); c ? pass++ : fail++; };

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // Login
  await page.goto('http://localhost:3000/');
  await page.waitForSelector('#login-email', { timeout: 8000 });
  await page.fill('#login-email', 'parth@catlas.inc');
  await page.fill('#login-password', 'password');
  await page.click('#login-submit');
  await page.goto('http://localhost:3000/#/settings');
  await page.waitForSelector('.st-hero', { timeout: 8000 });

  const geom = async (id) => page.evaluate((sel) => {
    const wrap = document.querySelector(`#${sel}`)?.closest('.toggle');
    const inp = document.getElementById(sel);
    const track = wrap?.querySelector('.toggle-track');
    if (!wrap || !track) return null;
    const cs = getComputedStyle(track);
    const tr = track.getBoundingClientRect();
    const ir = inp.getBoundingClientRect();
    // knob rendered via ::after — approximate from transform of checked state
    const after = getComputedStyle(track, '::after');
    return {
      w: Math.round(tr.width), h: Math.round(tr.height),
      radius: cs.borderRadius, bg: cs.backgroundColor,
      inputAppearance: getComputedStyle(inp).appearance,
      inputBg: getComputedStyle(inp).backgroundColor,
      inputBorder: getComputedStyle(inp).borderTopWidth,
      knobBg: after.backgroundColor, knobRadius: after.borderRadius, knobW: after.width, knobH: after.height,
      knobTransform: after.transform,
      checked: inp.checked, aria: inp.getAttribute('aria-checked'), role: inp.getAttribute('role'),
      overlap: Math.abs(ir.width - tr.width) < 4 && Math.abs(ir.height - tr.height) < 4,
    };
  }, id);

  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.check('#set-dark'); else await page.uncheck('#set-dark');
    await page.waitForTimeout(350);
    ok(await page.evaluate(() => document.documentElement.classList.contains('dark')) === (theme === 'dark'), `theme applied: ${theme}`);

    // Sample by semantic state, not by id: find the checked switch and an unchecked one.
    const ids = ['set-email-notif', 'set-digest', 'set-dark'];
    const states = {};
    for (const id of ids) states[id] = await page.isChecked('#' + id);
    const onId  = ids.find(id => states[id]);
    const offId = ids.find(id => !states[id]);
    const on  = onId ? await geom(onId) : null;
    const off = offId ? await geom(offId) : null;
    ok(states['set-dark'] === (theme === 'dark'), `${theme}: dark switch checked state matches theme`);
    ok(on && off, `${theme}: at least one ON and one OFF switch exist to sample`);
    ok(on && on.w === 42 && on.h === 24, `${theme}: ON switch track is 42x24 pill (${on && on.w}x${on && on.h})`);
    ok(on && parseInt(on.radius) >= 999, `${theme}: ON track fully rounded (${on && on.radius})`);
    ok(on && /rgb\(255, 255, 255\)/.test(on.knobBg), `${theme}: knob is white circle (${on && on.knobBg})`);
    ok(on && on.knobRadius === '50%' && on.knobW === '18px' && on.knobH === '18px', `${theme}: knob circular 18px (${on && on.knobRadius}/${on && on.knobW})`);
    ok(on && /matrix\(1, 0, 0, 1, 18, 0\)/.test(on.knobTransform), `${theme}: ON knob shifted right (${on && on.knobTransform})`);
    ok(off && /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(off.knobTransform), `${theme}: OFF knob left (${off && off.knobTransform})`);
    ok(off && off.bg !== on.bg, `${theme}: ON/OFF tracks differ (${on && on.bg} vs ${off && off.bg})`);
    ok(off && off.bg === (theme === 'dark' ? 'rgb(86, 91, 112)' : 'rgb(195, 200, 212)'), `${theme}: OFF track uses neutral gray token (${off && off.bg})`);
    ok(on && on.bg === (theme === 'dark' ? 'rgb(149, 126, 255)' : 'rgb(123, 96, 255)'), `${theme}: ON track uses accent color (${on && on.bg})`);
    // The regression itself: hidden checkbox must never paint as a block
    ok(off && off.inputAppearance === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(off.inputBg) && off.inputBorder === '0px',
       `${theme}: checkbox not painted as block (appearance=${off && off.inputAppearance}, bg=${off && off.inputBg}, border=${off && off.inputBorder})`);
    ok(off && off.overlap, `${theme}: hit-area covers whole pill (click anywhere works)`);
    ok(on && on.role === "switch" && on.aria === String(on.checked), `${theme}: role/aria-checked in sync (${on.aria}/${on.checked})`);
  }

  // Click-anywhere reliability: click the far-left edge of an OFF switch's label
  const beforeEmail = await page.isChecked('#set-email-notif');
  const box = await page.locator('#set-email-notif').boundingBox();
  await page.mouse.click(box.x + 3, box.y + box.height / 2); // thumb-side of track
  await page.waitForTimeout(250);
  ok((await page.isChecked('#set-email-notif')) !== beforeEmail, 'click at edge of switch toggles state');
  // restore
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
  await page.waitForTimeout(250);
  ok((await page.isChecked('#set-email-notif')) === beforeEmail, 'second click restores state (independent toggle)');

  // Independence: toggling digest must not move email/dark
  const snap = async () => ({ e: await page.isChecked('#set-email-notif'), d: await page.isChecked('#set-dark') });
  const s0 = await snap();
  await page.click('#set-digest'); await page.waitForTimeout(250);
  const s1 = await snap();
  ok(s1.e === s0.e && s1.d === s0.d, 'toggling one switch leaves others untouched');

  // Persistence across reload + navigation
  const wantDark = await page.isChecked('#set-dark');
  const wantDigest = await page.isChecked('#set-digest');
  await page.goto('http://localhost:3000/#/home'); await page.waitForTimeout(300);
  await page.goto('http://localhost:3000/#/settings'); await page.waitForSelector('.st-hero');
  ok((await page.isChecked('#set-dark')) === wantDark, 'dark pref survives navigation');
  await page.reload(); await page.waitForSelector('.st-hero', { timeout: 8000 }).catch(async () => {
    await page.waitForSelector('#login-email'); await page.fill('#login-email', 'parth@catlas.inc'); await page.fill('#login-password', 'password'); await page.click('#login-submit');
    await page.goto('http://localhost:3000/#/settings'); await page.waitForSelector('.st-hero');
  });
  ok((await page.isChecked('#set-dark')) === wantDark, 'dark pref survives full reload');
  ok((await page.isChecked('#set-digest')) === wantDigest, 'digest pref survives full reload');
  ok(await page.evaluate(() => document.documentElement.classList.contains('dark')) === wantDark, 'applied theme matches saved pref after reload (no flicker/mismatch)');

  // Screenshots for visual record
  await page.screenshot({ path: 'settings_toggle_final.png', fullPage: false });

  ok(errors.length === 0, 'zero console/page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

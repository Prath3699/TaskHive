const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto('file:///workspace/index.html');
  await page.waitForTimeout(400);
  async function t(name, fn) {
    try { await fn(); console.log('PASS', name); }
    catch (e) { console.log('FAIL', name, '::', String(e).split('\n')[0].slice(0,140)); }
  }
  const P = '#page';

  await t('inbox route renders', async () => {
    await page.evaluate(() => location.hash = '#/inbox'); await page.waitForTimeout(200);
    const txt = await page.locator(P).innerText();
    if (!/Inbox/i.test(txt)) throw new Error(txt.slice(0,60));
  });
  await page.evaluate(() => location.hash = '#/project/q3-plan'); await page.waitForTimeout(300);
  await t('board rows exist', async () => {
    const n = await page.locator('tbody tr').count();
    if (n < 5) throw new Error('rows=' + n);
  });
  await t('search filters board', async () => {
    await page.fill('#global-search', 'dark'); await page.waitForTimeout(250);
    const rows = await page.locator('tbody tr').count();
    if (rows !== 1) throw new Error('rows=' + rows);
    await page.fill('#global-search', ''); await page.waitForTimeout(200);
  });
  await t('new feature adds task', async () => {
    const before = await page.locator('tbody tr').count();
    await page.click('button:has-text("New feature")'); await page.waitForTimeout(250);
    await page.fill('#modal-body input[type=text]', 'ZZTestTask99');
    await page.locator('#modal-body button.btn-primary, #modal-body button[type=submit]').last().click();
    await page.waitForTimeout(350);
    const after = await page.locator('tbody tr').count();
    if (after <= before) throw new Error(`${before}->${after}`);
    if (!(await page.locator(P).innerText()).includes('ZZTestTask99')) throw new Error('name missing');
  });
  await t('cycle status', async () => {
    await page.locator('tbody tr').first().scrollIntoViewIfNeeded();
    const btn = page.locator('.progress-btn').first();
    const a = (await btn.innerText()).trim(); await btn.click(); await page.waitForTimeout(250);
    const b = (await page.locator('.progress-btn').first().innerText()).trim();
    if (a === b) throw new Error(a);
  });
  await t('rename task', async () => {
    await page.locator('tbody tr').first().hover();
    await page.locator('.edit-btn').first().click({force:true}); await page.waitForTimeout(200);
    const inp = page.locator('tbody tr input').first();
    await inp.fill('Renamed Task X'); await inp.press('Enter'); await page.waitForTimeout(250);
    if (!(await page.locator(P).innerText()).includes('Renamed Task X')) throw new Error('not renamed');
  });
  await t('sort header toggles', async () => {
    const th = page.locator('thead th').filter({ hasText: /task|name/i }).first();
    const f1 = (await page.locator('tbody tr td').nth(2).innerText()).trim();
    await th.click(); await page.waitForTimeout(250);
    const f2 = (await page.locator('tbody tr td').nth(2).innerText()).trim();
    if (f1 === f2) { // maybe asc==first; click again
      await th.click(); await page.waitForTimeout(250);
      const f3 = (await page.locator('tbody tr td').nth(2).innerText()).trim();
      if (f1 === f3) throw new Error('sort no effect: '+f1);
    }
  });
  await t('save star in properties', async () => {
    await page.locator('tbody tr').nth(2).click(); await page.waitForTimeout(250);
    const star = page.locator('[data-action="save"], .save-toggle, button:has-text("Save"), [class*="star"]').first();
    if (!(await star.count())) throw new Error('no save control');
    await star.click(); await page.waitForTimeout(200);
  });
  await t('post comment', async () => {
    const ta = page.locator('textarea[placeholder*="comment" i], #properties textarea').first();
    await ta.fill('Automated test comment');
    const btn = page.locator('button:has-text("Comment")').first();
    if (await btn.count()) await btn.click(); else await ta.press('Control+Enter');
    await page.waitForTimeout(300);
    const body = await page.locator('body').innerText();
    if (!body.includes('Automated test comment')) throw new Error('comment not shown');
  });
  await t('kanban view', async () => {
    const kan = page.locator('button:has-text("Kanban")').first();
    if (!(await kan.count())) throw new Error('no kanban toggle');
    await kan.click(); await page.waitForTimeout(300);
    const cards = await page.locator('.kanban-card, [draggable="true"]').count();
    if (!cards) throw new Error('no cards');
    await page.locator('button:has-text("Table")').first().click().catch(()=>{});
    await page.waitForTimeout(200);
  });
  await t('delete + undo toast', async () => {
    const before = await page.locator('tbody tr').count();
    await page.locator('tbody tr').first().hover();
    const del = page.locator('.del-btn, [data-action="delete"]').first();
    if (!(await del.count())) throw new Error('no delete btn');
    await del.click({force:true}); await page.waitForTimeout(250);
    const conf = page.locator('#modal-overlay:not(.hidden) button:has-text("Delete")').first();
    if (await conf.count()) { await conf.click(); await page.waitForTimeout(300); }
    const after = await page.locator('tbody tr').count();
    if (after >= before) throw new Error(`${before}->${after}`);
    const undo = page.locator('button:has-text("Undo")').first();
    if (await undo.count()) { await undo.click(); await page.waitForTimeout(300);
      const back = await page.locator('tbody tr').count();
      if (back !== before) throw new Error('undo failed: '+back);
    }
  });
  await t('export csv', async () => {
    const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
    const ex = page.locator('button:has-text("Export")').first();
    if (!(await ex.count())) throw new Error('no export');
    await ex.click();
    const d = await dl;
    if (!d) { const toastTxt = await page.locator('.toast, [class*=toast]').first().innerText().catch(()=>''); if(!/csv|export/i.test(toastTxt)) throw new Error('no download & no toast: '+toastTxt); }
  });
  await t('bulk select bar', async () => {
    const cb = page.locator('tbody input[type=checkbox]').first();
    if (!(await cb.count())) throw new Error('no checkboxes');
    await cb.check({force:true}); await page.waitForTimeout(250);
    const bulk = page.locator('[class*=bulk]').first();
    if (!(await bulk.count())) throw new Error('no bulk bar element');
    const vis = await bulk.isVisible();
    if (!vis) throw new Error('bulk bar hidden');
  });
  await t('inbox item -> task page', async () => {
    await page.evaluate(() => location.hash = '#/inbox'); await page.waitForTimeout(250);
    const item = page.locator('.inbox-item, li[data-task], [data-inbox]').first();
    if (!(await item.count())) throw new Error('no items');
    await item.click(); await page.waitForTimeout(350);
    const h = await page.evaluate(() => location.hash);
    if (!/task/.test(h)) throw new Error('hash=' + h);
  });
  await t('dark mode persists', async () => {
    await page.evaluate(() => location.hash = '#/settings'); await page.waitForTimeout(250);
    const tog = page.locator('input[type=checkbox]#pref-darkmode, [data-action="toggle-dark"], #dark-toggle, .switch input').first();
    if (!(await tog.count())) throw new Error('no toggle found');
    await tog.click({ force: true }); await page.waitForTimeout(250);
    await page.reload(); await page.waitForTimeout(400);
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark') || document.body.classList.contains('dark'));
    if (!isDark) throw new Error('not persisted');
    await tog.click({ force: true }).catch(()=>{}); await page.waitForTimeout(150);
  });
  await t('esc closes modal', async () => {
    await page.evaluate(() => location.hash = '#/project/q3-plan'); await page.waitForTimeout(250);
    await page.click('button:has-text("New feature")'); await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const hidden = await page.evaluate(() => document.getElementById('modal-overlay').classList.contains('hidden'));
    if (!hidden) throw new Error('still open');
  });
  await t('dead anchors scan', async () => {
    for (const r of ['home','inbox','projects','settings','help','calendar','roadmaps','saved','mytasks','project/q3-plan','channel/design','task/2']) {
      await page.evaluate(h => location.hash = '#/' + h, r); await page.waitForTimeout(200);
      const dead = await page.evaluate(() => [...document.querySelectorAll('a')].filter(a => { const h=a.getAttribute('href'); return (h===null||h==='#'||h==='') && !a.dataset.action; }).length);
      if (dead) throw new Error(r + ': ' + dead + ' dead anchors');
    }
  });
  await t('sidebar nav clicks', async () => {
    for (const l of ['Home','Inbox','Saved items','My tasks','Projects','Calendar','Roadmaps','Settings','Help & support']) {
      const link = page.locator('.sidebar a.nav-item').filter({ hasText: l }).first();
      if (!(await link.count())) throw new Error('missing: ' + l);
      await link.click(); await page.waitForTimeout(150);
    }
  });
  await t('channels list page + all channel links', async () => {
    const chans = await page.evaluate(() => [...document.querySelectorAll('.sidebar a.channel')].map(a => a.getAttribute('href')));
    for (const href of chans) {
      await page.evaluate(h => location.hash = h, href); await page.waitForTimeout(180);
      const txt = await page.locator(P).innerText();
      if (txt.length < 20) throw new Error(href + ' empty page');
    }
  });
  await t('send channel message', async () => {
    await page.evaluate(() => location.hash = '#/channel/design'); await page.waitForTimeout(250);
    const inp = page.locator('.chat-input input, input[placeholder*="message" i], textarea[placeholder*="message" i]').first();
    if (!(await inp.count())) throw new Error('no chat input');
    await inp.fill('Hello from test'); 
    const send = page.locator('button:has-text("Send")').first();
    if (await send.count()) await send.click(); else await inp.press('Enter');
    await page.waitForTimeout(300);
    if (!(await page.locator(P).innerText()).includes('Hello from test')) throw new Error('msg not added');
  });
  await t('new project modal creates project', async () => {
    await page.evaluate(() => location.hash = '#/projects'); await page.waitForTimeout(250);
    const before = await page.locator('.project-card, [class*=project-card]').count();
    await page.locator('button:has-text("New project")').first().click(); await page.waitForTimeout(250);
    await page.fill('#modal-body input[type=text]', 'ZZProj99');
    await page.locator('#modal-body button.btn-primary, #modal-body button[type=submit]').last().click();
    await page.waitForTimeout(350);
    const after = await page.locator('.project-card, [class*=project-card]').count();
    if (after <= before) throw new Error(`${before}->${after}`);
  });
  await t('upgrade modal plan select', async () => {
    await page.click('#upgrade-btn'); await page.waitForTimeout(250);
    const plan = page.locator('#modal-body [data-plan], #modal-body button, #modal-body label').first();
    await plan.click(); await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
  });
  await t('share modal copy link', async () => {
    await page.evaluate(() => location.hash = '#/project/q3-plan'); await page.waitForTimeout(250);
    await page.locator('button:has-text("Share")').first().click(); await page.waitForTimeout(250);
    const cp = page.locator('#modal-body button:has-text("Copy")').first();
    if (await cp.count()) await cp.click();
    await page.keyboard.press('Escape');
  });
  await t('avatar person modal', async () => {
    const av = page.locator('tbody .avatar, .assignee-cell .avatar').first();
    if (!(await av.count())) throw new Error('no avatar');
    await av.click({force:true}); await page.waitForTimeout(250);
    const open = await page.evaluate(() => !document.getElementById('modal-overlay').classList.contains('hidden'));
    if (!open) throw new Error('no modal opened');
    await page.keyboard.press('Escape');
  });
  await t('calendar event click', async () => {
    await page.evaluate(() => location.hash = '#/calendar'); await page.waitForTimeout(300);
    const ev = page.locator('.cal-event, .event-chip, [data-idx]').first();
    if (!(await ev.count())) throw new Error('no events');
    await ev.click(); await page.waitForTimeout(300);
    const h = await page.evaluate(() => location.hash);
    const open = await page.evaluate(() => !document.getElementById('modal-overlay').classList.contains('hidden'));
    if (!/task/.test(h) && !open) throw new Error('nothing happened, hash='+h);
    await page.keyboard.press('Escape').catch(()=>{});
  });
  await t('help faq expand', async () => {
    await page.evaluate(() => location.hash = '#/help'); await page.waitForTimeout(250);
    const q = page.locator('.faq-q, summary, [data-action=faq]').first();
    if (!(await q.count())) throw new Error('no faq');
    await q.click(); await page.waitForTimeout(200);
  });
  await t('notification bell', async () => {
    const bell = page.locator('#notif-bell, [data-action=inbox], .bell').first();
    if (!(await bell.count())) throw new Error('no bell');
    await bell.click(); await page.waitForTimeout(250);
    const h = await page.evaluate(() => location.hash);
    if (!/inbox/.test(h)) throw new Error('hash='+h);
  });
  console.log('\n--- JS ERRORS ---'); console.log(errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });

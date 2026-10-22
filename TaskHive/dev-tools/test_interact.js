const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto('file:///workspace/index.html');
  await page.waitForTimeout(400);

  async function t(name, fn) {
    try { await fn(); console.log('PASS', name); }
    catch (e) { console.log('FAIL', name, '::', String(e).split('\n')[0].slice(0,120)); }
  }

  // main content changes per route
  await t('route content differs', async () => {
    await page.evaluate(() => location.hash = '#/inbox'); await page.waitForTimeout(200);
    const inboxTxt = await page.locator('#content').first().innerText().catch(()=>null);
    if (!inboxTxt || !/Inbox/i.test(inboxTxt)) throw new Error('inbox content missing: ' + (inboxTxt||'').slice(0,50));
  });

  // board interactions
  await page.evaluate(() => location.hash = '#/board'); await page.waitForTimeout(300);
  await t('row click selects+properties', async () => {
    await page.locator('tbody tr').nth(1).click();
    await page.waitForTimeout(200);
    const props = await page.locator('.properties, #properties, [class*=propert]').first().innerText();
    if (!props) throw new Error('no properties panel');
  });
  await t('search filters', async () => {
    await page.fill('#global-search', 'dark'); await page.waitForTimeout(250);
    const rows = await page.locator('tbody tr').count();
    if (rows !== 1) throw new Error('expected 1 row got ' + rows);
    await page.fill('#global-search', ''); await page.waitForTimeout(200);
  });
  await t('new feature modal adds task', async () => {
    const before = await page.locator('tbody tr').count();
    await page.locator('button:has-text("New feature")').first().click();
    await page.waitForTimeout(200);
    await page.fill('#modal input[type=text], #modal textarea', 'ZZTestTask99');
    await page.locator('#modal button[type=submit], #modal .btn-primary').first().click();
    await page.waitForTimeout(300);
    const after = await page.locator('tbody tr').count();
    if (after <= before) throw new Error(`task not added ${before}->${after}`);
  });
  await t('cycle status via progress btn', async () => {
    const btn = page.locator('.progress-btn').first();
    const t1 = await btn.innerText(); await btn.click(); await page.waitForTimeout(200);
    const t2 = await page.locator('.progress-btn').first().innerText();
    if (t1.trim() === t2.trim()) throw new Error('status unchanged: '+t1);
  });
  await t('rename via edit btn', async () => {
    await page.locator('.edit-btn').first().click(); await page.waitForTimeout(150);
    const inp = page.locator('td input.task-rename, tbody input'); 
    await inp.first().fill('Renamed Task X'); await inp.first().press('Enter'); await page.waitForTimeout(200);
    const body = await page.locator('#content').innerText();
    if (!body.includes('Renamed Task X')) throw new Error('rename not applied');
  });
  await t('sort by column header', async () => {
    const first1 = await page.locator('tbody tr td:nth-child(2)').first().innerText();
    await page.locator('thead th:has-text("Task"), thead th:has-text("Name")').first().click();
    await page.waitForTimeout(200);
    const first2 = await page.locator('tbody tr td:nth-child(2)').first().innerText();
    if (first1.trim() === first2.trim()) console.log('  (note: sort produced same first row)');
  });
  await t('save star toggle', async () => {
    await page.locator('tbody tr').nth(2).click(); await page.waitForTimeout(200);
    const star = page.locator('[data-action=save], .save-toggle, [class*=star]').first();
    if (await star.count()) { await star.click(); await page.waitForTimeout(150); }
    else throw new Error('no save/star control found in properties');
  });
  await t('comment post', async () => {
    const ta = page.locator('#properties textarea, .properties textarea, [placeholder*="comment" i]').first();
    if (!(await ta.count())) throw new Error('no comment box');
    await ta.fill('Automated test comment'); 
    await page.locator('#properties button:has-text("Comment"), .properties button[type=submit], button:has-text("Post")').first().click().catch(async ()=>{ await ta.press('Enter'); });
    await page.waitForTimeout(250);
    const props = await page.locator('#properties, .properties').first().innerText();
    if (!props.includes('Automated test comment')) throw new Error('comment not posted');
  });
  await t('kanban view switch + drag exists', async () => {
    const kan = page.locator('button:has-text("Kanban"), [data-view=kanban]').first();
    if (!(await kan.count())) throw new Error('no kanban toggle');
    await kan.click(); await page.waitForTimeout(250);
    const cards = await page.locator('.kanban-card, [draggable=true]').count();
    if (!cards) throw new Error('no kanban cards');
  });
  await t('delete task + undo', async () => {
    await page.locator('button:has-text("Table"), [data-view=table]').first().click().catch(()=>{});
    await page.waitForTimeout(200);
    const before = await page.locator('tbody tr').count();
    const del = page.locator('.del-btn, [data-action=delete]').first();
    if (!(await del.count())) throw new Error('no delete button');
    await del.click(); await page.waitForTimeout(200);
    // confirm dialog?
    const confirmBtn = page.locator('#modal button:has-text("Delete"), #modal .btn-danger').first();
    if (await confirmBtn.count()) { await confirmBtn.click(); await page.waitForTimeout(250); }
    const after = await page.locator('tbody tr').count();
    if (after >= before) throw new Error(`not deleted ${before}->${after}`);
    const undo = page.locator('button:has-text("Undo")').first();
    if (await undo.count()) { await undo.click(); await page.waitForTimeout(250); }
  });
  await t('export csv button', async () => {
    const ex = page.locator('button:has-text("Export"), [data-action=export]').first();
    if (!(await ex.count())) throw new Error('no export button');
    await ex.click(); await page.waitForTimeout(300);
  });
  await t('bulk select + delete bar', async () => {
    const cb = page.locator('tbody input[type=checkbox]').first();
    if (!(await cb.count())) throw new Error('no checkboxes');
    await cb.check(); await page.waitForTimeout(200);
    const bar = await page.locator('.bulk-bar, [class*=bulk]').first().isVisible().catch(()=>false);
    if (!bar) throw new Error('bulk bar not visible');
  });

  // inbox
  await page.evaluate(() => location.hash = '#/inbox'); await page.waitForTimeout(250);
  await t('inbox item navigates', async () => {
    const item = page.locator('.inbox-item, [data-action=read]').first();
    if (!(await item.count())) throw new Error('no inbox items');
    await item.click(); await page.waitForTimeout(300);
    const h = await page.evaluate(() => location.hash);
    if (!/task/.test(h)) throw new Error('did not navigate to task, hash=' + h);
  });

  // dark mode persistence
  await t('dark mode persists reload', async () => {
    await page.evaluate(() => location.hash = '#/settings'); await page.waitForTimeout(250);
    const tog = page.locator('#pref-darkmode, [data-action=toggle-dark], input#dark-mode, .switch input').first();
    if (!(await tog.count())) throw new Error('no dark toggle on settings');
    await tog.click({force:true}).catch(async()=>{ await page.evaluate(()=>document.querySelector('#pref-darkmode,[data-action=toggle-dark],.switch input').click()); });
    await page.waitForTimeout(250);
    await page.reload(); await page.waitForTimeout(400);
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark') || document.body.classList.contains('dark'));
    if (!isDark) throw new Error('dark mode did not persist');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
  });

  // keyboard shortcuts
  await t('esc closes modal', async () => {
    await page.locator('button:has-text("New feature")').first().click(); await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const vis = await page.locator('#modal-overlay').isVisible().catch(()=>false);
    const style = await page.evaluate(() => { const o=document.getElementById('modal-overlay'); return o ? getComputedStyle(o).display : 'none'; });
    if (vis && style !== 'none') throw new Error('modal still open');
  });

  // broken links check: all anchors with href="#" or empty
  await t('no dead href=# links', async () => {
    for (const r of ['#/','#/inbox','#/projects','#/settings','#/help','#/channels','#/calendar','#/roadmaps','#/saved','#/mytasks','#/board']) {
      await page.evaluate(h => location.hash = h, r); await page.waitForTimeout(200);
      const dead = await page.evaluate(() => [...document.querySelectorAll('a')].filter(a => (a.getAttribute('href')===null||a.getAttribute('href')==='#'||a.getAttribute('href')==='') && !a.onclick && !a.dataset.action).length);
      if (dead > 0) throw new Error(r + ' has ' + dead + ' dead anchors');
    }
  });

  // buttons with no handler: elements with class btn/button that do nothing — sample click test
  await t('sidebar nav all work', async () => {
    await page.evaluate(() => location.hash = '#/'); await page.waitForTimeout(200);
    const labels = ['Home','Inbox','Saved items','My tasks','Projects','Calendar','Roadmaps','Settings'];
    for (const l of labels) {
      const link = page.locator('.sidebar >> text=' + l).first();
      if (await link.count()) { await link.click(); await page.waitForTimeout(150); }
      else throw new Error('missing sidebar link: ' + l);
    }
  });

  console.log('\n--- JS ERRORS ---');
  console.log(errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });

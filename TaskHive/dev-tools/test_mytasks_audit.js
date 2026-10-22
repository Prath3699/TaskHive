const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const pass = [], fail = [];
  const ok = (c, msg) => (c ? pass : fail).push(msg);

  await page.goto('http://localhost:8090/index.html#/mytasks');
  await page.waitForSelector('.mt-hero');

  // hero + ring
  ok(await page.locator('.mt-ring-num').count() === 1, 'hero progress ring renders');

  // status pills: All + 4 statuses
  const pillCount = await page.locator('.mt-pill').count();
  ok(pillCount === 5, `status pills render (${pillCount})`);

  // click "Ongoing" pill -> filter applies
  await page.locator('.mt-pill', { hasText: 'Ongoing' }).first().click();
  await page.waitForTimeout(150);
  const activePill = await page.locator('.mt-pill.active').innerText();
  ok(activePill.includes('Ongoing'), 'status pill filters (active state)');
  const rowsAfterPill = await page.locator('.task-table tbody tr').count();
  const ongoingVisible = await page.locator('.task-table tbody .progress-cell').allInnerTexts();
  ok(ongoingVisible.every(t => t.trim() === 'Ongoing'), 'only Ongoing rows shown after pill filter');

  // chip appears + removes filter
  ok(await page.locator('.mt-chip[data-mtchip="status"]').count() === 1, 'filter chip shows for status');
  await page.locator('.mt-chip[data-mtchip="status"]').click();
  await page.waitForTimeout(150);
  ok(await page.locator('.mt-pill.active').innerText().then(t => t.startsWith('All')), 'chip ✕ removes status filter');

  // toolbar search
  await page.fill('#mt-search', 'dark');
  await page.waitForTimeout(200);
  const srchRows = await page.locator('.task-table tbody tr').count();
  ok(srchRows === 1, `search filters rows (${srchRows} for "dark")`);
  await page.fill('#mt-search', 'zzzz');
  await page.waitForTimeout(200);
  ok(await page.locator('.empty-state').count() >= 1, 'no-results empty state shows');
  await page.locator('#clear-mytasks-filter').last().click();
  await page.waitForTimeout(150);
  ok((await page.inputValue('#mt-search')) === '', 'clear button resets search');

  // column menu: open Progress header menu, sort A->Z
  await page.locator('.th-btn[data-menu="col:progress"]').first().click();
  ok(await page.locator('.col-menu').count() === 1, 'column menu opens on My Tasks');
  await page.locator('.col-menu [data-menuact^="sort:progress"]').first().click();
  await page.waitForTimeout(150);
  ok(!await page.locator('.col-menu').count(), 'menu closes after sort');
  const names = await page.locator('.task-table tbody .feature-name').allInnerTexts();
  ok(names.length > 0, 'rows still render after sorting');

  // urgency filter via menu
  await page.locator('.th-btn[data-menu="col:urgency"]').first().click();
  await page.locator('.col-menu [data-menuact^="setf:urgency"]').first().click();
  await page.waitForTimeout(150);
  ok(await page.locator('.mt-chip[data-mtchip="urgency"]').count() === 1, 'urgency filter chip appears');
  const urg = await page.locator('.task-table tbody .urgency-cell').allInnerTexts();
  ok(urg.length && urg.every(u => u.trim() === 'Critical'), 'urgency filter applied (all Critical)');
  await page.locator('.mt-chip[data-mtchip="urgency"]').click();

  // view toggles
  await page.locator('[data-mtview="table"]').click();
  await page.waitForTimeout(150);
  ok(await page.locator('.task-table').count() >= 1, 'Table view renders');
  await page.locator('[data-mtview="board"]').click();
  await page.waitForTimeout(200);
  ok(await page.locator('.kanban .kb-card').count() > 0, 'Board (kanban) view renders cards');
  // kanban card click navigates to task detail
  await page.locator('.kb-card').first().click();
  await page.waitForTimeout(200);
  ok(page.url().includes('#/task/'), 'kanban card click opens task detail');
  await page.goBack(); await page.waitForTimeout(200);
  await page.locator('[data-mtview="grouped"]').click();
  await page.waitForTimeout(150);
  ok(await page.locator('.mtask-group').count() > 0, 'Grouped view renders groups');

  // CSV export button exists & clickable
  ok(await page.locator('[data-export]').count() === 1, 'CSV export button present');

  // progress badge click cycles status + undo toast works
  const firstRow = page.locator('.task-table tbody tr').first();
  const beforeTxt = await firstRow.locator('.progress-cell').innerText();
  await firstRow.locator('.progress-cell').click();
  await page.waitForTimeout(200);
  const afterTxt = await page.locator('.task-table tbody tr').first().locator('.progress-cell').innerText();
  ok(beforeTxt !== afterTxt, `progress badge click updates row live (${beforeTxt.trim()} → ${afterTxt.trim()})`);
  ok(await page.locator('#undo-btn').count() === 1, 'undo button in toast');
  await page.locator('#undo-btn').click();
  await page.waitForTimeout(200);
  const undone = await page.locator('.task-table tbody tr').first().locator('.progress-cell').innerText();
  ok(undone.trim() === beforeTxt.trim(), 'undo restores previous status');

  // urgency badge click cycles
  const ubefore = await page.locator('.task-table tbody tr').first().locator('.urgency-cell').innerText();
  await page.locator('.task-table tbody tr').first().locator('.urgency-cell').click();
  await page.waitForTimeout(200);
  const uafter = await page.locator('.task-table tbody tr').first().locator('.urgency-cell').innerText();
  ok(ubefore !== uafter, `urgency badge click cycles (${ubefore.trim()} → ${uafter.trim()})`);
  await page.locator('#undo-btn').click(); await page.waitForTimeout(150);

  // rename via ✎ button
  await page.locator('.task-table tbody tr').first().locator('.edit-btn').click();
  await page.waitForTimeout(100);
  ok(await page.locator('.rename-input').count() === 1, 'rename input opens');
  await page.fill('.rename-input', 'Renamed By Test');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  ok((await page.locator('.task-table tbody tr').first().locator('.feature-name').innerText()) === 'Renamed By Test', 'rename commits');
  await page.locator('#undo-btn').click(); await page.waitForTimeout(150);

  // delete with confirm + undo
  const rowCountBefore = await page.locator('.task-table tbody tr').count();
  await page.locator('.task-table tbody tr').first().locator('.del-btn').click();
  await page.waitForTimeout(150);
  ok(await page.locator('#confirm-delete').count() === 1, 'delete confirm modal opens');
  await page.locator('#confirm-delete').click();
  await page.waitForTimeout(200);
  ok((await page.locator('.task-table tbody tr').count()) < rowCountBefore, 'row deleted');
  await page.locator('#undo-btn').click(); await page.waitForTimeout(200);
  ok((await page.locator('.task-table tbody tr').count()) === rowCountBefore, 'undo restores deleted row');

  // bulk select bar
  await page.locator('.row-check').first().check();
  await page.waitForTimeout(100);
  ok(await page.locator('.bulkbar #bulk-delete').count() === 1, 'bulk bar appears on checkbox');
  await page.locator('.bulkbar #bulk-delete').click(); await page.waitForTimeout(150);
  await page.locator('#undo-btn').click(); await page.waitForTimeout(150);

  // avatar person modal
  await page.locator('.link-avatar').first().click();
  await page.waitForTimeout(150);
  ok(await page.locator('#modal-overlay:not(.hidden)').count() === 1, 'avatar opens person modal');
  await page.locator('#modal-close').click();

  // row click -> task detail (no properties panel on mytasks)
  await page.locator('.task-table tbody tr').first().click();
  await page.waitForTimeout(200);
  ok(page.url().includes('#/task/') || await page.locator('.properties').count() > 0, 'row click opens task detail');

  console.log('PASS:\n - ' + pass.join('\n - '));
  console.log('FAIL:\n - ' + (fail.join('\n - ') || 'none'));
  console.log('JS ERRORS:\n - ' + (errors.join('\n - ') || 'none'));
  await browser.close();
})();

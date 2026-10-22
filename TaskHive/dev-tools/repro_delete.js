const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await p.goto('http://localhost:8090/index.html#/mytasks');
  await p.waitForSelector('.mt-hero');

  // reproduce audit steps up to delete
  await p.locator('.task-table tbody tr').first().locator('.progress-cell').click();
  await p.waitForTimeout(200);
  await p.locator('#undo-btn').click(); await p.waitForTimeout(150);

  await p.locator('.task-table tbody tr').first().locator('.urgency-cell').click();
  await p.waitForTimeout(200);
  await p.locator('#undo-btn').click(); await p.waitForTimeout(150);

  await p.locator('.task-table tbody tr').first().locator('.edit-btn').click();
  await p.waitForTimeout(100);
  console.log('rename inputs count:', await p.locator('.rename-input').count());
  await p.fill('.rename-input', 'Renamed By Test');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(200);
  console.log('renamed?', await p.locator('.task-table tbody tr').first().locator('.feature-name').innerText());
  await p.locator('#undo-btn').click(); await p.waitForTimeout(150);

  // now the delete step that failed in the audit run
  const delBtn = p.locator('.task-table tbody tr').first().locator('.del-btn');
  console.log('del-btn count:', await delBtn.count());
  try {
    await delBtn.click({ timeout: 3000 });
    console.log('clicked del-btn ok');
  } catch (e) {
    console.log('CLICK FAILED:', e.message.split('\n')[0]);
    // find what intercepts
    const info = await p.evaluate(() => {
      const btn = document.querySelector('.task-table tbody tr .del-btn');
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
      return { rect: [r.x, r.y, r.width, r.height],
               interceptedBy: at ? at.className + '|' + at.tagName : null,
               same: at === btn };
    });
    console.log('hit-test:', JSON.stringify(info));
  }
  await p.waitForTimeout(300);
  console.log('confirm-delete present:', await p.locator('#confirm-delete').count());
  console.log('modal open:', await p.locator('#modal-overlay:not(.hidden)').count());
  console.log('JS ERRORS:', errs);
  await b.close();
})();

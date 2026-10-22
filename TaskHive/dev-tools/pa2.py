from playwright.sync_api import sync_playwright
EXE='/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE)
    page = b.new_context().new_page()
    page.goto('http://localhost:3000/')
    page.wait_for_selector('#login-email'); page.fill('#login-email','parth@catlas.inc')
    page.fill('#login-password','password'); page.click('#login-submit'); page.wait_for_timeout(1200)
    page.goto('http://localhost:3000/#/settings'); page.wait_for_selector('.st-hero')
    print(page.evaluate("""() => {
        const cb=document.getElementById('set-digest'); cb.checked=true;
        const t=document.querySelector('#set-digest + .toggle-track');
        const rules=[];
        for (const sheet of document.styleSheets) { try {
          for (const r of sheet.cssRules) if (r.selectorText && r.selectorText.includes('toggle')) rules.push(r.cssText.slice(0,160));
        } catch(e){} }
        return { matched: t.matches('#set-digest:checked + .toggle-track'), rules }; }"""))
    b.close()

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
        return { accentVar: getComputedStyle(document.documentElement).getPropertyValue('--accent'),
                 trackBg: getComputedStyle(t).backgroundColor }; }"""))
    b.close()

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
    page = b.new_context(viewport={'width':1280,'height':900}).new_page()
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)

    page.goto('http://localhost:3000/')
    page.wait_for_selector('#login-email', timeout=8000)
    page.fill('#login-email','parth@catlas.inc')
    page.fill('#login-password','password')
    page.click('#login-submit')
    page.wait_for_timeout(1500)
    page.goto('http://localhost:3000/#/settings')
    page.wait_for_selector('.st-hero', timeout=8000)

    for i in ['set-email-notif','set-digest','set-dark']:
        print('initial', i, page.is_checked('#'+i))

    # click the visible track (where a user would click)
    page.click('#set-email-notif + .toggle-track')
    page.wait_for_timeout(300)
    print('after track-click email:', page.is_checked('#set-email-notif'))

    # click label wrapper area of digest
    page.click('.switch-row:has(#set-digest) .toggle')
    page.wait_for_timeout(300)
    print('after label-click digest:', page.is_checked('#set-digest'))

    # dark toggle via track click; check theme + checkbox + description text
    page.click('#set-dark + .toggle-track')
    page.wait_for_timeout(400)
    print('dark class:', page.evaluate("document.documentElement.classList.contains('dark')"))
    print('set-dark checked:', page.is_checked('#set-dark'))
    print('desc text:', page.evaluate("""() => {
        const cb=document.getElementById('set-dark');
        return cb?cb.closest('.switch-row').querySelector('p.muted').textContent:'NO-CB';}"""))

    # navigate away and back — do checkboxes reflect state?
    page.goto('http://localhost:3000/#/home'); page.wait_for_timeout(600)
    page.goto('http://localhost:3000/#/settings'); page.wait_for_selector('.st-hero', timeout=5000)
    for i in ['set-email-notif','set-digest','set-dark']:
        print('after-nav-back', i, page.is_checked('#'+i))

    # reload — server persistence
    page.reload(); page.wait_for_selector('.st-hero', timeout=8000)
    for i in ['set-email-notif','set-digest','set-dark']:
        print('after-reload', i, page.is_checked('#'+i))
    print('dark after reload:', page.evaluate("document.documentElement.classList.contains('dark')"))

    # computed styles
    print('track bg (unchecked):', page.evaluate("getComputedStyle(document.querySelector('#set-dark:not(:checked) ~ .toggle-track, #set-dark + .toggle-track')).backgroundColor"))
    print('ERRORS:', errors)
    b.close()

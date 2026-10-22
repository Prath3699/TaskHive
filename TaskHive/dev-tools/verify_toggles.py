from playwright.sync_api import sync_playwright
EXE='/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
P=F=0
def chk(name, cond):
    global P,F
    if cond: P+=1; print('PASS', name)
    else: F+=1; print('FAIL', name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE)
    ctx = b.new_context(viewport={'width':1280,'height':900})
    page = ctx.new_page()
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

    ids=['set-email-notif','set-digest','set-dark']
    # A. clicking anywhere on the switch (label wrapper) toggles it
    before = {i: page.is_checked('#'+i) for i in ids}
    for i in ids:
        page.click(f'.switch-row:has(#{i}) .toggle', force=True)  # click center of switch
        page.wait_for_timeout(250)
        chk(f'click-on-switch toggles {i}', page.is_checked('#'+i) != before[i])
        chk(f'{i} state independent of others', all(page.is_checked('#'+j)==before[j] for j in ids if j!=i))
        # click again to restore
        page.click(f'.switch-row:has(#{i}) .toggle', force=True)
        page.wait_for_timeout(250)
    chk('restore round-trip', all(page.is_checked('#'+i)==before[i] for i in ids))

    # B. dark mode: theme flips immediately without refresh + desc text updates
    was_dark = page.evaluate("document.documentElement.classList.contains('dark')")
    page.click('.switch-row:has(#set-dark) .toggle', force=True)
    page.wait_for_timeout(400)
    now_dark = page.evaluate("document.documentElement.classList.contains('dark')")
    chk('dark toggle flips theme instantly', now_dark != was_dark)
    desc = page.text_content('.switch-row:has(#set-dark) p.muted')
    chk('desc reflects new theme', ('dark theme' in desc) == now_dark)
    chk('checkbox matches theme', page.is_checked('#set-dark') == now_dark)
    aria = page.get_attribute('#set-dark','aria-checked')
    chk('aria-checked synced', aria == str(now_dark).lower())
    # flip back
    page.click('.switch-row:has(#set-dark) .toggle', force=True); page.wait_for_timeout(350)

    # C. keyboard: Tab focus + Space + Enter
    page.focus('#set-email-notif')
    st = page.is_checked('#set-email-notif')
    page.keyboard.press('Space'); page.wait_for_timeout(250)
    chk('keyboard Space toggles', page.is_checked('#set-email-notif') != st)
    page.keyboard.press('Enter'); page.wait_for_timeout(250)
    chk('keyboard Enter toggles back', page.is_checked('#set-email-notif') == st)

    # D. persistence: change email pref, navigate away & back, reload
    st_email = page.is_checked('#set-email-notif')
    page.click('.switch-row:has(#set-email-notif) .toggle', force=True); page.wait_for_timeout(400)
    page.goto('http://localhost:3000/#/home'); page.wait_for_timeout(500)
    page.goto('http://localhost:3000/#/settings'); page.wait_for_selector('.st-hero', timeout=5000)
    chk('state kept after nav away/back', page.is_checked('#set-email-notif') != st_email)
    page.reload(); page.wait_for_selector('.st-hero', timeout=8000)
    chk('state persisted across reload (server)', page.is_checked('#set-email-notif') != st_email)
    # restore
    page.click('.switch-row:has(#set-email-notif) .toggle', force=True); page.wait_for_timeout(400)

    # E. visual consistency in BOTH themes
    for dark_mode in [False, True]:
        page.evaluate(f"document.documentElement.classList.toggle('dark', {str(dark_mode).lower()}); void document.body.offsetHeight")
        page.wait_for_timeout(400)  # let the .18s background transition settle before sampling
        off_bg = page.evaluate("getComputedStyle(document.querySelector('#set-digest + .toggle-track')).backgroundColor")
        accent = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent')").strip()
        def hex2rgb(h):
            h=h.lstrip('#'); return f"rgb({int(h[0:2],16)}, {int(h[2:4],16)}, {int(h[4:6],16)})" if len(h)==6 else h
        want_accent = hex2rgb(accent)
        page.check('#set-digest', force=True); page.wait_for_timeout(350)
        on_bg = page.evaluate("getComputedStyle(document.querySelector('#set-digest:checked + .toggle-track')).backgroundColor")
        thumb = page.evaluate("""() => { const t=document.querySelector('#set-digest:checked + .toggle-track');
            const cs=getComputedStyle(t,'::after'); return {bg:cs.backgroundColor, w:cs.width}; }""")
        page.uncheck('#set-digest', force=True); page.wait_for_timeout(200)
        chk(f'track OFF gray distinct from ON accent ({"dark" if dark_mode else "light"} mode)', off_bg != on_bg)
        chk(f'ON uses accent color ({"dark" if dark_mode else "light"})', on_bg == want_accent)
        chk(f'thumb white circle ({"dark" if dark_mode else "light"})', thumb['bg']=='rgb(255, 255, 255)' and 'px' in thumb['w'])
    # ensure digest ended unchecked & restored server state
    page.wait_for_timeout(300)

    # F. responsive alignment at mobile width
    page.set_viewport_size({'width':390,'height':844})
    page.goto('http://localhost:3000/#/settings'); page.wait_for_selector('.st-hero', timeout=8000)
    align = page.evaluate("""() => {
        const row=document.querySelector('.switch-row:has(#set-dark)');
        const r=row.getBoundingClientRect(), t=row.querySelector('.toggle').getBoundingClientRect();
        return t.right <= r.right+2 && Math.abs((t.top+t.height/2)-(r.top+r.height/2)) < 24; }""")
    chk('mobile: switch right-aligned & vertically centered', align)

    # G. cursor pointer + transitions present
    style = page.evaluate("""() => { const l=document.querySelector('.toggle'); const cs=getComputedStyle(l);
        const tr=getComputedStyle(document.querySelector('.toggle-track'));
        return {cursor:cs.cursor, trans:tr.transitionProperty}; }""")
    chk('pointer cursor', style['cursor']=='pointer')
    chk('smooth transition', 'background' in style['trans'])

    chk('zero console/page errors', len(errors)==0)
    if errors: print('ERRORS:', errors[:5])
    b.close()
print(f'\n{P} passed, {F} failed')
exit(1 if F else 0)

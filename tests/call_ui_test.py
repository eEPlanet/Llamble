# A real one-on-one call in two browsers (needs a livekit-server on 127.0.0.1:7880, keys devkey /
# devsecretdevsecretdevsecretdevsecret, and Llamble serving client/dist): it rings, both hear each
# other, the in-call strip shows on other screens, and hanging up ends it for both.
# Usage: call_ui_test.py http://127.0.0.1:8099
import sys, requests, time
from playwright.sync_api import sync_playwright
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r):
    assert r.status_code < 300, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
S = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "sam", "password": "demo-pass-123"}))
dm = ok(requests.post(B + "/api/users/@me/channels", headers=H(M), json={"recipient_id": S["user"]["id"]}))["id"]
def audio(pg):  # remote voices attached and playing
    return pg.evaluate("[...document.querySelectorAll('audio')].filter(a => a.srcObject && !a.paused).length")
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"])
    pages = {}
    con = []
    for who, tok in [("maya", M), ("sam", S["token"])]:
        ctx = b.new_context(viewport={"width": 1280, "height": 760})
        pg = ctx.new_page(); pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{tok}')"); pg.goto(B + "/"); pg.wait_for_timeout(2000)
        pages[who] = pg
        pg.on("console", lambda msg, who=who: con.append(f"{who}: {msg.type}: {msg.text[:200]}"))
    m, sm = pages["maya"], pages["sam"]
    m.click("button[title^='Talk']"); m.click(".dm-row:has-text('sam')"); m.wait_for_timeout(500)
    t0 = time.time(); m.click("button[title='Call sam']")
    for i in range(30):
        time.sleep(0.5)
        if sm.locator(".call-btn.accept").count(): break
    m.screenshot(path="/tmp/call-maya-wait.png")
    logs = []
    if not sm.locator(".call-btn.accept").count():
        print("\n".join(con[-25:])); raise SystemExit("sam never rang"); print("rang sam after %.1fs" % (time.time() - t0))
    sm.click(".call-btn.accept"); t1 = time.time()
    for i in range(40):
        a, b2 = audio(m), audio(sm)
        if a and b2: print("both hear each other %.1fs after answering" % (time.time() - t1)); break
        time.sleep(0.5)
    else: print("NOT CONNECTED after 20s: maya hears", audio(m), "sam hears", audio(sm))
    m.screenshot(path="/tmp/call-maya.png"); sm.screenshot(path="/tmp/call-sam.png")
    # sam puts the call screen away: the strip shows on his screen, on Home and in Settings
    sm.click(".dial-back"); sm.wait_for_timeout(500); sm.screenshot(path="/tmp/strip-sam-chat.png")
    sm.click("button.guild-logo"); sm.wait_for_timeout(500); sm.screenshot(path="/tmp/strip-sam-home.png")
    # sam hangs up from the strip: maya's one-on-one call ends too
    sm.click(".call-strip-end"); time.sleep(3)
    print("maya still in a call after sam hung up:", m.locator(".call-screen, .call-strip").count() > 0)
    b.close()

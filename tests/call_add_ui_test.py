# Three people in three browsers (needs livekit-server on 127.0.0.1:7880, see call_ui_test.py):
# maya calls sam, adds riley; the call moves to a new party all three hear each other in, and
# when it ends maya is asked to keep that party or delete it.
import sys, requests, time
from playwright.sync_api import sync_playwright
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r):
    assert r.status_code < 300, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 9}))["code"]
P = {"maya": (M, None)}
for u in ("sam", "riley"):
    r = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": u, "password": "demo-pass-123"}))
    P[u] = (r["token"], r["user"]["id"])
    ok(requests.post(B + "/api/friends", headers=H(M), json={"username": u})); ok(requests.post(B + "/api/friends", headers=H(r["token"]), json={"username": "maya"}))
def heard(pg): return pg.evaluate("[...document.querySelectorAll('audio')].filter(a => a.srcObject && !a.paused).length")
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns", "--autoplay-policy=no-user-gesture-required"])
    pg = {}
    for u in ("maya", "sam", "riley"):
        c = b.new_context(viewport={"width": 1100, "height": 720}); x = c.new_page()
        x.goto(B + "/"); x.evaluate(f"localStorage.setItem('llamble.token', '{P[u][0]}')"); x.goto(B + "/"); x.wait_for_timeout(2000); pg[u] = x
    m, sm, ri = pg["maya"], pg["sam"], pg["riley"]
    m.click("button[title^='Friends']"); m.click(".dm-row:has-text('sam')"); m.click("button.btn.green:has-text('Call')")
    sm.wait_for_selector(".call-btn.accept", timeout=15000); sm.click(".call-btn.accept")
    for i in range(20):
        if heard(m) and heard(sm): break
        time.sleep(0.5)
    print("maya & sam connected:", heard(m), heard(sm))
    m.click(".dial-btn:has-text('Add')"); m.wait_for_timeout(500)
    m.click(".dial-add-row:has-text('riley')"); m.click(".dial-sheet button:has-text('Call')")
    ri.wait_for_selector(".call-btn.accept", timeout=15000); ri.screenshot(path="/tmp/shots/add3-riley-ring.png"); ri.click(".call-btn.accept")
    for i in range(30):
        h = (heard(m), heard(sm), heard(ri))
        if all(x >= 2 for x in h): break
        time.sleep(0.5)
    print("three-way, voices each hears (maya, sam, riley):", h)
    m.screenshot(path="/tmp/shots/add3-maya-call.png")
    # sam writes nothing; everyone hangs up -> maya is asked to keep it
    for x in (sm, ri): x.click(".dial-end, .call-btn.end, button[title='Hang up']", timeout=5000)
    time.sleep(2.5)
    m.screenshot(path="/tmp/shots/add3-maya-after.png")
    print("maya asked to keep it:", m.locator("text=Keep it as a party?").count() > 0 or m.locator("text=Keep party").count() > 0)
    b.close()

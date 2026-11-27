# Show spaces in the app with the real voice server: off air with a scheduled show; the host
# goes backstage, then live with the camera on; someone in the audience watches, raises a
# hand, gets brought up and turns their camera on; the director picks "Everyone"; ending the
# show sends the audience home. Saves screenshots (PC and phone).
import sys, os, json, time, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None

s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Lake House"}))
M, gid = s["token"], s["guild_id"]
ok(requests.patch(B + "/api/users/@me", headers=H(M), json={"display_name": "Maya"}))
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
T = {}
for n in ["sam", "theo", "lena"]:
    T[n] = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": n, "password": "pass-word-123"}))["token"]
    ok(requests.patch(B + "/api/users/@me", headers=H(T[n]), json={"display_name": n.title()}))
sam_id = ok(requests.get(B + "/api/users/@me", headers=H(T["sam"])))["id"]
ok(requests.put(B + "/api/admin/settings", headers=H(M), json={"lan_ip": "127.0.0.1"}))
for _ in range(120):
    if ok(requests.get(B + "/api/admin/settings", headers=H(M)))["voice"]["state"] == "running": break
    time.sleep(0.5)
cid = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "Friday Night Live", "kind": "stage"}))["id"]
ok(requests.post(f"{B}/api/channels/{cid}/stage/events", headers=H(M), json={"title": "Friday Night Live: lake stories", "description": "Bring a story from the summer.", "starts_at": int(time.time() * 1000) + 3600_000}))

def connected(pg):
    for _ in range(40):
        if pg.evaluate("() => window.llambleDebug.voice().status") == "connected": return True
        pg.wait_for_timeout(500)
    return False

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    def page(tok, w=1280, h=860, phone=False):
        ctx = b.new_context(viewport={"width": w, "height": h}, has_touch=phone, is_mobile=phone, permissions=["microphone", "camera"])
        pg = ctx.new_page(); pg.goto(B + "/")
        pg.evaluate("t=>{localStorage.setItem('llamble.token',t);localStorage.setItem('llamble.server',location.origin)}", tok)
        pg.goto(B + "/"); pg.wait_for_timeout(2500)
        return pg
    def open_space(pg, phone=False):
        if phone and "m-nav" not in (pg.locator(".shell").get_attribute("class") or ""):
            pg.click(".m-menu"); pg.wait_for_timeout(300)
        pg.click(f".guild-btn[data-gid='{gid}']"); pg.wait_for_timeout(500)
        pg.click(".channel:has-text('Friday Night Live')"); pg.wait_for_timeout(1000)

    # the audience before the show: off air, the next show, Interested
    sam = page(T["sam"])
    open_space(sam)
    assert sam.locator(".stage-offair >> text=Off air").count() or sam.locator(".stage-offair >> text=Starting soon").count()
    sam.locator(".stage-event button:has-text('interested')").click(); sam.wait_for_timeout(800)
    assert sam.locator(".stage-event button:has-text('Interested')").count()
    sam.locator(".chat-header button:has-text('Follow')").click(); sam.wait_for_timeout(600)
    sam.screenshot(path=f"{OUT}/show-offair.png")
    assert sam.locator(".stage-offair button:has-text('backstage')").count() == 0, "the audience can't go backstage"

    # the host: backstage, camera on, go live
    m = page(M)
    open_space(m)
    m.locator(".stage-offair button:has-text('Go backstage')").click()
    assert connected(m), "host never connected"
    m.wait_for_timeout(800)
    assert m.locator(".stage-backstage").count()
    m.locator(".stage-controls button[title='Camera']").click(); m.wait_for_timeout(1500)
    m.locator(".stage-golive input").fill("Friday Night Live: lake stories")
    m.locator(".stage-golive button:has-text('Go live')").click(); m.wait_for_timeout(1200)
    assert m.locator(".chat-header .stage-live").count(), "LIVE in the header"

    # the audience: LIVE in the list, watch, raise a hand
    sam.wait_for_timeout(800)
    assert sam.locator(".channel:has-text('Friday Night Live') .stage-live").count(), "LIVE in the list"
    sam.locator(".stage-offair button:has-text('Watch the show')").click()
    assert connected(sam), "audience never connected"
    sam.wait_for_timeout(1500)
    assert sam.locator(".stage-main video").count() >= 1, "the audience sees the host's camera"
    assert sam.locator(".stage-controls button[title='Camera']").count() == 0, "the audience has no camera button"
    theo = page(T["theo"]); open_space(theo); theo.locator(".stage-offair button:has-text('Watch the show')").click(); connected(theo)
    sam.locator(".stage-controls button:has-text('Raise hand')").click(); sam.wait_for_timeout(800)

    # the host brings Sam up
    m.locator(".stage-controls button:has-text('Hands')").click(); m.wait_for_timeout(500)
    assert m.locator(".stage-hand-row:has-text('Sam')").count()
    m.screenshot(path=f"{OUT}/show-host-hands.png")
    m.locator(".stage-hand-row button:has-text('Bring up')").click(); m.wait_for_timeout(2500)
    assert sam.locator(".stage-controls button[title='Camera']").count(), "Sam is on stage"
    sam.locator(".stage-controls button[title='Camera']").click(); sam.wait_for_timeout(2500)
    # the director: everyone
    m.locator(".stage-controls button:has-text('Director')").click(); m.wait_for_timeout(300)
    m.locator(".stage-panel button:has-text('Everyone')").click(); m.wait_for_timeout(2500)
    assert theo.locator(".stage-main.grid .tile").count() == 2, "the audience sees both on stage"
    theo.screenshot(path=f"{OUT}/show-audience-grid.png")
    m.screenshot(path=f"{OUT}/show-host.png")
    # the director: main shot + faces, Sam on the main shot
    m.locator(".stage-panel button:has-text('Main shot')").click(); m.wait_for_timeout(600)
    m.locator(".stage-face:has-text('Sam')").click(); m.wait_for_timeout(300)
    m.locator(".ctx-menu >> text=Put on the main shot").click(); m.wait_for_timeout(2000)
    theo.screenshot(path=f"{OUT}/show-audience-main.png")

    # a phone in the audience
    lena = page(T["lena"], 412, 900, True)
    open_space(lena, True)
    lena.locator(".stage-offair button:has-text('Watch the show')").click(); connected(lena)
    lena.wait_for_timeout(2500)
    lena.screenshot(path=f"{OUT}/show-phone.png")

    # ending the show sends the audience home
    m.locator(".stage-controls button:has-text('End show')").click(); m.wait_for_timeout(2500)
    assert theo.evaluate("() => window.llambleDebug.voice().channelId") is None, "the audience goes home"
    assert not ok(requests.get(f"{B}/api/channels/{cid}/stage", headers=H(M)))["live"]
print("show ui ok: off air + interested, backstage, live, watch, hand, bring up, director, phone, end")

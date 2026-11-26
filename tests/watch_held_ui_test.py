# Someone joins a Watch Party while something is playing (needs the real voice server):
# on their phone they see why their mic is off and can ask to talk; whoever runs it sees
# who's waiting and can let them talk.
import sys, os, json, time, requests
from playwright.sync_api import sync_playwright
from websocket import create_connection
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None

s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
K = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "kai", "password": "pass-word-123"}))["token"]
ok(requests.put(B + "/api/admin/settings", headers=H(M), json={"lan_ip": "127.0.0.1"}))
for _ in range(120):
    if ok(requests.get(B + "/api/admin/settings", headers=H(M)))["voice"]["state"] == "running": break
    time.sleep(0.5)
watch = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "Movie night", "kind": "watch"}))["id"]

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    def page(tok, w, h, phone=False):
        pg = b.new_context(viewport={"width": w, "height": h}, has_touch=phone, is_mobile=phone, permissions=["microphone", "camera"]).new_page()
        pg.goto(B + "/"); pg.evaluate("t=>{localStorage.setItem('llamble.token',t);localStorage.setItem('llamble.server',location.origin)}", tok)
        pg.goto(B + "/"); pg.wait_for_timeout(2000)
        pg.evaluate("([g,c]) => window.llambleDebug.selectChannel(g, c)", [gid, watch]); pg.wait_for_timeout(800)
        return pg
    # maya runs it: joins, queues something, it plays
    m = page(M, 1280, 800)
    m.click("text=Join Watch Party"); m.wait_for_timeout(3000)
    ok(requests.post(f"{B}/api/channels/{watch}/watch/queue", headers=H(M), json={"kind": "url", "src": "https://example.com/films/big-movie.mp4", "title": "Big Movie"}))
    m.wait_for_timeout(1500)
    # kai comes in late, on a phone
    k = page(K, 412, 860, phone=True)
    k.click("text=Join Watch Party"); k.wait_for_timeout(4000)
    k.wait_for_selector(".watch-held", timeout=5000)
    assert "mic is off" in k.locator(".watch-held").first.inner_text()
    k.screenshot(path=f"{OUT}/watch-held-phone.png")
    print("late joiner on a phone: sees why the mic is off, with Ask to talk")
    # maya sees he's waiting
    m.wait_for_selector("text=Let everyone talk (1 waiting)", timeout=5000)
    # he asks; she lets him talk; his notice goes
    k.click(".watch-held button:has-text('Ask to talk')")
    m.wait_for_selector(".watch-ask:has-text('asked to talk')", timeout=5000)
    m.screenshot(path=f"{OUT}/watch-held-runner.png")
    m.click(".watch-ask button:has-text('Let them talk')")
    k.wait_for_selector(".watch-held", state="detached", timeout=5000)
    print("runner sees who's waiting and who asked; letting him talk clears his notice")
    b.close()
print("watch held ui ok")

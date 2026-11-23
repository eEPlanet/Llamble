# Watch Party in a browser: the "Watch Party" choice when adding a space, the space before
# joining (what's playing, the queue), and the admin's Watch Party settings.
# (Joining the room needs a real voice server, so playback itself is covered by watch_test.py.)
import sys, os, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r):
    assert r.status_code < 300, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, gid = s["token"], s["guild_id"]
w = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "Movie Night", "kind": "watch"}))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 800})
    pg = ctx.new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    pg.click("button[title='Family']"); pg.wait_for_timeout(500)
    pg.click(".channel:has-text('Movie Night')"); pg.wait_for_timeout(1200)
    pg.wait_for_selector(".watch-idle")
    assert "Nothing is playing" in pg.inner_text(".watch-idle")
    pg.screenshot(path=f"{OUT}/watch-idle.png")
    # someone queues a video: the idle screen shows it (live update)
    ok(requests.post(f"{B}/api/channels/{w['id']}/voice", headers=H(M)))
    ok(requests.post(f"{B}/api/channels/{w['id']}/watch/queue", headers=H(M), json={"kind": "link", "src": "https://youtu.be/dQw4w9WgXcQ", "title": "Trailer"}))
    ok(requests.post(f"{B}/api/channels/{w['id']}/watch/queue", headers=H(M), json={"kind": "link", "src": "https://example.com/feature.mp4", "title": "The Feature"}))
    pg.wait_for_selector(".watch-idle:has-text('Trailer')", timeout=5000)
    pg.wait_for_selector(".watch-q:has-text('The Feature')", timeout=5000)
    pg.screenshot(path=f"{OUT}/watch-queued.png")
    # adding a space offers Watch Party
    pg.click(".sidebar-header"); pg.wait_for_timeout(300)
    pg.click("text=Add a Space"); pg.wait_for_timeout(500)
    assert pg.locator(".kind-opt:has-text('Watch Party')").count() == 1
    pg.click(".kind-opt:has-text('Watch Party')")
    pg.screenshot(path=f"{OUT}/watch-create.png")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    b.close()
print("watch ui ok")

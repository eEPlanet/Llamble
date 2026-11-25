# A mention far back in a busy chat: it's in Notifications, and tapping it opens the chat at
# that message (loading older messages until it's there), then reading it clears it.
import sys, os, json, requests
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
k_id = ok(requests.get(B + "/api/users/@me", headers=H(K)))["id"]
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + M)
rd = json.loads(ws.recv())["d"]; ws.close()
general = next(c for g in rd["guilds"] if g["guild"]["id"] == gid for c in g["channels"] if c["kind"] == "text")["id"]
post = lambda c: ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(M), json={"content": c}))
for i in range(30): post(f"warming up {i}")
target = post(f"<@{k_id}> can you grab the tickets?")
for i in range(130): post(f"chatter {i}")

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1280, "height": 860}).new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{K}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    pg.click("button.guild-logo"); pg.wait_for_timeout(400)
    pg.click(".board-rows >> text=Notifications"); pg.wait_for_timeout(800)
    row = pg.locator(".notice:has-text('mentioned you')").first
    assert row.count(), "no mention in Notifications"
    assert "tickets" in row.inner_text()
    pg.screenshot(path=f"{OUT}/mention-notice.png")
    row.locator(".notice-main").click()
    pg.wait_for_selector(f"#msg-{target['id']}", timeout=15000)
    pg.wait_for_timeout(800)
    box = pg.locator(f"#msg-{target['id']}").bounding_box()
    assert box and 0 < box["y"] < 860, box
    pg.screenshot(path=f"{OUT}/mention-jump.png")
    b.close()
n = [x for x in ok(requests.get(B + "/api/notifications", headers=H(K))) if x["kind"] == "mention"]
assert n and n[0]["read_at"], n
print("mention ui ok: in Notifications, opens the chat at the message far back, marked read")

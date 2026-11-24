# Who's here, in the sidebar: outside a space you see your friends there by name plus a count
# of everyone else; inside it (chat open / room joined) you see everyone, friends first.
# Also: Mute people is an icon by the mic and headset; Lock lives in the menu, not headers.
import sys, os, json, time, requests
from websocket import create_connection
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r):
    assert r.status_code < 300, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 9}))["code"]
tok, ids = {}, {}
for u in ("jake", "sam", "dee"):
    r = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": u, "password": "pass-word-123", "display_name": u.title()}))
    tok[u] = r["token"]; ids[u] = ok(requests.get(B + "/api/users/@me", headers=H(r["token"])))["id"]
ok(requests.post(B + "/api/friends", headers=H(M), json={"username": "jake"}))
ok(requests.put(f"{B}/api/friends/{ok(requests.get(B + '/api/users/@me', headers=H(M)))['id']}", headers=H(tok["jake"])))
lobby = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "lobby", "kind": "text"}))
# jake (a friend) and sam (not) are reading #lobby; dee is in the voice room
socks = []
for u in ("jake", "sam"):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok[u]); ws.recv()
    ws.send(json.dumps({"op": "viewing", "channel_id": lobby["id"]})); socks.append(ws)
voice = None
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1280, "height": 800}).new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    pg.click("button[title='Family']"); pg.wait_for_timeout(500)
    pg.click(".channel:has-text('general')"); pg.wait_for_timeout(800)
    row = pg.locator(".channel:has-text('lobby')")
    # outside #lobby: Jake by name, and "+1 other"
    pg.wait_for_selector(".voice-user:has-text('Jake')", timeout=5000)
    assert pg.locator(".voice-user:has-text('Sam')").count() == 0
    pg.wait_for_selector(".here-tag:has-text('+1 other')", timeout=5000)
    pg.screenshot(path=f"{OUT}/here-outside.png")
    # inside #lobby: everyone, friends first
    row.click(); pg.wait_for_timeout(1000)
    pg.wait_for_function("document.querySelectorAll('.voice-users .voice-user').length === 3", timeout=5000)
    names = [n.strip().split("\n")[-1] for n in pg.locator(".voice-users .voice-user").all_inner_texts()]
    assert names[0] == "Jake" and set(names) == {"Jake", "maya", "Sam"}, names  # friends first, you included
    assert pg.locator(".here-tag").count() == 0
    pg.screenshot(path=f"{OUT}/here-inside.png")
    # no Lock button in headers (it's in the menu / Edit Space)
    assert pg.locator(".chat-header button:has-text('Lock')").count() == 0
    pg.click(".channel:has-text('lobby')", button="right"); pg.wait_for_timeout(300)
    assert pg.locator("text=Lock Space").count() == 1
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    # going invisible, then opening a chat: a warning first
    pg.click(".user-panel-me"); pg.wait_for_timeout(300)
    pg.click("text=Invisible"); pg.wait_for_timeout(500)
    pg.click(".channel:has-text('general')"); pg.wait_for_timeout(600)
    pg.wait_for_selector("text=You're invisible")
    pg.screenshot(path=f"{OUT}/invisible-gate.png")
    pg.click("text=Go online and open it"); pg.wait_for_timeout(600)
    assert pg.locator("text=You're invisible").count() == 0
    assert "Online" in pg.inner_text(".user-panel")
    b.close()
for ws in socks:
    ws.close()
print("here ui ok")

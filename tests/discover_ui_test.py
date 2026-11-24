# In a browser: Who can get in (server settings), the Open servers binoculars, looking around
# and joining, a request to join that staff approve from Notifications, Invite to Llamble with
# "Add as friends", and green as the default highlight.
import sys, os, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
def call(method, path, tok, expect=200, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code == expect, (method, path, r.status_code, r.text[:300])
    return r.json() if r.text else None
s = requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}).json()
M, home = s["token"], s["guild_id"]
call("PUT", "/api/admin/settings", M, json={"guild_create": "all"})
inv = call("POST", "/api/invites/llamble", M, json={})["code"]
T = requests.post(B + "/api/auth/register", json={"invite": inv, "username": "theo", "password": "pass-word-123", "display_name": "Theo"}).json()["token"]
t_id = call("GET", "/api/users/@me", T)["id"]
def new_guild(name):
    return call("POST", "/api/guilds", M, json={"name": name})
gp = new_guild("Game Night")
games = gp["guild"]["id"]
book = new_guild("Book Club")["guild"]["id"]
call("PATCH", f"/api/guilds/{book}", M, json={"join_mode": "request", "description": "One book a month"})
chat = [c for c in gp["channels"] if c["kind"] == "text"][0]["id"]
call("POST", f"/api/channels/{chat}/messages", M, json={"content": "Cards at 8 on Friday, who's in?"})

def page(b, tok):
    pg = b.new_context(viewport={"width": 1280, "height": 860}).new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{tok}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    return pg

with sync_playwright() as p:
    b = p.chromium.launch()
    pm = page(b, M)
    # green is the default highlight, and nothing is saved until someone picks one
    assert pm.evaluate("document.documentElement.dataset.accent") == "green"
    assert pm.evaluate("localStorage.getItem('llamble.highlight')") is None
    # ---- staff set Game Night to Open from Server Settings → Overview
    pm.click(".guild-btn[title='Game Night']", button="right"); pm.wait_for_timeout(300)
    pm.click("text=Server Settings"); pm.wait_for_timeout(600)
    pm.click(".join-mode:has-text('Open') input"); pm.wait_for_timeout(500)
    pm.fill("input[placeholder='What this server is for']", "Friday card games")
    pm.locator("input[placeholder='What this server is for'] + button").click(); pm.wait_for_timeout(500)
    g = [x for x in call("GET", "/api/discover", T)["servers"] if x["id"] == games][0]
    assert g["join_mode"] == "open" and g["description"] == "Friday card games", g
    pm.locator(".join-modes").scroll_into_view_if_needed()
    pm.screenshot(path=f"{OUT}/who-can-get-in.png")
    pm.keyboard.press("Escape"); pm.wait_for_timeout(300)

    # ---- a member: the binoculars shows a dot for something new, then the list
    pt = page(b, T)
    assert pt.locator(".discover-btn .discover-dot").count() == 1
    pt.click(".discover-btn"); pt.wait_for_timeout(800)
    assert pt.locator(".discover-card").count() == 2
    pt.screenshot(path=f"{OUT}/open-servers.png")
    assert pt.locator(".discover-btn .discover-dot").count() == 0
    # look around Game Night, read-only, then join
    pt.click(".discover-card:has-text('Game Night')"); pt.wait_for_timeout(800)
    pt.wait_for_selector("text=Cards at 8 on Friday")
    pt.screenshot(path=f"{OUT}/look-around.png")
    pt.click("button:has-text('Join this server')"); pt.wait_for_timeout(1200)
    assert call("GET", f"/api/discover/{games}", T)["guild"]["member"] is True
    # ask to join Book Club (request only: no looking around)
    pt.click(".discover-btn"); pt.wait_for_timeout(800)
    pt.click(".discover-card:has-text('Book Club')"); pt.wait_for_timeout(600)
    assert pt.locator(".discover-look").count() == 0
    pt.click("button:has-text('Request to join')")
    pt.fill("input[placeholder='Who you are, who you know there']", "Maya's neighbor")
    pt.click("button:has-text('Send request')"); pt.wait_for_timeout(800)
    pt.wait_for_selector("text=Request sent")
    pt.screenshot(path=f"{OUT}/request-sent.png")
    pt.keyboard.press("Escape")

    # ---- staff approve from Notifications
    pm.goto(B + "/"); pm.wait_for_timeout(2000)
    pm.wait_for_selector(".notice:has-text('asked to join Book Club')")
    pm.click(".hb-notices button:has-text('See all')"); pm.wait_for_timeout(800)
    pm.screenshot(path=f"{OUT}/join-request-notice.png")
    pm.click(".notice:has-text('asked to join Book Club') button:has-text('Approve')"); pm.wait_for_timeout(1000)
    assert call("GET", f"/api/discover/{book}", T)["guild"]["member"] is True

    # ---- Invite to Llamble with Add as friends (from the Friends list)
    pt.goto(B + "/"); pt.wait_for_timeout(2000)
    pt.click(".guild-btn[title^='Friends']"); pt.wait_for_timeout(600)
    pt.click("button:has-text('Invite someone to Llamble')"); pt.wait_for_timeout(800)
    assert pt.locator(".check-row input").is_checked()
    pt.screenshot(path=f"{OUT}/invite-to-llamble.png")
    code = pt.locator(".copy-row input").input_value().rsplit("/", 1)[-1]
    nu = requests.post(B + "/api/auth/register", json={"invite": code, "username": "zoe", "password": "pass-word-123"}).json()["token"]
    assert [f["user"]["username"] for f in call("GET", "/api/friends", nu)] == ["theo"]
    pt.keyboard.press("Escape")
    # the server invite dialog has the same box; members of an invite-only server can't invite
    call("POST", f"/api/guilds/{book}/invites", T, expect=403, json={})
    pt.click(".guild-btn[title='Game Night']", button="right"); pt.wait_for_timeout(300)
    pt.click("text=Invite People"); pt.wait_for_timeout(800)
    assert pt.locator(".check-row:has-text('Add as friends') input").is_checked()
    pt.screenshot(path=f"{OUT}/invite-with-friends.png")
    b.close()
print("discover ui ok")

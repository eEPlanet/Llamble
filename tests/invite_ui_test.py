# Notifications desk and invite cards in a browser (Llamble serving client/dist):
# the Llamble icon lights up, the board shows new notifications, the desk lists them,
# a DM invite card joins in place, a party card shows who has joined, Invite People searches.
import sys, os, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r):
    assert r.status_code < 300, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, home = s["token"], s["guild_id"]; m_id = ok(requests.get(B + "/api/users/@me", headers=H(M)))["id"]
ok(requests.put(B + "/api/admin/settings", headers=H(M), json={"guild_create": "all"}))
inv = ok(requests.post(f"{B}/api/guilds/{home}/invites", headers=H(M), json={"max_uses": 9}))["code"]
tok, ids = {}, {}
for u, d in (("jake", "Jake"), ("sam", "Sam"), ("dee", "Dee")):
    r = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": u, "password": "demo-pass-123", "display_name": d}))
    tok[u] = r["token"]; ids[u] = ok(requests.get(B + "/api/users/@me", headers=H(r["token"])))["id"]
J = tok["jake"]
game = ok(requests.post(B + "/api/guilds", headers=H(J), json={"name": "Game Night"}))
game = (game.get("guild") or game)["id"]
# jake invites maya directly, and his party (maya, sam, dee); sam joins right away
r = ok(requests.post(f"{B}/api/guilds/{game}/invite-people", headers=H(J), json={"user_ids": [m_id]}))
dm = r["sent"][0]["channel_id"]
party = ok(requests.post(B + "/api/parties", headers=H(J), json={"user_ids": [m_id, ids["sam"], ids["dee"]], "name": "Squad"}))
pc = ok(requests.post(f"{B}/api/guilds/{game}/invite-party", headers=H(J), json={"party_id": party["id"]}))["card_id"]
ok(requests.post(f"{B}/api/invite-cards/{pc}/join", headers=H(tok["sam"])))
ok(requests.post(B + "/api/friends", headers=H(tok["dee"]), json={"username": "maya"}))

def login(ctx, t):
    pg = ctx.new_page(); pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{t}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    return pg

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, vp, mobile in [("desk", {"width": 1280, "height": 800}, False), ("phone", {"width": 390, "height": 844}, True)]:
        ctx = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile)
        pg = login(ctx, M)
        if mobile:
            pg.click(".m-menu"); pg.wait_for_timeout(300)
        assert pg.locator(".guild-logo.lit").count() == 1, "Llamble icon should light up"
        pg.screenshot(path=f"{OUT}/inv-{name}-rail.png")
        if mobile:
            pg.click(".channel:has-text('Board')"); pg.wait_for_timeout(500)
        pg.wait_for_selector(".hb-top .hb-notices .notice")
        assert pg.locator(".hb-notices .notice").count() == (4 if name == "desk" else 2), pg.locator(".hb-notices .notice").count()  # the phone run comes after joining
        assert pg.locator(".hb-top .hb-index").count() >= 2  # Right now + Notifications side by side
        pg.screenshot(path=f"{OUT}/inv-{name}-board.png")
        pg.click(".hb-notices button:has-text('See all')"); pg.wait_for_timeout(600)
        pg.wait_for_selector(".desk-page .notice")
        pg.screenshot(path=f"{OUT}/inv-{name}-desk.png")
        if name == "desk":
            # open the direct invite from its notification: lands in the DM with the card
            pg.click(".desk-page .notice:has-text('invited you to Game Night'):not(:has-text('party')) .notice-main"); pg.wait_for_timeout(1200)
            pg.wait_for_selector(".invite-card")
            pg.screenshot(path=f"{OUT}/inv-{name}-dm-card.png")
            # the party card shows progress
            pg.evaluate("1")
            ctx2 = b.new_context(viewport=vp)
            pj = login(ctx2, J)
            pj.click("button[title^='Talk']"); pj.wait_for_timeout(400)
            pj.click(".msg-tab:has-text('Parties')"); pj.wait_for_timeout(400)
            pj.click("text=Squad"); pj.wait_for_timeout(1200)
            pj.wait_for_selector(".invite-card-progress")
            assert "1 of 3" in pj.inner_text(".invite-card-progress"), pj.inner_text(".invite-card-progress")
            pj.screenshot(path=f"{OUT}/inv-{name}-party-card.png")
            # Invite People: search
            pj.click(f"button[title='Game Night']"); pj.wait_for_timeout(600)
            pj.click(".sidebar-header"); pj.wait_for_timeout(300)
            pj.click("text=Invite People"); pj.wait_for_timeout(800)
            pj.fill(".invite-search input", "ma"); pj.wait_for_timeout(700)
            pj.screenshot(path=f"{OUT}/inv-{name}-search.png")
            ctx2.close()
            # maya joins from the DM card
            pg.click(".invite-card button:has-text('Join')"); pg.wait_for_timeout(1500)
            pg.screenshot(path=f"{OUT}/inv-{name}-joined.png")
        ctx.close()
    b.close()
print("invite ui ok")

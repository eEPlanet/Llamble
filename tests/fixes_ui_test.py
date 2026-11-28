# Bug fixes, in a browser (fake LiveKit: run with /tmp/onelk.sh-style env so calls exist):
# - Forum: new posts show "New" and under Unread; reading them clears the server's white dot;
#   Mark all read; editing your own post (text and title)
# - Home → Right now: who's in each call is named in the call's row; everyone else online is
#   under its own "Online" heading (not looking like they're in the call)
# - Notifications: ✕ removes one for good (still gone after a reload)
import json, sys, time, threading, requests
from websocket import create_connection
from playwright.sync_api import sync_playwright
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None
def ready(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    d = json.loads(ws.recv())["d"]; return ws, d

s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Lake House"}))
M, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
T = {}
for n in ["sam", "theo", "lena"]:
    T[n] = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": n, "password": "pass-word-123"}))["token"]
    ok(requests.patch(B + "/api/users/@me", headers=H(T[n]), json={"display_name": n.title()}))
ok(requests.patch(B + "/api/users/@me", headers=H(M), json={"display_name": "Maya"}))
fid = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "Help", "kind": "forum"}))["id"]
post = lambda t, body: ok(requests.post(f"{B}/api/channels/{fid}/messages", headers=H(t), json=body))
p1 = post(T["sam"], {"title": "Shield stutters", "content": "every few minutes"})["id"]
p2 = post(T["sam"], {"title": "Movie night", "content": "Friday?"})["id"]
mine = post(M, {"title": "House rules", "content": "Be nice"})["id"]
# Maya has read every chat (join messages etc.), so only the forum is new
ws, d = ready(M)
me = d["user"]["id"]
for g in d["guilds"]:
    for c in g["channels"]:
        if c.get("last_message_id") and c["kind"] != "forum":
            ok(requests.post(f"{B}/api/channels/{c['id']}/ack", headers=H(M), json={"message_id": c["last_message_id"]}))
general = next(c for g in d["guilds"] for c in g["channels"] if c["kind"] == "text")["id"]
voice = next(c for g in d["guilds"] for c in g["channels"] if c["kind"] == "voice")["id"]
ws.close()
# Sam and Lena online; Theo online and in the General call
held = [ready(T[n])[0] for n in ["sam", "lena", "theo"]]
ok(requests.post(f"{B}/api/channels/{voice}/voice", headers=H(T["theo"]), json={}))
# Sam @mentions Maya: a notification
mention = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(T["sam"]), json={"content": f"hey <@{me}> look at the forum"}))
# she read that chat elsewhere (the notification is still there until she clears it)
ok(requests.post(f"{B}/api/channels/{general}/ack", headers=H(M), json={"message_id": mention["id"]}))

def server_dot(pg): return pg.locator(f".guild-btn[data-gid='{gid}'] .icon-new-dot").count() > 0
with sync_playwright() as p:
    pg = p.chromium.launch().new_context(viewport={"width": 1280, "height": 900}).new_page()
    pg.on("pageerror", lambda e: print("  [page error]", e))
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)

    # ---- Right now (Home)
    pg.click(".guild-logo"); pg.wait_for_timeout(1500)
    call = pg.locator(".hb-call:has-text('General')")
    assert call.count(), "the call is listed"
    assert call.locator(".hb-call-person:has-text('Theo')").count(), "Theo is named in the call's row"
    assert pg.locator(".hb-online-title:has-text('Online')").count(), "an Online heading"
    people = pg.locator(".hb-people").inner_text()
    assert "Sam" in people and "Lena" in people and "Theo" not in people, people
    pg.locator(".hb-index").first.screenshot(path="/tmp/right-now.png")
    print("Right now: Theo named in the call; Sam and Lena under Online")

    # ---- Notifications: ✕ removes it for good
    pg.click(".channel:has-text('Notifications')"); pg.wait_for_timeout(800)
    row = pg.locator(".notice:has-text('look at the forum'), .notice:has-text('mentioned')").first
    assert row.count(), pg.locator(".notice-list").inner_text()
    n_before = pg.locator(".notice").count()
    row.locator("button[title='Clear']").click(); pg.wait_for_timeout(800)
    assert pg.locator(".notice").count() == n_before - 1
    pg.reload(); pg.wait_for_timeout(2500)
    pg.click(".guild-logo"); pg.wait_for_timeout(800)
    pg.click(".channel:has-text('Notifications')"); pg.wait_for_timeout(1000)
    assert pg.locator(".notice").count() == n_before - 1, "the cleared notification stays gone"
    print("notification ✕: still gone after a reload")

    # ---- Forum: the white dot comes from unread posts, and goes when they're read
    assert server_dot(pg), "new forum posts light the server"
    pg.click(f".guild-btn[data-gid='{gid}']"); pg.wait_for_timeout(600)
    pg.click(".channel:has-text('Help')"); pg.wait_for_timeout(1200)
    assert pg.locator(".post-card.unread").count() == 2 and pg.locator(".post-card .fc-badge.new").count() == 2
    pg.click(".forum-filters button:has-text('Unread')"); pg.wait_for_timeout(800)
    assert pg.locator(".post-card").count() == 2
    pg.screenshot(path="/tmp/forum-unread.png")
    pg.click(".post-card:has-text('Shield stutters')"); pg.wait_for_timeout(1000)
    pg.click(".forum button[title='All posts']"); pg.wait_for_timeout(1000)
    pg.click(".forum-filters button:has-text('Unread')"); pg.wait_for_timeout(800)
    assert pg.locator(".post-card").count() == 1 and server_dot(pg), "one left: still lit"
    pg.click(".post-card:has-text('Movie night')"); pg.wait_for_timeout(1200)
    assert not server_dot(pg), "everything read: the dot is gone"
    assert not pg.locator(f".channel.unread:has-text('Help')").count()
    print("forum: New / Unread, and reading clears the white dot")

    # ---- Mark all read
    post(T["sam"], {"title": "BBQ Sunday", "content": "who's in"})
    pg.click(".forum button[title='All posts']"); pg.wait_for_timeout(1200)
    assert server_dot(pg)
    pg.click(".forum button:has-text('Mark all read')"); pg.wait_for_timeout(1000)
    assert not server_dot(pg) and not pg.locator(".post-card.unread").count()
    print("Mark all read clears it")

    # ---- editing my own post
    pg.click(".forum-filters button:has-text('All')"); pg.wait_for_timeout(800)
    pg.click(".post-card:has-text('House rules')"); pg.wait_for_timeout(1000)
    pg.locator(".is-post button[title='More']").click(); pg.wait_for_timeout(300)
    pg.click("text=Edit post"); pg.wait_for_timeout(300)
    pg.locator(".fc-edit-title").fill("House rules (updated)")
    pg.locator(".fc-edit textarea").fill("Be nice. No spoilers.")
    pg.click(".fc-edit button:has-text('Save')"); pg.wait_for_timeout(1200)
    assert pg.locator(".is-post .fc-title:has-text('House rules (updated)')").count()
    assert pg.locator(".is-post .fc-text:has-text('No spoilers')").count() and pg.locator(".is-post:has-text('(edited)')").count()
    t = ok(requests.get(f"{B}/api/channels/{fid}/forum/{mine}", headers=H(M)))["post"]
    assert t["forum"]["title"] == "House rules (updated)" and t["content"] == "Be nice. No spoilers."
    # someone else's post: no Edit
    pg.click(".forum button[title='All posts']"); pg.wait_for_timeout(1000)
    pg.click(".post-card:has-text('BBQ Sunday')"); pg.wait_for_timeout(1000)
    pg.locator(".is-post button[title='More']").click(); pg.wait_for_timeout(300)
    assert not pg.locator(".menu >> text=Edit post").count() and pg.locator("text=Edit title and tags").count(), "staff can fix titles, not words"
    print("editing: own post text and title; staff only title and tags on others'")
for w in held: w.close()
print("FIXES UI OK")

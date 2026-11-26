# Block and report in the app: a message's menu reports it (to the admin) and blocks its author;
# their messages then fold away; Settings → Blocked unblocks; the admin sees the report in
# Settings → Reports and deletes the message. No "coming soon" rows are left in the sidebar.
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
T = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "troll", "password": "pass-word-123"}))["token"]
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + M)
rd = json.loads(ws.recv())["d"]; ws.close()
general = next(c for g in rd["guilds"] if g["guild"]["id"] == gid for c in g["channels"] if c["kind"] == "text")["id"]
ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(K), json={"content": "hello all"}))
bad = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(T), json={"content": "you are all losers"}))

def page(p, tok):
    pg = p.chromium.launch().new_context(viewport={"width": 1280, "height": 860}).new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{tok}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    return pg

with sync_playwright() as p:
    pg = page(p, K)
    pg.click("button.guild-logo"); pg.wait_for_timeout(400)
    side = pg.locator(".channel-scroll").first.inner_text()
    for word in ["Store", "Apps", "Help Desk", "Events", "soon"]:
        assert word not in side, (word, side)
    pg.screenshot(path=f"{OUT}/safety-sidebar.png")
    # open the server chat
    pg.click(f".guild-btn[data-gid='{gid}']"); pg.wait_for_timeout(400)
    pg.locator(f"[data-cid='{general}']").first.click(); pg.wait_for_timeout(1200)
    msg = pg.locator(f"#msg-{bad['id']}")
    msg.click(button="right"); pg.wait_for_timeout(300)
    assert pg.locator(".ctx-menu >> text=Report Message").count() and pg.locator(".ctx-menu >> text=Block troll").count()
    pg.locator(".ctx-menu >> text=Report Message").click(); pg.wait_for_timeout(400)
    pg.locator(".modal >> text=Harassment or bullying").click()
    pg.locator(".modal textarea").fill("rude to everyone")
    pg.locator(".modal >> text=Also block").click()
    pg.screenshot(path=f"{OUT}/safety-report.png")
    pg.locator(".modal button:has-text('Report')").click(); pg.wait_for_timeout(800)
    assert pg.locator(".modal >> text=Thanks for telling us").count()
    pg.locator(".modal button:has-text('Done')").click(); pg.wait_for_timeout(500)
    assert pg.locator(f"#msg-{bad['id']}.blocked-msg").count(), "blocked author's message should fold away"
    pg.screenshot(path=f"{OUT}/safety-folded.png")
    pg.locator(f"#msg-{bad['id']} button:has-text('Show')").click(); pg.wait_for_timeout(200)
    assert "losers" in pg.locator(f"#msg-{bad['id']}").inner_text()
    # Settings → Blocked → Unblock
    pg.locator("button[title='User Settings']").first.click(); pg.wait_for_timeout(500)
    pg.locator(".settings-nav >> text=Blocked").first.click(); pg.wait_for_timeout(600)
    assert pg.locator(".settings-row:has-text('troll')").count()
    pg.screenshot(path=f"{OUT}/safety-blocked.png")
    pg.locator("button:has-text('Unblock')").first.click(); pg.wait_for_timeout(600)
    assert pg.locator("text=You haven't blocked anyone").count()

    # the admin: a report notification, then Settings → Reports → Delete message
    pa = page(p, M)
    pa.click("button.guild-logo"); pa.wait_for_timeout(400)
    pa.click(".board-rows >> text=Notifications"); pa.wait_for_timeout(800)
    row = pa.locator(".notice:has-text('was reported')").first
    assert row.count() and "losers" in row.inner_text(), pa.locator(".notice").all_inner_texts()
    row.locator(".notice-main").click(); pa.wait_for_timeout(900)
    card = pa.locator(".report-card.open").first
    assert "rude to everyone" in card.inner_text() and "losers" in card.inner_text()
    pa.screenshot(path=f"{OUT}/safety-reports.png")
    card.locator("button:has-text('Delete message')").click(); pa.wait_for_timeout(800)
    assert pa.locator(".report-card >> text=Message deleted").count()
print("safety ui ok: no 'soon' rows; report + block from a message; folded; unblock; admin deletes from Reports")
r = requests.get(f"{B}/api/channels/{general}/messages?limit=20", headers=H(M)).json()
assert bad["id"] not in [m["id"] for m in r]

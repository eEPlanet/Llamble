# Fills a fresh Llamble server with made-up people and chats, then takes the screenshots
# shown on llamble.com (site/screens/). Nothing real or private appears in them.
# Usage: site_screenshots.py URL OUT_DIR   (the server must be fresh, with the voice stand-in)
import io, math, random, sys, time, requests
from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

B, OUT = sys.argv[1], sys.argv[2]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r):
    assert r.status_code < 300, (r.status_code, r.text[:300]); return r.json() if r.text else None

s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family", "display_name": "Maya"}))
M = s["token"]
g = ok(requests.post(B + "/api/guilds", headers=H(M), json={"name": "Game Night"}))
gid = g["guild"]["id"]
ok(requests.patch(B + "/api/users/@me", headers=H(M), json={"display_name": "Maya"}))
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 20}))["code"]
people = {}
for u, d in [("jordan", "Jordan"), ("sam", "Sam"), ("riley", "Riley"), ("casey", "Casey"), ("devon", "Devon")]:
    r = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": u, "password": "demo-pass-123", "display_name": d}))
    people[u] = (r["token"], r["user"]["id"])
chans = g["channels"]
text = [c for c in chans if c["kind"] == "text"][0]["id"]
voice = [c for c in chans if c["kind"] == "voice"][0]["id"]

def say(tok, content, **kw):
    return ok(requests.post(f"{B}/api/channels/{text}/messages", headers=H(tok), json={"content": content, **kw}))
def picture(w, h, seed):
    random.seed(seed)
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    top, bot = (40, 60, 120), (240, 140, 80)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    for i in range(7):  # hills
        base = h * (0.55 + i * 0.06)
        col = (30 + i * 12, 50 + i * 10, 60 + i * 8)
        pts = [(x, base + 30 * math.sin(x / (90 + i * 30) + i)) for x in range(0, w + 10, 10)]
        d.polygon(pts + [(w, h), (0, h)], fill=col)
    d.ellipse((w * 0.68, h * 0.18, w * 0.68 + 90, h * 0.18 + 90), fill=(255, 220, 150))
    bio = io.BytesIO(); img.filter(ImageFilter.GaussianBlur(0.6)).save(bio, "JPEG", quality=88); bio.seek(0)
    return bio

J, S, R, C = (people[k][0] for k in ("jordan", "sam", "riley", "casey"))
say(M, "Game night is **Friday at 8** 🎲 Who's in?")
say(J, "In! I'll bring the snacks 🍿")
say(S, "Count me in. Can we finally finish that co-op campaign?")
f = ok(requests.post(B + "/api/files", headers=H(R), files={"file": ("sunset.jpg", picture(1200, 640, 3), "image/jpeg")}))
m = say(R, "Took this on the hike today, new wallpaper material", attachments=[{"id": f["id"]}])
for tok, e in [(M, "%F0%9F%94%A5"), (J, "%F0%9F%94%A5"), (S, "%F0%9F%98%8D")]:
    requests.put(f"{B}/api/messages/{m['id']}/reactions/{e}", headers=H(tok))
say(C, "That's gorgeous 😮")
say(J, "Hopping in voice to sort out the teams, come join")
for k in ("jordan", "sam", "casey"):
    requests.post(f"{B}/api/channels/{voice}/voice", headers=H(people[k][0]))
# friends and a party for Maya
for k in ("jordan", "sam", "riley", "casey"):
    requests.post(B + "/api/friends", headers=H(M), json={"username": k})
    requests.post(B + "/api/friends", headers=H(people[k][0]), json={"username": "maya"})
try:
    p = ok(requests.post(B + "/api/parties", headers=H(M), json={"name": "Weekend Crew", "user_ids": [people[k][1] for k in ("jordan", "sam", "riley")]}))
except AssertionError:
    pass
# a note for Maya, a highlight, and some news on the board
requests.post(f"{B}/api/guilds/{gid}/notes", headers=H(J), json={"content": "Maya, can you bring the extra controllers Friday? 🎮", "to": [s["user"]["id"]] if "user" in s else []})
requests.post(f"{B}/api/guilds/{gid}/highlights", headers=H(M), json={"message_id": m["id"]})
requests.post(f"{B}/api/guilds/{gid}/news", headers=H(M), json={"title": "Tournament this Saturday", "body": "Sign-ups are open in #general. Winner picks next month's game!"})
# a few people online while the pictures are taken
from websocket import create_connection
online = [create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + people[k][0]) for k in ("jordan", "sam", "casey", "riley")]
time.sleep(1)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = br.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    pg.goto(B + "/")
    pg.evaluate("t=>{localStorage.setItem('llamble.token',t);localStorage.setItem('llamble.server',location.origin)}", M)
    pg.goto(B + "/")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{OUT}/home.png")
    pg.get_by_title("Game Night").first.click()
    pg.wait_for_timeout(1500)
    pg.get_by_text("general", exact=True).first.click()
    pg.wait_for_timeout(2000)
    pg.screenshot(path=f"{OUT}/chat.png")
    pg.get_by_title("Friends").first.click()
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{OUT}/friends.png")
    br.close()
print("screenshots saved")

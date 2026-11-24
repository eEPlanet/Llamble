#!/usr/bin/env python3
"""Fills a fresh Llamble server with a made-up demo (people, servers, chats, a Watch Party,
voicemail, notes) and takes screenshots for the README and llamble.com.

Usage: make_screenshots.py http://127.0.0.1:8099 OUT_DIR
The server must be brand new (it runs first-time setup) and serve the web app.
Everyone and everything in it is invented; nothing comes from a real instance.
"""
import io, math, os, random, sys, wave
import requests
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

B, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
random.seed(7)
H = lambda t: {"Authorization": "Bearer " + t}


def call(method, path, tok, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code < 300, (method, path, r.status_code, r.text[:300])
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r


def upload(tok, name, data, mime):
    f = requests.post(B + "/api/files", headers=H(tok), files={"file": (name, data, mime)}).json()
    return f[0] if isinstance(f, list) else f


def png(img):
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def avatar(letter, c1, c2):
    """A soft two-color circle with a letter: a stand-in profile picture."""
    s = 256
    img = Image.new("RGB", (s, s), c1)
    d = ImageDraw.Draw(img)
    for y in range(s):
        t = y / s
        d.line([(0, y), (s, y)], fill=tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3)))
    try:
        f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 120)
    except OSError:
        f = ImageFont.load_default()
    d.text((s / 2, s / 2), letter, font=f, fill=(255, 255, 255), anchor="mm")
    return png(img)


def sunset():
    """A made-up picture to share in chat: hills at sunset."""
    w, h = 960, 600
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=(int(255 - 90 * t), int(140 - 60 * t), int(90 + 60 * t)))
    d.ellipse([w * 0.58, h * 0.3, w * 0.58 + 150, h * 0.3 + 150], fill=(255, 220, 150))
    for k, col in enumerate([(70, 50, 90), (45, 35, 70), (25, 20, 45)]):
        pts = [(0, h)]
        for x in range(0, w + 20, 20):
            pts.append((x, h * (0.55 + 0.12 * k) + 40 * math.sin(x / (90 + 40 * k) + k)))
        pts.append((w, h))
        d.polygon(pts, fill=col)
    return png(img)


def tone_wav(secs=6):
    b = io.BytesIO()
    w = wave.open(b, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    frames = bytearray()
    for i in range(16000 * secs):
        v = int(2500 * math.sin(i / 16000 * 2 * math.pi * 220) * (0.5 + 0.5 * math.sin(i / 4000)))
        frames += v.to_bytes(2, "little", signed=True)
    w.writeframes(bytes(frames)); w.close()
    return b.getvalue()


# ---------------------------------------------------------------- the demo
s = requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "The Lake House", "display_name": "Maya"}).json()
M, home = s["token"], s["guild_id"]
call("PUT", "/api/admin/settings", M, json={"guild_create": "all"})
people = {}
for name, disp, c1, c2 in [("theo", "Theo", (80, 140, 255), (40, 70, 200)), ("priya", "Priya", (255, 120, 160), (200, 60, 120)),
                           ("jordan", "Jordan", (90, 200, 140), (30, 130, 90)), ("lena", "Lena", (255, 170, 70), (220, 110, 30)),
                           ("sam", "Sam", (170, 120, 255), (110, 60, 210))]:
    code = call("POST", "/api/invites/llamble", M, json={"add_friend": True})["code"]
    t = requests.post(B + "/api/auth/register", json={"invite": code, "username": name, "password": "demo-pass-123", "display_name": disp}).json()["token"]
    people[name] = {"tok": t, "id": call("GET", "/api/users/@me", t)["id"], "c": (c1, c2)}
people["maya"] = {"tok": M, "id": call("GET", "/api/users/@me", M)["id"], "c": ((240, 110, 60), (190, 60, 40))}
for name, p in people.items():
    a = upload(p["tok"], "me.png", avatar(name[0].upper(), *p["c"]), "image/png")
    call("PATCH", "/api/users/@me", p["tok"], json={"avatar_file_id": a["id"]})
T, P, J, L, S = (people[n]["tok"] for n in ("theo", "priya", "jordan", "lena", "sam"))

def chans(gid, tok=M):
    import json as _j
    from websocket import create_connection
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    d = _j.loads(ws.recv())["d"]
    ws.close()
    return [c for g in d["guilds"] if g["guild"]["id"] == gid for c in g["channels"]]

def join(gid, tok):
    code = call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 1})["code"]
    call("POST", f"/api/invites/{code}", tok)

for t in (T, P, J, L, S):
    join(home, t)
general = [c for c in chans(home) if c["kind"] == "text"][0]["id"]
lounge = [c for c in chans(home) if c["kind"] == "voice"][0]["id"]
call("PATCH", f"/api/channels/{lounge}", M, json={"name": "Lounge"})
recipes = call("POST", f"/api/guilds/{home}/channels", M, json={"name": "recipes", "kind": "text"})["id"]
movie = call("POST", f"/api/guilds/{home}/channels", M, json={"name": "Movie Night", "kind": "watch"})["id"]
grp = call("POST", f"/api/guilds/{home}/channels", M, json={"name": "Gaming", "kind": "category"})["id"]
gchat = call("POST", f"/api/guilds/{home}/channels", M, json={"name": "lfg", "kind": "text", "parent_id": grp})["id"]
call("POST", f"/api/guilds/{home}/channels", M, json={"name": "Squad", "kind": "voice", "parent_id": grp})

def say(tok, cid, text, **kw):
    return call("POST", f"/api/channels/{cid}/messages", tok, json={"content": text, **kw})

say(L, general, "Morning everyone! Coffee's on at the lake house ☕")
say(T, general, "Is the dock fixed yet? I want to take the kayak out this weekend")
m = say(J, general, "Fixed it Tuesday 🔨 Also new boards on the end, watch your step")
call("PUT", f"/api/messages/{m['id']}/reactions/🙌", T)
call("PUT", f"/api/messages/{m['id']}/reactions/🙌", L)
call("PUT", f"/api/messages/{m['id']}/reactions/🔨", P)
pic = upload(P, "sunset.png", sunset(), "image/png")
say(P, general, "Last night from the porch 🌅", attachments=[{"id": pic["id"]}])
r = say(S, general, "Wow. Movie night Friday? I'll bring popcorn 🍿")
say(M, general, "Yes! I set up a **Watch Party** room, add what you want to watch to the queue", reply_to=r["id"])
say(T, general, "@Maya can we do the director's cut this time 😄")
say(L, recipes, "Grandma's peach cobbler: 4 cups peaches, 1 cup sugar, 1 cup flour, a stick of butter. 350° for 45 min.")
say(J, gchat, "Anyone up for a few rounds tonight? Hopping in Squad around 9")
# Watch Party: something playing and a queue
call("POST", f"/api/channels/{movie}/voice", S)
call("POST", f"/api/channels/{movie}/watch/queue", S, json={"kind": "link", "src": "https://example.com/lake-documentary.mp4", "title": "Life on the Lake (documentary)"})
call("POST", f"/api/channels/{movie}/watch/queue", S, json={"kind": "youtube", "src": "https://youtu.be/aqz-KE-bpKQ", "title": "Big Buck Bunny"})
call("POST", f"/api/channels/{movie}/watch/queue", S, json={"kind": "link", "src": "https://example.com/campfire-stories.mp4", "title": "Campfire Stories"})
# people in the Lounge
for t in (T, L):
    call("POST", f"/api/channels/{lounge}/voice", t)
# board: notes and news
call("POST", f"/api/guilds/{home}/notes", L, json={"content": "Trash goes out Thursday night 🗑️", "color": "yellow"})
call("POST", f"/api/guilds/{home}/notes", J, json={"content": "Boat keys are on the hook by the back door", "color": "blue"})
call("POST", f"/api/guilds/{home}/notes", M, json={"content": "Family dinner Sunday at 6, bring a dish!", "color": "pink"})
call("POST", f"/api/guilds/{home}/news", M, json={"title": "Summer at the lake", "body": "The dock is fixed, the kayaks are out of storage and Movie Night is every Friday. See you there!"})
call("POST", f"/api/guilds/{home}/highlights", M, json={"message_id": [x for x in call("GET", f"/api/channels/{general}/messages", M) if x["attachments"]][0]["id"]})
# another server, open to find
games = call("POST", "/api/guilds", J, json={"name": "Board Game Club"})["guild"]["id"]
call("PATCH", f"/api/guilds/{games}", J, json={"join_mode": "open", "description": "Catan, chess and whatever's on the table this week"})
book = call("POST", "/api/guilds", P, json={"name": "Book Nook"})["guild"]["id"]
call("PATCH", f"/api/guilds/{book}", P, json={"join_mode": "preview", "description": "One book a month, talk about it on Sundays"})
garden = call("POST", "/api/guilds", L, json={"name": "Garden Talk"})["guild"]["id"]
call("PATCH", f"/api/guilds/{garden}", L, json={"join_mode": "request", "description": "Tomatoes, roses and the never-ending fight with the deer"})
# a party, DMs and a voicemail for Maya
dm = call("POST", "/api/users/@me/channels", T, json={"recipient_id": people["maya"]["id"]})["id"]
say(T, dm, "Hey, are you around this afternoon?")
say(M, dm, "Back at 4! Call me then")
vm = upload(T, "Voicemail.wav", tone_wav(), "audio/wav")
call("POST", f"/api/channels/{dm}/messages", T, json={"content": "", "attachments": [{"id": vm["id"]}], "voice": {"duration_ms": 6000, "voicemail": True}})
party = call("POST", "/api/parties", L, json={"name": "Weekend crew", "user_ids": [people["maya"]["id"], people["priya"]["id"], people["sam"]["id"]]})
pid = party.get("id") or party.get("channel", {}).get("id")
if pid:
    say(L, pid, "Pancakes at my place Saturday?")
    say(P, pid, "I'm in 🥞")
# a request to join that Maya's staff will see
call("POST", f"/api/discover/{book}/request", S, json={"note": "Just finished the last one you picked!"})

# ---------------------------------------------------------------- screenshots
# a few people online while the pictures are taken
import threading, json as _json
from websocket import create_connection
def stay_online(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    def loop():
        while True:
            try:
                ws.recv()
            except Exception:
                return
    threading.Thread(target=loop, daemon=True).start()
for t in (T, P, L, J):
    stay_online(t)

# this demo has no voice server: hide the "couldn't connect to voice" notes it causes
HIDE = ".voice-panel.error, .voice-view.idle .form-error { display: none !important; }"

def open_app(b, tok, w, h, mobile=False):
    ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if mobile else 1.5, is_mobile=mobile, has_touch=mobile)
    pg = ctx.new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{tok}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    pg.add_style_tag(content=HIDE)
    return pg

def shot(pg, name):
    pg.wait_for_timeout(700)
    pg.screenshot(path=os.path.join(OUT, name + ".png"))
    print("shot", name)

with sync_playwright() as p:
    b = p.chromium.launch()
    # desktop
    pg = open_app(b, M, 1440, 900)
    shot(pg, "home-board")
    pg.click(".guild-btn[title='The Lake House']"); pg.wait_for_timeout(600)
    pg.locator(".channel").filter(has=pg.locator(".ellipsis", has_text="general")).first.click(); pg.wait_for_timeout(1200)
    shot(pg, "chat")
    pg.locator(".channel").filter(has=pg.locator(".ellipsis", has_text="Movie Night")).first.click(); pg.wait_for_timeout(1500)
    if pg.locator(".watch-tab:has-text('Queue')").count():
        pg.click(".watch-tab:has-text('Queue')"); pg.wait_for_timeout(500)
    shot(pg, "watch-party")
    pg.click(".discover-btn"); pg.wait_for_timeout(1000)
    shot(pg, "open-servers")
    pg.click(".discover-card:has-text('Book Nook')"); pg.wait_for_timeout(1000)
    shot(pg, "look-around")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    pg.click(".guild-btn.dms"); pg.wait_for_timeout(600)
    pg.click("text=Voicemail"); pg.wait_for_timeout(600)
    pg.locator(".vm-row").first.click(); pg.wait_for_timeout(600)
    shot(pg, "voicemail")
    pg.click(".guild-btn[title^='Friends']"); pg.wait_for_timeout(800)
    pg.locator(".dm-row:has-text('Lena')").first.click()
    pg.wait_for_timeout(800)
    shot(pg, "friends")
    pg.click("button[title='User Settings']"); pg.wait_for_timeout(600)
    pg.click("text=Voicemail >> nth=-1"); pg.wait_for_timeout(800)
    shot(pg, "settings-voicemail")
    pg.click("text=Appearance"); pg.wait_for_timeout(600)
    shot(pg, "settings-appearance")
    # phone
    ph = open_app(b, M, 390, 844, mobile=True)
    shot(ph, "phone-home")
    if ph.locator(".m-menu").count():
        ph.click(".m-menu"); ph.wait_for_timeout(400)
    ph.click(".guild-btn[title='The Lake House']"); ph.wait_for_timeout(600)
    shot(ph, "phone-spaces")
    ph.locator(".channel").filter(has=ph.locator(".ellipsis", has_text="general")).first.click(); ph.wait_for_timeout(1200)
    shot(ph, "phone-chat")
    b.close()
print("done")

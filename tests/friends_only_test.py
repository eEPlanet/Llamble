# Friends only, in a real call (needs a real LiveKit: LLAMBLE_LIVEKIT_BIN).
# Alex, Ben (Alex's friend) and Cara (not) are in a voice room. Alex picks "Friends only":
# - Cara can no longer get Alex's voice; Ben still can. Alex's video still reaches Cara.
# - Alex hears Ben but not Cara (her voice volume is 0 for Alex).
# - Everyone sees the friends-only mark on Alex in the room list.
# Then the per-person menu: volume shows %, Mute silences one person just for you.
# Back to "Hear everyone": Cara gets Alex's voice again.
import json, sys, time, requests
from websocket import create_connection
from playwright.sync_api import sync_playwright
B = sys.argv[1]
def ok(r):
    if r.status_code >= 300: raise SystemExit(f"FAIL {r.request.method} {r.url} {r.status_code} {r.text}")
    return r.json()
def wait(f, t=60, what=""):
    end = time.time() + t
    while time.time() < end:
        try:
            v = f()
            if v: return v
        except Exception: pass
        time.sleep(0.5)
    raise SystemExit("timed out: " + what)
a = ok(requests.post(B + "/api/setup", json={"username": "alex", "password": "hunter2hunter2", "server_name": "G"}))
TA = {"Authorization": "Bearer " + a["token"]}
gid = a["guild_id"]
ok(requests.put(B + "/api/admin/settings", headers=TA, json={"lan_ip": "127.0.0.1"}))
wait(lambda: ok(requests.get(B + "/api/admin/settings", headers=TA))["voice"]["state"] == "running", 60, "voice server running")
inv = ok(requests.post(B + f"/api/guilds/{gid}/invites", headers=TA, json={"max_uses": 5}))
ben = ok(requests.post(B + "/api/auth/register", json={"invite": inv["code"], "username": "ben", "password": "password123"}))
cara = ok(requests.post(B + "/api/auth/register", json={"invite": inv["code"], "username": "cara", "password": "password123"}))
TB = {"Authorization": "Bearer " + ben["token"]}
# Alex and Ben are friends; Cara isn't anyone's friend
ok(requests.post(B + "/api/friends", headers=TA, json={"username": "ben"}))
ok(requests.put(B + f"/api/friends/{a['user']['id']}", headers=TB))
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + a["token"]); ready = json.loads(ws.recv())["d"]; ws.close()
vc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "voice"][0]["id"]
ids = {"alex": a["user"]["id"], "ben": ben["user"]["id"], "cara": cara["user"]["id"]}

# can `who` get `whose` voice right now? (subscribed, or allowed and not refused)
GETS_VOICE = """([whose]) => { const r = window.llambleDebug.getRoom(); const p = r && r.remoteParticipants.get(whose);
  const t = p && p.getTrackPublication('microphone'); return !!t && t.isSubscribed && t.isAllowed !== false; }"""
VOICE_VOL = """([whose]) => { const r = window.llambleDebug.getRoom(); const p = r && r.remoteParticipants.get(whose); return p ? p.getVolume('microphone') : null; }"""

with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    pages = {}
    for name, tok in (("alex", a["token"]), ("ben", ben["token"]), ("cara", cara["token"])):
        ctx = br.new_context(viewport={"width": 1280, "height": 820}, permissions=["microphone", "camera"])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e, n=name: print(f"  [{n} error]", e))
        pg.goto(B)
        pg.evaluate("t=>{localStorage.setItem('llamble.token',t);localStorage.setItem('llamble.server',location.origin)}", tok)
        pg.reload()
        pg.wait_for_function("() => window.llambleDebug", timeout=30000)
        pg.wait_for_timeout(1200)
        pg.evaluate("vc => window.llambleDebug.joinVoice(vc)", vc)
        pg.click("button[title='G']")
        pages[name] = pg
    for n, pg in pages.items():
        for other in ids:
            if other != n:
                pg.wait_for_function(GETS_VOICE, arg=[ids[other]], timeout=60000, polling=500)
    print("three people in the room, everyone hears everyone")

    A = pages["alex"]
    A.click("button[aria-label^='Who you hear']")
    A.wait_for_timeout(300); A.screenshot(path="/tmp/shots/fo-menu.png")
    A.click(".ctx-menu >> text=Friends only")
    # Cara loses Alex's voice; Ben keeps it
    pages["cara"].wait_for_function(f"(a) => !({GETS_VOICE})(a)", arg=[ids["alex"]], timeout=30000, polling=500)
    time.sleep(2)
    assert pages["ben"].evaluate(GETS_VOICE, [ids["alex"]]), "a friend still hears Alex"
    # Alex hears Ben, not Cara
    assert A.evaluate(VOICE_VOL, [ids["cara"]]) == 0, A.evaluate(VOICE_VOL, [ids["cara"]])
    assert A.evaluate(VOICE_VOL, [ids["ben"]]) == 1, A.evaluate(VOICE_VOL, [ids["ben"]])
    # everyone sees the mark on Alex
    for pg in pages.values():
        pg.wait_for_selector(".voice-user:has-text('alex') [title^='Friends only']", timeout=10000)
    A.screenshot(path="/tmp/shots/fo-alex.png"); pages["cara"].screenshot(path="/tmp/shots/fo-cara.png")
    print("friends only: Cara can't get Alex's voice, Ben can; Alex hears only Ben; everyone sees the mark")

    # Alex's camera (like a screen share: not his voice) still reaches Cara
    A.evaluate("() => window.llambleDebug.getRoom().localParticipant.setCameraEnabled(true)")
    pages["cara"].wait_for_function("""([a]) => { const p = window.llambleDebug.getRoom().remoteParticipants.get(a); const t = p && p.getTrackPublication('camera'); return !!t && t.isSubscribed; }""", arg=[ids["alex"]], timeout=30000, polling=500)
    assert not pages["cara"].evaluate(GETS_VOICE, [ids["alex"]]), "still no voice"
    print("friends only: Alex's video still reaches Cara, without his voice")

    # per-person volume menu: %, and Mute just for me (Ben mutes Cara)
    Bp = pages["ben"]
    Bp.click(f".voice-user:has-text('cara')", button="right")
    Bp.wait_for_selector(".ctx-volume:has-text('100%')")
    Bp.click(".ctx-volume button:has-text('Mute')")
    Bp.wait_for_selector(".ctx-volume:has-text('Muted')")
    Bp.screenshot(path="/tmp/shots/fo-vol.png")
    assert Bp.evaluate(VOICE_VOL, [ids["cara"]]) == 0
    Bp.keyboard.press("Escape")
    Bp.wait_for_selector(".voice-user:has-text('cara') [title='Muted by you']")
    Bp.click(f".voice-user:has-text('cara')", button="right")
    Bp.click(".ctx-volume button:has-text('Unmute')")
    assert Bp.evaluate(VOICE_VOL, [ids["cara"]]) == 1
    Bp.keyboard.press("Escape")
    print("volume menu: shows %, Mute and Unmute just for you")

    # back to everyone
    A.click("button[aria-label^='Friends only']")
    A.click(".ctx-menu >> text=Hear everyone")
    pages["cara"].wait_for_function(GETS_VOICE, arg=[ids["alex"]], timeout=30000, polling=500)
    assert A.evaluate(VOICE_VOL, [ids["cara"]]) == 1
    pages["cara"].wait_for_function("(a) => !document.querySelector(\".voice-user [title^='Friends only']\")", arg=None, timeout=10000)
    print("hear everyone again: Cara gets Alex's voice back")
    br.close()
print("OK friends only")

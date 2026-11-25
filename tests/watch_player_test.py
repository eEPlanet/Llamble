# The Watch Party player in a browser, in a real room (needs a real LiveKit: LLAMBLE_LIVEKIT_BIN).
# - Back/forward 15 seconds, and holding the button keeps going
# - "Mute everyone" and "Friends only" buttons under the player
# - Full screen: the bar fades after a few seconds, comes back on a move; chat opens over the
#   movie; Esc leaves full screen
# - Coming back to a playing movie: the picture plays (not a black frame)
# - Everyone leaves: the movie holds its place; the next person in picks up from there
import sys, time, json, requests
from websocket import create_connection
from playwright.sync_api import sync_playwright
B = sys.argv[1]
def ok(r):
    if r.status_code >= 300: raise SystemExit(f"FAIL {r.request.method} {r.url} {r.status_code} {r.text}")
    return r.json() if r.text else None
def wait(f, t=60, what=""):
    end = time.time() + t
    while time.time() < end:
        try:
            v = f()
            if v: return v
        except Exception: pass
        time.sleep(0.5)
    raise SystemExit("timed out: " + what)
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "hunter2hunter2", "server_name": "Family"}))
H = {"Authorization": "Bearer " + s["token"]}
gid = s["guild_id"]
ok(requests.put(B + "/api/admin/settings", headers=H, json={"lan_ip": "127.0.0.1"}))
wait(lambda: ok(requests.get(B + "/api/admin/settings", headers=H))["voice"]["state"] == "running", 60, "voice server")
w = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H, json={"name": "Movie Night", "kind": "watch"}))
cid = w["id"]
# a 2-minute movie in the library
with open("/tmp/movie.webm", "rb") as f:
    up = requests.post(B + "/api/files?purpose=library", headers=H, files={"file": ("Test Pattern.webm", f, "video/webm")}).json()
up = up[0] if isinstance(up, list) else up
ok(requests.post(B + "/api/watch/library", headers=H, json={"file_id": up["id"], "title": "Test Pattern"}))
with open("/tmp/movie.webm", "rb") as f:
    up2 = requests.post(B + "/api/files?purpose=library", headers=H, files={"file": ("Second.webm", f, "video/webm")}).json()
up2 = up2[0] if isinstance(up2, list) else up2
ok(requests.post(B + "/api/watch/library", headers=H, json={"file_id": up2["id"], "title": "Second Feature"}))
state = lambda: ok(requests.get(f"{B}/api/channels/{cid}/watch", headers=H))
def room_pos():
    st = state(); n = st["now"]
    return n["pos_ms"] + (st["server_now"] - n["at_ms"] if n["playing"] else 0)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, permissions=["microphone"])
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: print("  [page error]", e))
    pg.goto(B); pg.evaluate("t=>{localStorage.setItem('llamble.token',t)}", s["token"]); pg.reload()
    pg.wait_for_function("() => window.llambleDebug", timeout=30000); pg.wait_for_timeout(1000)
    pg.click("button[title='Family']"); pg.wait_for_timeout(400)
    pg.click(".channel:has-text('Movie Night')"); pg.wait_for_timeout(800)
    pg.wait_for_selector(".watch-stage, .voice-view", timeout=15000)
    pg.wait_for_selector(".watch-stage", timeout=30000)
    ok(requests.post(f"{B}/api/channels/{cid}/watch/queue", headers=H, json={"kind": "library", "src": up["id"]}))
    pg.wait_for_function("() => { const v = document.querySelector('video.watch-video'); return v && !v.paused && v.currentTime > 1; }", timeout=30000)
    print("movie playing in the room")

    # a slow connection (the player keeps running short of data): it keeps playing instead of
    # being jumped around (each jump makes a converted stream start over)
    cdp = ctx.new_cdp_session(pg)
    cdp.send("Network.enable")
    cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 150, "downloadThroughput": 60_000, "uploadThroughput": 60_000})
    pg.evaluate("() => { const v = document.querySelector('video.watch-video'); window.__seeks = 0; v.addEventListener('seeking', () => window.__seeks++); }")
    t0 = pg.evaluate("() => document.querySelector('video.watch-video').currentTime")
    pg.wait_for_timeout(15000)
    seeks, t1 = pg.evaluate("() => [window.__seeks, document.querySelector('video.watch-video').currentTime]")
    cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    print(f"slow connection: {seeks} jumps in 15 s, played {t1 - t0:.1f} s")
    assert seeks <= 1, f"jumped around {seeks} times"
    assert t1 - t0 > 8, "kept playing"

    # forward 15
    before = room_pos()
    pg.click("button[title^='Forward 15']")
    wait(lambda: room_pos() > before + 13_000, 10, "forward 15")
    # back 15
    before = room_pos()
    pg.click("button[title^='Back 15']")
    wait(lambda: room_pos() < before - 12_000, 10, "back 15")
    # hold forward: keeps going (well past 15 s)
    before = room_pos()
    btn = pg.locator("button[title^='Forward 15']").bounding_box()
    pg.mouse.move(btn["x"] + 10, btn["y"] + 10); pg.mouse.down(); pg.wait_for_timeout(1600); pg.mouse.up()
    wait(lambda: room_pos() > before + 40_000, 10, "hold to fast forward")
    print("back/forward 15 s, and hold to keep going")

    # the two mute choices under the player
    pg.click(".watch-controls button:has-text('Mute everyone')")
    pg.wait_for_selector(".watch-controls button.red:has-text('Everyone muted')")
    pg.click(".watch-controls button:has-text('Friends only')")
    pg.wait_for_selector(".watch-controls button.green:has-text('Friends only: on')")
    assert pg.locator(".watch-controls button.red").count() == 0, "picking one turns the other off"
    pg.click(".watch-controls button:has-text('Friends only: on')")
    print("mute everyone / friends only buttons")

    # Next: the next movie starts by itself, picture and all (no pause/play needed)
    ok(requests.post(f"{B}/api/channels/{cid}/watch/queue", headers=H, json={"kind": "library", "src": up2["id"]}))
    pg.click(".watch-controls button:has-text('Next')")
    pg.wait_for_selector(".watch-now:has-text('Second Feature')", timeout=10000)
    pg.wait_for_function("() => { const v = document.querySelector('video.watch-video'); return v && !v.paused && v.currentTime > 1.5; }", timeout=20000)
    print("next: the next movie plays by itself")

    # full screen
    pg.click("button:has-text('Full screen')")
    pg.wait_for_selector(".watch-split.full")
    pg.screenshot(path="/tmp/shots/watch-full.png")
    pg.wait_for_selector(".watch-split.full.bar-hidden", timeout=6000)
    pg.mouse.move(600, 400); pg.mouse.move(640, 420)
    pg.wait_for_selector(".watch-split.full:not(.bar-hidden)", timeout=3000)
    pg.click(".watch-bar button:has-text('Chat')")
    pg.wait_for_selector(".watch-split.full-chat .watch-chat .composer", timeout=5000)
    pg.mouse.move(300, 300); pg.wait_for_timeout(700); pg.screenshot(path="/tmp/shots/watch-full-chat.png")
    pg.keyboard.press("Escape")
    pg.wait_for_selector(".watch-split:not(.full)", timeout=3000)
    print("full screen: bar fades and comes back, chat over the movie, Esc leaves")

    # leave while it's playing: it holds its place
    assert state()["now"]["playing"]
    pg.click(".watch-call button[title='Disconnect']")
    wait(lambda: not state()["now"]["playing"], 10, "held when everyone left")
    held = state()["now"]["pos_ms"]
    time.sleep(3)
    assert state()["now"]["pos_ms"] == held and not state()["now"]["playing"], "stays put while nobody's there"
    print(f"everyone left: held at {held // 1000} s")

    # come back: it picks up from there, and the picture plays
    pg.click(".voice-view.idle button:has-text('Join Watch Party')")
    wait(lambda: state()["now"]["playing"], 15, "carries on for whoever comes back")
    assert abs(room_pos() - held) < 5000, (room_pos(), held)
    pg.wait_for_function(f"() => {{ const v = document.querySelector('video.watch-video'); return v && !v.paused && v.readyState >= 3 && Math.abs(v.currentTime * 1000 - {held}) < 8000; }}", timeout=20000)
    t1 = pg.evaluate("() => document.querySelector('video.watch-video').currentTime"); pg.wait_for_timeout(1500)
    t2 = pg.evaluate("() => document.querySelector('video.watch-video').currentTime")
    assert t2 > t1 + 0.8, ("the picture moves", t1, t2)
    print("came back: picks up where it was held, and the picture plays")
    b.close()
print("OK watch player")

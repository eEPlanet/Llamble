# Watch Party playing Jellyfin movies (needs a real LiveKit: LLAMBLE_LIVEKIT_BIN).
# - The movie starts right away even when Jellyfin takes a long time to pull out subtitles
#   (they load later, only the track that's turned on)
# - Next / leaving tells Jellyfin to stop converting the old one
# - A movie that won't load is retried by itself, then Play becomes "Try again" (no autoplay note)
import sys, os, time, subprocess, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ, FAKE_JF_VIDEO="/tmp/movie.webm", FAKE_JF_SLOW_SUBS="30")
jf = subprocess.Popen([sys.executable, os.path.join(here, "fake_jellyfin.py"), "8198"], env=env)
JF = "http://127.0.0.1:8198"
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
try:
    time.sleep(0.8)
    s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "hunter2hunter2", "server_name": "Family"}))
    H = {"Authorization": "Bearer " + s["token"]}
    gid = s["guild_id"]
    ok(requests.put(B + "/api/admin/settings", headers=H, json={"lan_ip": "127.0.0.1", "jellyfin_url": JF, "jellyfin_key": "test-jf-key"}))
    ok(requests.put(B + "/api/admin/settings", headers=H, json={"jellyfin_libraries": ["movielib"]}))
    wait(lambda: ok(requests.get(B + "/api/admin/settings", headers=H))["voice"]["state"] == "running", 60, "voice server")
    cid = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H, json={"name": "Movie Night", "kind": "watch"}))["id"]
    test = lambda: requests.get(JF + "/_test").json()
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
        ctx = b.new_context(viewport={"width": 1280, "height": 800}, permissions=["microphone"])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: print("  [page error]", e))
        pg.goto(B); pg.evaluate("t=>{localStorage.setItem('llamble.token',t); localStorage.setItem('llamble.cc','1')}", s["token"]); pg.reload()
        pg.wait_for_function("() => window.llambleDebug", timeout=30000); pg.wait_for_timeout(1000)
        pg.click("button[title='Family']"); pg.wait_for_timeout(400)
        pg.click(".channel:has-text('Movie Night')"); pg.wait_for_timeout(800)
        pg.wait_for_selector(".watch-stage", timeout=30000)

        # subtitles take 30 s: the movie plays long before that
        ok(requests.post(f"{B}/api/channels/{cid}/watch/queue", headers=H, json={"kind": "jellyfin", "src": "m3"}))
        t0 = time.time()
        pg.wait_for_function("() => { const v = document.querySelector('video.watch-video'); return v && !v.paused && v.currentTime > 1; }", timeout=20000)
        print(f"movie playing after {time.time() - t0:.1f}s (subtitles still loading)")
        assert time.time() - t0 < 20
        wait(lambda: test()["subs"], 10, "subtitle asked for")
        assert set(test()["subs"]) == {"2"}, ("only the default track is fetched", test()["subs"])
        # CC shows up once the slow track arrives
        pg.wait_for_function("() => { const v = document.querySelector('video.watch-video'); return v && v.textTracks.length === 1 && v.textTracks[0].mode === 'showing'; }", timeout=45000)
        print("subtitles arrived later, only the one turned on")

        # Next: Jellyfin is told to stop converting the old one
        ok(requests.post(f"{B}/api/channels/{cid}/watch/queue", headers=H, json={"kind": "jellyfin", "src": "m1"}))
        pg.click(".watch-controls button:has-text('Next')")
        wait(lambda: test()["stops"], 10, "stop after Next")
        assert "deviceId=llamble-" in test()["stops"][0] and "playSessionId=" in test()["stops"][0], test()["stops"]
        print("Next: Jellyfin told to stop converting the last movie")

        # m1 is a broken file (and its converted stream too): it tries by itself, then Try again
        pg.wait_for_selector(".watch-problem:has-text('Trying again')", timeout=20000)
        pg.wait_for_selector(".watch-controls button:has-text('Try again')", timeout=40000)
        assert not pg.locator(".watch-problem:has-text('autoplay')").count(), "no autoplay note for a loading problem"
        assert not pg.locator(".watch-controls button:has-text('Play'), .watch-controls button:has-text('Pause')").count()
        pg.screenshot(path="/tmp/jf-try-again.png")
        stops = len(test()["stops"])
        sessions = lambda: pg.evaluate("() => document.querySelector('video.watch-video').getAttribute('src') || ''")
        before = sessions()
        pg.click(".watch-controls button:has-text('Try again')")
        wait(lambda: len(test()["stops"]) > stops, 10, "the old try stopped")
        pg.wait_for_selector(".watch-controls button:has-text('Try again')", timeout=30000)  # fails again, button back
        assert sessions() != before, "a fresh stream was asked for"
        print("broken movie: retried by itself, then Try again (and it tries again)")

        # back to a good movie: Try again goes away, Play/Pause is back
        ok(requests.post(f"{B}/api/channels/{cid}/watch/queue", headers=H, json={"kind": "jellyfin", "src": "m3"}))
        pg.click(".watch-controls button:has-text('Next')")
        pg.wait_for_function("() => { const v = document.querySelector('video.watch-video'); return v && !v.paused && v.currentTime > 1; }", timeout=30000)
        assert not pg.locator(".watch-controls button:has-text('Try again')").count()
        assert pg.locator(".watch-controls button:has-text('Pause')").count()
        # leaving the space (still in the call) stops this player's stream too
        stops = len(test()["stops"])
        pg.click(".channel:has-text('general')"); pg.wait_for_timeout(1500)
        wait(lambda: len(test()["stops"]) > stops, 10, "stop after leaving")
        # and coming back plays again
        pg.click(".channel:has-text('Movie Night')")
        pg.wait_for_function("() => { const v = document.querySelector('video.watch-video'); return v && !v.paused && v.currentTime > 1; }", timeout=30000)
        print("left and came back: plays again")
        b.close()
    print("JELLYFIN PLAYER OK")
finally:
    jf.terminate()

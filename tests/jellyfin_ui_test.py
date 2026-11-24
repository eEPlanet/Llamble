# Settings → Watch Party in a browser: connect Jellyfin (the stand-in), choose a library to
# share, and the uploaded-movie list with its poster and CC.
import sys, os, subprocess, time, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
here = os.path.dirname(os.path.abspath(__file__))
jf = subprocess.Popen([sys.executable, os.path.join(here, "fake_jellyfin.py"), "8197"])
time.sleep(0.8)
try:
    s = requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}).json()
    M = s["token"]
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_context(viewport={"width": 1280, "height": 900}).new_page()
        pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
        pg.click("button[title='User Settings']"); pg.wait_for_timeout(600)
        pg.click("text=Settings & Updates")
        pg.wait_for_timeout(800)
        pg.locator("text=Watch Party").first.scroll_into_view_if_needed()
        pg.fill("input[placeholder='http://your-nas:8096']", "http://127.0.0.1:8197")
        pg.fill("input[placeholder^='API key']", "test-jf-key")
        pg.click("button:has-text('Connect')"); pg.wait_for_timeout(1200)
        pg.wait_for_selector(".jf-lib-row:has-text('Home Videos')")
        pg.click(".jf-lib-row:has-text('Movies') input[type=checkbox]"); pg.wait_for_timeout(600)
        r = requests.get(B + "/api/admin/settings", headers={"Authorization": "Bearer " + M}).json()["settings"]
        assert r["jellyfin_libraries"] == ["movielib"], r["jellyfin_libraries"]
        pg.locator(".watch-admin-lib").first.scroll_into_view_if_needed()
        pg.screenshot(path=f"{OUT}/jellyfin-setup.png")
        b.close()
    print("jellyfin ui ok")
finally:
    jf.terminate()

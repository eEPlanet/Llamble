# Phones: swiping right brings back the menu (servers and channels), swiping left goes back to
# the page; a server whose board has something new gets a dot, and tapping it opens the board.
import sys, os, time, requests
from playwright.sync_api import sync_playwright
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
k_id = ok(requests.get(B + "/api/users/@me", headers=H(K)))["id"]

def swipe(pg, x0, x1, y=400):
    pg.evaluate("""([x0, x1, y]) => {
      const t = (x) => new Touch({ identifier: 1, target: document.elementFromPoint(x0, y) || document.body, clientX: x, clientY: y });
      const el = document.elementFromPoint(x0, y) || document.body;
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(x0)], changedTouches: [t(x0)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(x1)], bubbles: true }));
    }""", [x0, x1, y])
    pg.wait_for_timeout(300)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 400, "height": 800}, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{K}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    shell = pg.locator(".shell")
    # open a chat: the page is on screen, the menu isn't
    if "m-nav" not in shell.get_attribute("class"):
        pg.click(".m-menu"); pg.wait_for_timeout(300)
    pg.click(f".guild-btn[data-gid='{gid}']"); pg.wait_for_timeout(500)
    # nothing new on the board: tapping the server shows its channel list
    assert "m-nav" in shell.get_attribute("class"), shell.get_attribute("class")
    assert pg.locator(f".guild-btn[data-gid='{gid}'] .board-dot").count() == 0
    pg.click(".channel:has-text('general')"); pg.wait_for_timeout(500)
    assert "m-main" in shell.get_attribute("class")
    # swipe right: the menu comes back; swipe left: back to the chat
    swipe(pg, 60, 300)
    assert "m-nav" in shell.get_attribute("class"), "swipe right didn't open the menu"
    pg.screenshot(path=f"{OUT}/phone-swipe-menu.png")
    swipe(pg, 300, 60)
    assert "m-main" in shell.get_attribute("class"), "swipe left didn't go back to the page"
    # a slow drag or an up/down scroll does nothing
    pg.evaluate("""() => {
      const el = document.querySelector('.main');
      const t = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(100, 200)], changedTouches: [t(100, 200)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(180, 600)], bubbles: true }));
    }""")
    pg.wait_for_timeout(300)
    assert "m-main" in shell.get_attribute("class"), "a scroll opened the menu"
    print("swipe right opens the menu, left goes back, scrolling doesn't")

    # someone posts a note to the server's board: a dot on its icon
    ok(requests.post(f"{B}/api/guilds/{gid}/notes", headers=H(M), json={"content": "Pizza night Friday!", "color": "yellow", "to": []}))
    pg.wait_for_selector(f".guild-btn[data-gid='{gid}'] .board-dot", state="attached", timeout=5000)
    swipe(pg, 60, 300)
    pg.screenshot(path=f"{OUT}/phone-board-dot.png")
    assert pg.locator(".guild-logo .board-dot").count() == 1, "Home has no dot"
    # tapping the server now opens its board, full screen
    pg.click(f".guild-btn[data-gid='{gid}']"); pg.wait_for_timeout(600)
    assert "m-main" in shell.get_attribute("class"), "the board didn't open"
    assert pg.locator("text=Pizza night Friday!").count() > 0
    pg.wait_for_timeout(300)
    assert pg.locator(f".guild-btn[data-gid='{gid}'] .board-dot").count() == 0, "dot still there after seeing the board"
    assert pg.locator(".guild-logo .board-dot").count() == 0, "Home's dot stayed after seeing it on the server"
    # seen: next tap shows the channel list again
    swipe(pg, 60, 300)
    pg.click(f".guild-btn[data-gid='{gid}']"); pg.wait_for_timeout(500)
    assert "m-nav" in shell.get_attribute("class")
    print("new on the board: dot, and the server opens to its board; once seen, back to the list")

    # seen on Home instead: clears the server's dot too
    ok(requests.post(f"{B}/api/guilds/{gid}/notes", headers=H(M), json={"content": "Movie night Saturday", "color": "blue", "to": []}))
    pg.wait_for_selector(".guild-logo .board-dot", state="attached", timeout=5000)
    assert pg.locator(f".guild-btn[data-gid='{gid}'] .board-dot").count() == 1
    pg.click(".guild-logo"); pg.wait_for_timeout(300)
    if "m-nav" in shell.get_attribute("class"):
        swipe(pg, 300, 60)
    pg.wait_for_timeout(500)
    assert pg.locator("text=Movie night Saturday").count() > 0
    assert pg.locator(f".guild-btn[data-gid='{gid}'] .board-dot").count() == 0, "server dot stayed after seeing it on Home"
    assert pg.locator(".guild-logo .board-dot").count() == 0
    print("seen on Home: both dots clear")
    b.close()
print("phone nav ok")

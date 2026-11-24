# The tutorial in a browser: a new account is offered it, walks every step in the practice
# world (chat, reactions, a picture, the bot, a voice room, a DM, a friend request, staff tools,
# settings), and afterwards the real server is untouched and the tour isn't offered again.
import sys, os, struct, zlib, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "demo-pass-123", "display_name": "Bran", "server_name": "Family"}).json()
T = s["token"]
gid = s["guild_id"]
def png(path):
    raw = b"".join(b"\x00" + bytes([200, 120, 60] * 32) for _ in range(24))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 24, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
png("/tmp/tut.png")
errors = []

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1280, "height": 860}, permissions=["microphone", "camera"])
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: (errors.append(str(e)), print("PAGEERROR", e)))
    pg.on("console", lambda m: m.type == "error" and print("CONSOLE", m.text))
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{T}')"); pg.goto(B + "/")
    pg.wait_for_selector("text=Welcome to Llamble, Bran!", timeout=15000)
    pg.screenshot(path=f"{OUT}/tut-00-welcome.png")
    pg.click(".tut-card button:has-text('Start')")
    n = [0]
    def at(title):
        pg.wait_for_selector(f'.tut-card h3:text-is("{title}")', timeout=10000)
        n[0] += 1
        pg.wait_for_timeout(350)
        pg.screenshot(path=f"{OUT}/tut-{n[0]:02d}-{title.lower().replace(' ', '-').replace('&', 'and')}.png")
        print("step", title)
    def nxt(): pg.click(".tut-card button:has-text('Next')")

    at("Home"); nxt()
    at("Servers"); pg.click("button[title='Practice Server']")
    at("Spaces"); pg.click(".channel:has-text('general')")
    at("Say hello"); pg.fill(".composer textarea", "Hello everyone!"); pg.keyboard.press("Enter")
    at("React")
    maya = pg.locator(".msg:has-text('Welcome 😊')").last
    maya.hover(); pg.wait_for_timeout(200)
    maya.locator(".msg-toolbar button").first.click()
    at("Share a picture")
    pg.set_input_files(".composer input[type=file]", "/tmp/tut.png")
    pg.wait_for_timeout(400); pg.keyboard.press("Enter")
    at("Ask Llamble"); pg.fill(".composer textarea", "@Llamble what can you do?"); pg.keyboard.press("Enter")
    at("Voice & Video"); pg.click(".channel:has-text('Hangout')")
    at("You're in"); pg.wait_for_timeout(1500); nxt()
    at("Leave"); pg.click(".practice-leave")
    at("Watch together"); pg.click(".channel:has-text('Movie Night')")
    at("Movie Night"); pg.click(".practice-poster:has-text('The Lost Kite')"); pg.wait_for_timeout(800)
    pg.screenshot(path=f"{OUT}/tut-watch-playing.png"); pg.click(".practice-leave")
    at("Talk"); pg.click("[data-tut=talk]")
    at("Direct messages"); pg.click(".dm-row:has-text('Maya')")
    pg.fill(".composer textarea", "Hi Maya!"); pg.keyboard.press("Enter")
    at("Friends"); pg.click("[data-tut=friends]"); pg.wait_for_timeout(400)
    pg.click("[data-uid] button[title='Accept']")
    at("Find servers"); nxt()
    at("Staff tools"); nxt()
    at("Remove a message")
    rex = pg.locator(".msg:has-text('CHEAP GAME COINS')")
    rex.hover(); rex.locator(".msg-toolbar button[title='More']").click()
    pg.click(".ctx-menu >> text=Delete"); pg.click(".modal button.danger, .modal button.red", timeout=3000)
    at("Kick someone")
    pg.click(".member-list .member:has-text('Rex')", button="right", timeout=5000)
    pg.click(".ctx-menu >> text=Kick", timeout=5000)
    pg.click(".modal button:has-text('Kick')", timeout=5000)
    at("Add a space"); pg.click(".tut-card button:has-text('Skip this step')")
    at("Server settings"); pg.click(".tut-card button:has-text('Skip this step')")
    at("Your settings"); pg.click("button[title='User Settings']")
    at("Look around")
    # a real setting can't be changed from practice
    nxt()
    pg.wait_for_selector("text=That's the tour!")
    pg.screenshot(path=f"{OUT}/tut-99-done.png")
    pg.click(".tut-card button:has-text('Finish')")
    # back to the real Llamble
    pg.wait_for_selector("button[title='Family']", timeout=15000)
    assert pg.locator("button[title='Practice Server']").count() == 0
    # nothing from practice reached the server
    pg.click("button[title='Family']"); pg.wait_for_timeout(500)
    pg.click(".channel:has-text('general')"); pg.wait_for_timeout(1200)
    assert pg.locator(".msg:has-text('Hello everyone!')").count() == 0
    # not offered again
    pg.reload(); pg.wait_for_selector("button[title='Family']", timeout=15000); pg.wait_for_timeout(1500)
    assert pg.locator("text=Welcome to Llamble, Bran!").count() == 0
    # replay from Settings
    pg.click("button[title='User Settings']"); pg.click("text=Tutorial"); pg.click("button:has-text('Start the tutorial')")
    pg.wait_for_selector("text=Welcome to Llamble, Bran!")
    pg.click(".tut-card button:has-text('Skip tutorial')")
    pg.wait_for_selector("button[title='Family']", timeout=15000)
    b.close()
assert not errors, errors
print("OK tutorial")

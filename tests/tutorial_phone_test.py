# The tutorial on a phone: at "Direct messages", once Maya's chat is open the card moves to the top
# so it never covers the message box, and sending her something moves on.
import sys, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "demo-pass-123", "server_name": "Family"}).json()
T = s["token"]
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 412, "height": 860}, has_touch=True, is_mobile=True).new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{T}')"); pg.goto(B + "/")
    pg.wait_for_selector("text=Welcome to Llamble, Bran!", timeout=15000)
    pg.click(".tut-card button:has-text('Start')"); pg.wait_for_timeout(800)
    pg.evaluate("""async () => { const t = await window.llambleDebug.tour(); const i = t.useTour.getState().steps.findIndex(s => s.id === 'dm'); t.goStep(i); }""")
    pg.wait_for_timeout(800)
    # tap Maya's chat in the list
    pg.click('[data-tut="talk"]'); pg.wait_for_timeout(800)
    pg.locator(".dm-row:has-text('Maya')").first.click(); pg.wait_for_timeout(1200)
    pg.screenshot(path="/tmp/shots/tut-phone-dm.png")
    card = pg.locator(".tut-card").bounding_box(); comp = pg.locator(".composer").bounding_box()
    print("card", card, "composer", comp)
    assert card["y"] + card["height"] <= comp["y"], "card covers the message box"
    pg.locator(".composer textarea").fill("hi Maya"); pg.keyboard.press("Enter"); pg.wait_for_timeout(1000)
    assert pg.locator(".tut-card h3").first.inner_text() != "Direct messages", "didn't move on after sending"
    print("tutorial on a phone: the card stays off the message box")
    b.close()

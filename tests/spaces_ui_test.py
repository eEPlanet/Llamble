# The space list: Board, then SPACES with its +; spaces sort under Chat / Voice & Video / Watch
# by themselves; staff make groups ("Gaming") and move spaces in with Move to… or by dragging;
# a type heading goes away when nothing's left under it; deleting a group keeps its spaces.
import sys, os, re, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
s = requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}).json()
M = s["token"]
def heads(pg):
    return [t.strip().lower() for t in pg.locator(".category-head").all_inner_texts()]
def under(pg, head):
    for c in pg.locator(".category").all():
        if c.locator(".category-head").inner_text().strip().lower() == head.lower():
            return [t.strip() for t in c.locator(".channel .ellipsis").all_inner_texts()]
    return []
def head(pg, name):
    return pg.locator(".category-head").filter(has_text=re.compile(f"^{name}$", re.I)).first
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1280, "height": 860}).new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    pg.click(".guild-btn[title='Family']"); pg.wait_for_timeout(800)
    assert heads(pg) == ["chat", "voice & video"], heads(pg)
    # add a Watch Party space: a Watch heading appears with it
    pg.click(".spaces-head button"); pg.click("text=Add a Space"); pg.wait_for_timeout(300)
    pg.click(".kind-opt:has-text('Watch Party') input")
    pg.fill("input[placeholder='Movie Night']", "Movie Night"); pg.click(".modal button:has-text('Create')"); pg.wait_for_timeout(800)
    # and two more chats land under Chat
    for n in ("games", "memes"):
        pg.click(".spaces-head button"); pg.click("text=Add a Space"); pg.wait_for_timeout(300)
        pg.fill("input[placeholder='new-chat']", n); pg.click(".modal button:has-text('Create')"); pg.wait_for_timeout(800)
    assert heads(pg) == ["chat", "voice & video", "watch"], heads(pg)
    assert sorted(under(pg, "Chat")) == ["games", "general", "memes"], under(pg, "Chat")
    pg.screenshot(path=f"{OUT}/spaces-by-type.png")
    # make a group, move a chat and the voice room into it (Move to… and New group…)
    pg.click(".spaces-head button"); pg.click("text=Make a Group"); pg.wait_for_timeout(300)
    pg.fill("input[placeholder='Gaming']", "Gaming"); pg.click(".modal button:has-text('Create')"); pg.wait_for_timeout(800)
    pg.locator(".channel").filter(has=pg.locator(".ellipsis", has_text=re.compile("^games$"))).first.click(button="right"); pg.click("text=Move to…"); pg.wait_for_timeout(300)
    pg.click(".context-menu >> text=Gaming") if pg.locator(".context-menu").count() else pg.click("text=Gaming >> nth=-1")
    pg.wait_for_timeout(800)
    # drag the voice room onto the group
    pg.locator(".channel").filter(has=pg.locator(".ellipsis", has_text=re.compile("^General$"))).first.drag_to(head(pg, "Gaming"))
    pg.wait_for_timeout(800)
    assert sorted(under(pg, "Gaming")) == ["General", "games"], under(pg, "Gaming")
    assert "voice & video" not in heads(pg), heads(pg)  # nothing left under it
    pg.screenshot(path=f"{OUT}/spaces-with-group.png")
    # back out: No group
    pg.locator(".channel").filter(has=pg.locator(".ellipsis", has_text=re.compile("^games$"))).first.click(button="right"); pg.click("text=Move to…"); pg.wait_for_timeout(300)
    pg.click("text=No group (under Chat)"); pg.wait_for_timeout(800)
    assert "games" in under(pg, "Chat")
    # delete the group: the voice room goes back under Voice & Video
    head(pg, "Gaming").click(button="right"); pg.click("text=Delete Group"); pg.wait_for_timeout(300)
    pg.click(".modal button:has-text('Delete Group')"); pg.wait_for_timeout(1000)
    assert "gaming" not in heads(pg) and under(pg, "Voice & Video") == ["General"], (heads(pg), under(pg, "Voice & Video"))
    b.close()
print("spaces ui ok")

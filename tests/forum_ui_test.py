# Forum spaces in the app: add one, write a post, reply, branch a reply, quote, like, pick the
# best answer; on a PC and on a phone. Saves screenshots.
import sys, os, json, requests
from playwright.sync_api import sync_playwright
from websocket import create_connection
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None

s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Lake House"}))
M, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
users = {}
for n in ["sam", "theo", "lena"]:
    users[n] = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": n, "password": "pass-word-123"}))["token"]
    ok(requests.patch(B + "/api/users/@me", headers=H(users[n]), json={"display_name": n.title()}))
ok(requests.patch(B + "/api/users/@me", headers=H(M), json={"display_name": "Maya"}))

def page(p, tok, w=1280, h=900, mobile=False):
    ctx = p.chromium.launch().new_context(viewport={"width": w, "height": h}, is_mobile=mobile, has_touch=mobile)
    pg = ctx.new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{tok}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    return pg

with sync_playwright() as p:
    pg = page(p, M)
    pg.click(f".guild-btn[data-gid='{gid}']"); pg.wait_for_timeout(500)
    # add a forum space from the sidebar's Add a Space
    fid = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "Help and questions", "kind": "forum"}))["id"]
    pg.wait_for_timeout(1000)
    pg.locator(".channel:has-text('Help and questions')").first.click(); pg.wait_for_timeout(800)
    assert pg.locator(".forum >> text=No posts yet").count()
    pg.locator(".forum button:has-text('New post')").click()
    pg.locator(".forum-new input[placeholder='Title']").fill("Best settings for streaming the Shield to the lake house?")
    pg.locator(".forum-new textarea").fill("Picture stutters every few minutes. Wi-Fi is decent. Ideas?")
    pg.locator(".forum-new input[placeholder^='Tags']").fill("streaming wifi")
    pg.locator(".forum-new button:has-text('Post')").click(); pg.wait_for_timeout(1000)
    assert pg.locator(".forum .is-post .fc-title:has-text('Best settings')").count(), "the new post opens"
    pid = ok(requests.get(f"{B}/api/channels/{fid}/forum", headers=H(M)))["posts"][0]["id"]

    # others reply (one branches, one quotes)
    send = lambda t, body: ok(requests.post(f"{B}/api/channels/{fid}/messages", headers=H(t), json=body))
    r1 = send(users["sam"], {"thread_id": pid, "content": "Try wired if you can. Wi-Fi drops are usually the cause."})["id"]
    r2 = send(users["theo"], {"thread_id": pid, "reply_to": r1, "content": "No cable run out there though."})["id"]
    r3 = send(users["sam"], {"thread_id": pid, "reply_to": r2, "content": "A powerline adapter works through the outlets."})["id"]
    for t in [users["lena"], users["theo"], M]:
        ok(requests.put(f"{B}/api/messages/{r3}/reactions/%E2%9D%A4%EF%B8%8F", headers=H(t)))
    send(users["lena"], {"thread_id": pid, "content": "That fixed ours. Also drop the stream to 1080p.", "quotes": [r3]})
    pg.wait_for_timeout(1200)
    assert pg.locator(".fc-branch .forum-card.branch").count() >= 2, "branches drawn"
    assert pg.locator(".fc-quote:has-text('powerline')").count(), "quote shown"
    # Maya replies to the post from the bottom box, then marks the best answer
    pg.locator(".forum-reply-box textarea").last.fill("Got the adapter, works great now!")
    pg.locator(".forum-reply-box button:has-text('Reply')").last.click(); pg.wait_for_timeout(1000)
    pg.locator(f"#fr-{r3} button[title='More']").click(); pg.wait_for_timeout(300)
    pg.locator(".ctx-menu >> text=Mark as best answer").click(); pg.wait_for_timeout(1000)
    assert pg.locator(".fc-best:has-text('powerline')").count(), "best answer under the question"
    # reply to a reply inline
    pg.locator(f"#fr-{r1} button:has-text('Reply')").first.click()
    pg.locator(f"#fr-{r1} .forum-reply-box textarea").fill("Agreed, wired is best.")
    pg.locator(f"#fr-{r1} .forum-reply-box button:has-text('Reply')").click(); pg.wait_for_timeout(1000)
    t = ok(requests.get(f"{B}/api/channels/{fid}/forum/{pid}", headers=H(M)))
    assert any(r["content"] == "Agreed, wired is best." and (r["reply_to"] or {}).get("id") == r1 for r in t["replies"])
    pg.evaluate("document.querySelector('.forum-scroll').scrollTop = 0"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/forum-thread.png", full_page=False)
    pg.locator(".forum-scroll").last.evaluate("e => e.scrollTop = 400"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/forum-thread-2.png")
    # back to the list
    pg.locator(".forum button[title='All posts']").click(); pg.wait_for_timeout(800)
    send(users["theo"], {"title": "Movie night Friday?", "content": "Who's in?", "tags": ["events"]})
    # a picture post from the New post form
    import io
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (900, 500), (22, 40, 70)); d = ImageDraw.Draw(im)
    d.rectangle([0, 300, 900, 500], fill=(30, 90, 140)); d.ellipse([560, 120, 720, 280], fill=(240, 122, 58))
    im.save("/tmp/lake.png")
    pg.locator(".forum button:has-text('New post')").click()
    pg.locator(".forum-new input[placeholder='Title']").fill("Sunset from the dock")
    pg.locator(".forum-new input[accept='image/*,video/*']").set_input_files("/tmp/lake.png")
    pg.wait_for_timeout(300)
    assert pg.locator(".fc-pick img").count() == 1, "picked picture previews"
    pg.locator(".forum-new button:has-text('Post')").click(); pg.wait_for_timeout(1500)
    pg.locator(".forum button[title='All posts']").click(); pg.wait_for_timeout(1000)
    assert pg.locator(".post-card").count() == 3
    assert pg.locator(".post-card.has-media .fc-media img").count() == 1, "picture post shows its picture"
    pg.screenshot(path=f"{OUT}/forum-list.png")

    # whoever has the forum open shows under it in the list ("who's here"), like chat
    pg.wait_for_timeout(500)
    here = pg.locator(".channel:has-text('Help and questions') + .voice-users .voice-user").all_inner_texts()
    assert any("Maya" in h for h in here), "Maya should show under the forum she's reading: " + str(here)

    # a phone
    ph = page(p, users["lena"], 412, 900, True)
    if ph.locator(".m-menu").count() and ph.locator(".m-menu").is_visible():
        ph.click(".m-menu"); ph.wait_for_timeout(300)
    ph.click(f".guild-btn[data-gid='{gid}']"); ph.wait_for_timeout(500)
    ph.click(".channel:has-text('Help and questions')"); ph.wait_for_timeout(1000)
    ph.screenshot(path=f"{OUT}/forum-phone-list.png")
    ph.locator(".post-card:has-text('Best settings')").click(); ph.wait_for_timeout(1000)
    ph.screenshot(path=f"{OUT}/forum-phone-thread.png")
print("forum ui ok: post, replies, branches, quote, best answer, inline reply; PC and phone")

# Voice space chat and the new marks, in browsers (needs the real voice server):
#  - a voice space's chat is closed until you tap Chat; the Chat button shows a dot for new chat
#  - server icons: a short green line where others are in voice, white where they're only
#    chatting, a long line where you are; a dot for unread, a red number for mentions
#  - Watch on a phone: the video and its controls stay put, Chat/Queue fill the rest
import sys, os, json, time, requests
from playwright.sync_api import sync_playwright
from websocket import create_connection
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
g2 = ok(requests.post(B + "/api/guilds", headers=H(M), json={"name": "Gaming"}))
g2id = g2.get("id") or g2["guild"]["id"]
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + M)
rd = json.loads(ws.recv())["d"]; ws.close()
chans = {c["kind"]: c["id"] for g in rd["guilds"] if g["guild"]["id"] == gid for c in g["channels"] if c["kind"] in ("text", "voice")}
voice, general = chans["voice"], chans["text"]
# the voice server (on this machine's address) starts in the background: wait until it's up
ok(requests.put(B + "/api/admin/settings", headers=H(M), json={"lan_ip": "127.0.0.1"}))
for _ in range(120):
    if ok(requests.get(B + "/api/admin/settings", headers=H(M)))["voice"]["state"] == "running": break
    time.sleep(0.5)
watch = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "Movie night", "kind": "watch"}))["id"]

def line(pg, gid_):
    return pg.evaluate("(g) => { const p = document.querySelector(`.guild-btn[data-gid='${g}']`)?.parentElement?.querySelector('.guild-pill'); return p ? p.className : null }", gid_)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    def page(tok, w=1280, h=800, phone=False):
        ctx = b.new_context(viewport={"width": w, "height": h}, has_touch=phone, is_mobile=phone, permissions=["microphone", "camera"])
        pg = ctx.new_page(); pg.goto(B + "/")
        pg.evaluate("t=>{localStorage.setItem('llamble.token',t);localStorage.setItem('llamble.server',location.origin)}", tok)
        pg.goto(B + "/"); pg.wait_for_timeout(2500)
        return pg
    m = page(M)
    k = page(K)
    # kai looks at another server; maya joins voice in Family
    m.click(f".guild-btn[data-gid='{gid}']"); m.wait_for_timeout(300)
    m.click(f".channel[data-cid='{voice}']")
    for i in range(40):  # the voice server can take a moment to start
        m.wait_for_timeout(500)
        if m.locator(".voice-label.connected").count(): break
        if m.locator(".voice-view.idle button.btn.green").count() and i % 8 == 7: m.click(".voice-view.idle button.btn.green")
    assert m.locator(".voice-label.connected").count(), "maya never connected to voice: " + str(m.evaluate("() => { const v = window.llambleDebug.voice(); return [v.status, v.error, v.channelId, v.step] }"))
    k.click(f".guild-btn[data-gid='{g2id}']") if k.locator(f".guild-btn[data-gid='{g2id}']").count() else None
    k.wait_for_timeout(800)
    c = line(k, gid)
    assert c and "live" in c and "voice" in c, f"kai should see a short green line on Family: {c}"
    c = line(m, gid)
    assert c and "active" in c and "voice" in c, f"maya should have a long green line on Family: {c}"
    print("lines: short green where others are in voice, long green where you're on a call")

    # the room's chat is closed; maya opens it and writes
    assert m.locator(".room-chat").count() == 0, "chat should start closed"
    m.click(".room-chat-btn"); m.wait_for_timeout(1200)
    assert m.locator(".room-chat .composer textarea, .room-chat textarea").count(), "no chat box in the room"
    m.locator(".room-chat textarea").first.fill(f"<@{k_id}> want to play?"); m.keyboard.press("Enter"); m.wait_for_timeout(1000)
    m.screenshot(path=f"{OUT}/voice-room-chat.png")
    # kai: a red number on Family (a mention), and on the voice space
    k.wait_for_timeout(800)
    assert k.locator(f".guild-btn[data-gid='{gid}'] .badge").count() == 1, "no red number on Family for kai"
    assert k.locator(f".guild-btn[data-gid='{gid}'] .badge").inner_text() == "1", "one mention should count once"
    k.click(f".guild-btn[data-gid='{gid}']"); k.wait_for_timeout(600)
    assert k.locator(f".channel[data-cid='{voice}'] .badge").count() == 1, "no red number on the voice space"
    k.screenshot(path=f"{OUT}/marks-kai.png")
    print("a mention in a voice chat: red number on the server and the space")

    # maya writes without a mention: kai's dot (after he's read the mention elsewhere, the red goes)
    requests.post(f"{B}/api/channels/{general}/messages", headers=H(M), json={"content": "dinner at 6"})
    k.wait_for_timeout(800)
    assert k.locator(f".channel[data-cid='{general}'] .new-dot").count() == 1, "no dot on general"
    print("plain new chat: a dot on the space")
    # kai opens a chat in Family: maya (there on a call) sees her long green line AND a short
    # white one beside it (someone else is here, chatting)
    k.click(f".channel[data-cid='{general}']"); k.wait_for_timeout(1200)
    both = m.evaluate("(g) => [...document.querySelector(`.guild-btn[data-gid='${g}']`).parentElement.querySelectorAll('.guild-pill')].map(p => p.className)", gid)
    assert any("active" in c and "voice" in c for c in both) and any("others" in c and "voice" not in c for c in both), both
    m.locator(".guildbar").screenshot(path=f"{OUT}/lines-both.png")
    print("you and others both there: your long line plus a short one beside it")
    k.close(); m.close()

    # Watch on a phone: video and controls stay at the top without scrolling; Chat/Queue below
    ok(requests.post(f"{B}/api/channels/{watch}/watch/queue", headers=H(M), json={"kind": "url", "src": "https://example.com/films/big-movie.mp4", "title": "Big Movie"}))
    ph = page(M, 412, 860, phone=True)
    if "m-nav" not in (ph.locator(".shell").get_attribute("class") or ""):
        ph.click(".m-menu"); ph.wait_for_timeout(300)
    ph.click(f".guild-btn[data-gid='{gid}']"); ph.wait_for_timeout(300)
    ph.click(f".channel[data-cid='{watch}']"); ph.wait_for_timeout(4000)
    ph.screenshot(path=f"{OUT}/watch-phone.png")
    if ph.locator("button[title='More: volume and mute']").count():
        ph.click("button[title='More: volume and mute']"); ph.wait_for_timeout(300)
        ph.screenshot(path=f"{OUT}/watch-phone-more.png")
    tops = ph.evaluate("""() => {
      const m = document.querySelector('.watch-main'), c = document.querySelector('.watch-chat');
      const hang = document.querySelector('.watch-call .call-btn.hang'), next = [...document.querySelectorAll('.watch-controls .btn')].pop();
      return [getComputedStyle(m).overflowY, hang.getBoundingClientRect().bottom, next.getBoundingClientRect().bottom, c.getBoundingClientRect().top, c.getBoundingClientRect().bottom, innerHeight];
    }""")
    # the top doesn't scroll, every control is above the chat, and the chat fits on screen
    assert tops[0] not in ("auto", "scroll") and tops[1] <= tops[3] + 1 and tops[2] <= tops[3] + 1 and tops[4] <= tops[5] + 1, f"Watch layout on a phone: {tops}"
    print("Watch on a phone: nothing to scroll up top; chat and queue fill the rest")
    b.close()
print("rooms ui ok")

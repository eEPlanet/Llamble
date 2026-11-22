# The Voicemail tab in a browser (Llamble serving client/dist): rows open in place, Save MP3 downloads.
import sys, requests, io, wave
from playwright.sync_api import sync_playwright
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r):
    assert r.status_code < 300, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, gid = s["token"], s["guild_id"]; mid = ok(requests.get(B+"/api/users/@me", headers=H(M)))["id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 9}))["code"]
for u in ("papa", "sam"):
    r = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": u, "password": "demo-pass-123"}))
    dm = ok(requests.post(B + "/api/users/@me/channels", headers=H(r["token"]), json={"recipient_id": mid}))["id"]
    buf = io.BytesIO(); w = wave.open(buf, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000 * 13); w.close()
    f = ok(requests.post(B + "/api/files", headers=H(r["token"]), files={"file": ("vm.wav", buf.getvalue(), "audio/wav")}))
    ok(requests.post(f"{B}/api/channels/{dm}/messages", headers=H(r["token"]), json={"content": "", "attachments": [{"id": f["id"]}], "voice": {"duration_ms": 13000, "voicemail": True}}))
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, vp, mobile in [("desk", {"width": 1280, "height": 760}, False), ("phone", {"width": 390, "height": 844}, True)]:
        ctx = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, accept_downloads=True)
        pg = ctx.new_page(); pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
        if mobile: pg.click(".m-menu"); pg.wait_for_timeout(300)
        pg.click("button[title^='Talk']"); pg.click(".msg-tab:has-text('Voicemail')"); pg.wait_for_timeout(800)
        pg.screenshot(path=f"/tmp/shots/vm-{name}-list.png")
        pg.click(".vm-head:has-text('papa')"); pg.wait_for_timeout(600)
        pg.screenshot(path=f"/tmp/shots/vm-{name}-open.png")
        with pg.expect_download(timeout=15000) as d:
            pg.click(".vm-row.open .vnote-save")
        print(name, "saved:", d.value.suggested_filename)
        ctx.close()
    b.close()

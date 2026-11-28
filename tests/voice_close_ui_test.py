# Closing a browser tab in a call hangs up right away (needs a real LiveKit: LLAMBLE_LIVEKIT_BIN).
# Hiding the tab (switching away) keeps the call.
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
        time.sleep(0.3)
    raise SystemExit("timed out: " + what)
s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "hunter2hunter2", "server_name": "Family"}))
H = {"Authorization": "Bearer " + s["token"]}
ok(requests.put(B + "/api/admin/settings", headers=H, json={"lan_ip": "127.0.0.1"}))
wait(lambda: ok(requests.get(B + "/api/admin/settings", headers=H))["voice"]["state"] == "running", 60, "voice server")
def in_call():
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + s["token"])
    d = json.loads(ws.recv())["d"]; ws.close()
    return [v["user_id"] for v in d.get("voice_states", [])]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    ctx = b.new_context(permissions=["microphone"])
    pg = ctx.new_page()
    pg.goto(B); pg.evaluate("t=>{localStorage.setItem('llamble.token',t)}", s["token"]); pg.reload()
    pg.wait_for_function("() => window.llambleDebug", timeout=30000); pg.wait_for_timeout(1000)
    pg.click("button[title='Family']"); pg.wait_for_timeout(400)
    pg.click(".channel:has-text('General') >> nth=-1"); pg.wait_for_timeout(500)
    btn = pg.locator("button:has-text('Join Voice'), button:has-text('Join')").first
    if btn.count(): btn.click()
    wait(lambda: in_call(), 30, "in the call")
    # switching to another tab: still in the call
    other = ctx.new_page(); other.goto("about:blank"); other.bring_to_front(); time.sleep(3)
    assert in_call(), "hiding the tab keeps the call"
    other.close()
    t0 = time.time()
    pg.close()
    wait(lambda: not in_call(), 10, "hung up after closing the tab")
    print(f"closed the tab: out of the call after {time.time() - t0:.1f}s")
    b.close()
print("VOICE CLOSE OK")

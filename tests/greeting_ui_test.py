# Settings → Voicemail in a browser: standard greeting, your words in a server voice (hear it,
# save), and recording your own (fake microphone).
import sys, os, io, tarfile, threading, functools, time, requests
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
B = sys.argv[1]
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)
root = "/tmp/voice-models-greet"
for sub, name, files in [("asr-models", "sherpa-onnx-whisper-tiny.en", ["tiny.en-encoder.int8.onnx", "tiny.en-decoder.int8.onnx", "tiny.en-tokens.txt", "tiny.en-encoder.onnx"]),
                         ("tts-models", "kokoro-int8-en-v0_19", ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/x"])]:
    os.makedirs(f"{root}/{sub}", exist_ok=True)
    with tarfile.open(f"{root}/{sub}/{name}.tar.bz2", "w:bz2") as t:
        for f in files:
            data = b"x" * 1000
            ti = tarfile.TarInfo(f"{name}/{f}"); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
srv = ThreadingHTTPServer(("127.0.0.1", 8094), functools.partial(SimpleHTTPRequestHandler, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
H = lambda t: {"Authorization": "Bearer " + t}
s = requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}).json()
M = s["token"]
me = requests.get(B + "/api/users/@me", headers=H(M)).json()["id"]
requests.put(B + "/api/admin/voice-ai", headers=H(M), json={"enabled": True, "stt": "whisper-tiny.en"})
for _ in range(60):
    if requests.get(B + "/api/admin/voice-ai", headers=H(M)).json()["status"]["tts"] == "ready": break
    time.sleep(0.25)
def greeting():
    return requests.get(B + f"/api/users/{me}/greeting", headers=H(M)).json()

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1280, "height": 860}, permissions=["microphone"])
    pg = ctx.new_page()
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    pg.click("button[title='User Settings']"); pg.wait_for_timeout(600)
    pg.click(".settings-nav >> text=Voicemail") if pg.locator(".settings-nav").count() else pg.click("text=Voicemail")
    pg.wait_for_selector("text=Voicemail greeting")
    assert pg.locator(".join-mode.on:has-text('Standard')").count() == 1
    pg.screenshot(path=f"{OUT}/greeting-standard.png")
    # your words in a voice
    pg.click(".join-mode:has-text('Your words') input"); pg.wait_for_timeout(300)
    pg.fill(".greet-box textarea", "Hey, it's Maya. Leave me a message and I'll call you back.")
    pg.select_option(".greet-box select", "9")
    pg.click("button:has-text('Hear it')"); pg.wait_for_timeout(1500)
    pg.click(".greet-box button:has-text('Save')"); pg.wait_for_timeout(1500)
    g = greeting()
    assert g["kind"] == "voice" and g["text"].startswith("Hey, it's Maya") and g["file_id"], g
    pg.screenshot(path=f"{OUT}/greeting-voice.png")
    # record your own
    pg.click(".join-mode:has-text('Record your own') input"); pg.wait_for_timeout(300)
    pg.click(".greet-box button:has-text('Record')"); pg.wait_for_timeout(2200)
    pg.screenshot(path=f"{OUT}/greeting-recording.png")
    pg.click(".greet-box button:has-text('Stop')"); pg.wait_for_timeout(800)
    pg.click(".greet-box button:has-text('Save')"); pg.wait_for_timeout(1500)
    g = greeting()
    assert g["kind"] == "recorded" and g["file_id"], g
    pg.screenshot(path=f"{OUT}/greeting-recorded.png")
    # back to standard
    pg.click(".join-mode:has-text('Standard') input"); pg.wait_for_timeout(1000)
    assert greeting()["kind"] == "default"
    b.close()
print("greeting ui ok")

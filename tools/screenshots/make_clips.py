#!/usr/bin/env python3
"""Short looping clips of Llamble in use, for llamble.com: typing, clicking, rooms.

Records the built-in tutorial's practice world on a fresh server (everything in it is pretend),
with a drawn pointer so clicks show. The guide card shows in the tutorial clips and is hidden in
the others. Then cuts the recording into clips (MP4, no sound) with a poster frame each.

Usage: make_clips.py http://127.0.0.1:8199 OUT_DIR
(a fresh server: no accounts yet, LLAMBLE_SKIP_TUTORIAL unset)
"""
import os, subprocess, sys, time, struct, zlib, shutil, tempfile, requests
from playwright.sync_api import sync_playwright

B, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp()
s = requests.post(B + "/api/setup", json={"username": "sam", "password": "demo-pass-123", "display_name": "Sam", "server_name": "The Lake House"}).json()
T = s["token"]

# a picture to share: a little lake at sunset
def picture(path):
    w, h = 480, 320
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            if y < 190:
                t = y / 190
                r, g, b = int(247 - 20 * t), int(178 - 60 * t), int(103 - 10 * t)
                if (x - 330) ** 2 + (y - 150) ** 2 < 42 ** 2: r, g, b = 255, 232, 163
            else:
                t = (y - 190) / 130
                r, g, b = int(61 - 20 * t), int(90 - 40 * t), int(128 - 50 * t)
                if abs(y - 210 - (x % 7)) < 2 and 260 < x < 400: r, g, b = 255, 220, 150
            row += bytes([r, g, b])
        rows.append(bytes(row))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))
PIC = os.path.join(tmp, "lake-sunset.png")
picture(PIC)

# a voice-like test sound for the mic: a few seconds of "talking" (syllables), then a pause
def talking(path, secs=24, rate=16000):
    import math, wave, random
    random.seed(4)
    frames = bytearray()
    for i in range(secs * rate):
        t = i / rate
        cycle = t % 5.0
        on = cycle < 3.2 and (math.sin(t * 2 * math.pi * 3.1) > -0.6)
        amp = 0.35 * (0.6 + 0.4 * math.sin(t * 2 * math.pi * 1.3)) if on else 0.0
        v = amp * (math.sin(2 * math.pi * 180 * t) + 0.5 * math.sin(2 * math.pi * 360 * t) + 0.2 * (random.random() - 0.5))
        frames += int(max(-1, min(1, v)) * 20000).to_bytes(2, "little", signed=True)
    w = wave.open(path, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(frames)); w.close()
VOICE = os.path.join(tmp, "talking.wav")
talking(VOICE)

POINTER = """
(() => {
  const d = document.createElement('div');
  d.id = 'rec-pointer';
  d.style.cssText = 'position:fixed;z-index:99999;left:0;top:0;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .12s';
  d.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.8L4 20z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const add = () => document.body && !document.getElementById('rec-pointer') && document.body.appendChild(d);
  add(); setInterval(add, 500);
  addEventListener('mousemove', e => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => d.style.transform = 'scale(.8)', true);
  addEventListener('mouseup', () => d.style.transform = '', true);
})();
"""
HIDE = "document.documentElement.classList.toggle('rec-clean', %s)"
CSS = ".rec-clean .tut-card, .rec-clean .tut-spot, .rec-clean .tut-dim { display: none !important; }"

marks = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={VOICE}", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1280, "height": 760}, record_video_dir=tmp, record_video_size={"width": 1280, "height": 760}, permissions=["microphone"])
    ctx.add_init_script(POINTER)
    pg = ctx.new_page()
    t0 = time.monotonic()
    def mark(name, what):
        marks.append((name, what, time.monotonic() - t0))
    def glide(sel, click=True, button="left"):
        box = pg.locator(sel).first.bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        pg.mouse.move(x, y, steps=18)
        pg.wait_for_timeout(180)
        if click:
            pg.mouse.down(button=button); pg.wait_for_timeout(60); pg.mouse.up(button=button)
    def typing(text):
        glide(".composer textarea")
        pg.keyboard.type(text, delay=55)
        pg.wait_for_timeout(250)
        pg.keyboard.press("Enter")
    def step(title):
        pg.wait_for_selector(f'.tut-card h3:text-is("{title}")', timeout=15000, state="attached")
        pg.wait_for_timeout(300)
    def clean(on):
        pg.evaluate(HIDE % ("true" if on else "false"))

    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{T}')"); pg.goto(B + "/")
    pg.add_style_tag(content=CSS)
    pg.wait_for_selector("text=Welcome to Llamble", timeout=15000)
    pg.mouse.move(640, 600)
    pg.wait_for_timeout(600)

    # the tutorial: welcome, then the first steps with the guide showing
    mark("tutorial", "start")
    pg.wait_for_timeout(1800)
    glide(".tut-card button:has-text('Start')")
    step("Home"); pg.wait_for_timeout(1500); glide(".tut-card button:has-text('Next')")
    step("Servers"); pg.wait_for_timeout(1200); glide("button[title='Practice Server']")
    step("Spaces"); pg.wait_for_timeout(1200); glide(".channel:has-text('general')")
    step("Say hello"); pg.wait_for_timeout(1200)
    mark("tutorial", "end")

    # chat: type, an answer, a reaction (guide hidden)
    clean(True)
    pg.wait_for_timeout(300)
    mark("chat", "start")
    pg.wait_for_timeout(500)
    typing("Anyone up for Movie Night tonight? 🍿")
    pg.wait_for_selector(".msg:has-text('Welcome 😊')")
    pg.wait_for_timeout(900)
    glide(".msg:has-text('Welcome 😊')", click=False)
    pg.wait_for_timeout(400)
    glide(".msg:has-text('Welcome 😊') .msg-toolbar button >> nth=1")
    pg.wait_for_timeout(1400)
    mark("chat", "end")

    # a picture (the tour opens #pictures next)
    step("Share a picture")
    mark("picture", "start")
    pg.wait_for_timeout(700)
    with pg.expect_file_chooser() as fc:
        glide(".composer-plus")
    fc.value.set_files(PIC)
    pg.wait_for_timeout(700)
    typing("Lake looked amazing last night")
    pg.wait_for_selector(".msg:has-text('Ooh, nice one')")
    pg.wait_for_timeout(1500)
    mark("picture", "end")

    # the AI helper
    step("Ask Llamble")
    mark("bot", "start")
    pg.wait_for_timeout(500)
    typing("@Llamble what can you do?")
    pg.wait_for_selector(".msg:has-text('In practice I can only')")
    pg.wait_for_timeout(2200)
    mark("bot", "end")

    # a practice voice room, with the guide showing
    step("Voice & Video")
    clean(False)
    mark("voice", "start")
    pg.wait_for_timeout(1400)
    glide(".channel:has-text('Hangout')")
    step("You're in"); pg.wait_for_timeout(3500)
    glide(".tut-card button:has-text('Next')")
    step("Leave"); pg.wait_for_timeout(900)
    glide(".practice-leave")
    pg.wait_for_timeout(900)
    mark("voice", "end")

    # past Watch (not recorded: the tutorial's Watch room is a simplified one)
    clean(True)
    if pg.locator('.tut-card h3:text-is("Watch together")').count() or pg.locator(".channel:has-text('Movie Night')").count():
        step("Watch together"); glide(".channel:has-text('Movie Night')")
        step("Movie Night"); glide(".practice-leave")

    # direct messages
    step("Talk")
    mark("dm", "start")
    pg.wait_for_timeout(500)
    glide("[data-tut=talk]")
    step("Direct messages"); pg.wait_for_timeout(600)
    glide(".dm-row:has-text('Maya')")
    pg.wait_for_timeout(700)
    typing("Saving you a seat for the movie!")
    pg.wait_for_selector(".msg:has-text('Got it!')")
    pg.wait_for_timeout(1500)
    mark("dm", "end")

    # friends: accept a request
    step("Friends")
    mark("friends", "start")
    pg.wait_for_timeout(500)
    glide("[data-tut=friends]")
    pg.wait_for_timeout(900)
    glide("[data-uid] button[title='Accept']")
    pg.wait_for_timeout(1000)
    pg.wait_for_timeout(500)
    glide(".dm-row:not(.fav-row):has-text('Jordan')")
    pg.wait_for_selector(".friend-card", timeout=5000)
    pg.wait_for_timeout(1800)
    mark("friends", "end")

    # finding servers
    step("Find servers")
    mark("servers", "start")
    pg.wait_for_timeout(500)
    glide(".discover-btn")
    pg.wait_for_timeout(2600)
    mark("servers", "end")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(500)

    video = pg.video.path()
    ctx.close()
    b.close()

# cut the clips
spans = {}
for name, what, t in marks:
    spans.setdefault(name, {})[what] = t
for name, sp in spans.items():
    a, z = sp["start"], sp["end"]
    mp4 = os.path.join(OUT, f"{name}.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{a:.2f}", "-to", f"{z:.2f}", "-i", video,
                    "-vf", "fps=30,scale=1280:-2", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-sseof", "-0.3", "-i", mp4, "-frames:v", "1", "-c:v", "libwebp", "-quality", "82", os.path.join(OUT, f"{name}.webp")], check=True)
    print(name, f"{z - a:.1f}s", os.path.getsize(mp4) // 1024, "KB")
shutil.rmtree(tmp, ignore_errors=True)

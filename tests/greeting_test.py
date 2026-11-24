# Voicemail greetings: the default (device voice until the server's voices are downloaded),
# your own words in a server voice, and one you recorded; callers can play it.
import requests, sys, io, os, tarfile, threading, functools, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
B = sys.argv[1]

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
def call(method, path, tok, expect=200, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code == expect, (method, path, r.status_code, r.text[:300])
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r
s = requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Fam"}).json()
A = s["token"]
a_id = call("GET", "/api/users/@me", A)["id"]
J = requests.post(B + "/api/auth/register", json={"invite": call("POST", "/api/invites/llamble", A, json={})["code"], "username": "jake", "password": "pass-word-123", "display_name": "Jake"}).json()["token"]
j_id = call("GET", "/api/users/@me", J)["id"]

# ---- no voices yet: the default greeting is said by the caller's device
g = call("GET", f"/api/users/{j_id}/greeting", A)
assert g == {"kind": "default", "text": "Jake can't answer right now. Leave a message after the tone.", "file_id": None}, g
me = call("GET", "/api/users/@me/greeting", J)
assert me["kind"] == "default" and me["voices_ready"] is False and len(me["voices"]) == 11
call("PUT", "/api/users/@me/greeting", J, expect=400, json={"kind": "voice", "text": "Hi, it's Jake"})

# ---- recorded greeting (works without the voices)
f = requests.post(B + "/api/files", headers=H(J), files={"file": ("greeting.webm", b"\x1aE\xdf\xa3" + b"0" * 4000, "audio/webm")}).json()
f = f[0] if isinstance(f, list) else f
other = requests.post(B + "/api/files", headers=H(A), files={"file": ("x.webm", b"\x1aE\xdf\xa3" + b"0" * 100, "audio/webm")}).json()
other = other[0] if isinstance(other, list) else other
call("PUT", "/api/users/@me/greeting", J, expect=400, json={"kind": "recorded", "file_id": other["id"]})  # not yours
r = call("PUT", "/api/users/@me/greeting", J, json={"kind": "recorded", "file_id": f["id"]})
assert r["kind"] == "recorded" and r["file_id"] == f["id"]
g = call("GET", f"/api/users/{j_id}/greeting", A)
assert g["kind"] == "recorded" and g["file_id"] == f["id"]
assert call("GET", f"/api/files/{f['id']}", A).status_code == 200  # a caller can play it

# ---- the server's voices get downloaded
call("PUT", "/api/admin/voice-ai", A, json={"enabled": True, "stt": "whisper-tiny.en"})
for _ in range(60):
    st = call("GET", "/api/admin/voice-ai", A)["status"]
    if st["tts"] == "ready": break
    time.sleep(0.25)
assert st["tts"] == "ready", st
assert call("GET", "/api/users/@me/greeting", J)["voices_ready"] is True

# your words, a voice you pick; hear it first
wav = call("POST", "/api/users/@me/greeting/preview", J, json={"text": "Hey, it's Jake. Leave one after the beep.", "voice": 9})
assert wav.content[:4] == b"RIFF"
r = call("PUT", "/api/users/@me/greeting", J, json={"kind": "voice", "text": "Hey, it's Jake. Leave one after the beep.", "voice": 9})
assert r["kind"] == "voice" and r["voice"] == 9
g = call("GET", f"/api/users/{j_id}/greeting", A)
assert g["kind"] == "voice" and g["text"].startswith("Hey, it's Jake") and g["file_id"]
assert call("GET", f"/api/files/{g['file_id']}", A).content[:4] == b"RIFF"
# made once, then reused
assert call("GET", f"/api/users/{j_id}/greeting", A)["file_id"] == g["file_id"]
call("PUT", "/api/users/@me/greeting", J, expect=400, json={"kind": "voice", "text": "   "})

# ---- the default now uses the server's voice too
g = call("GET", f"/api/users/{a_id}/greeting", J)
assert g["kind"] == "default" and g["file_id"] and g["text"].startswith("alex can't answer")
call("PUT", "/api/users/@me/greeting", J, json={"kind": "default"})
assert call("GET", f"/api/users/{j_id}/greeting", A)["kind"] == "default"
call("PUT", "/api/users/@me/greeting", J, expect=400, json={"kind": "song"})
print("greeting ok")

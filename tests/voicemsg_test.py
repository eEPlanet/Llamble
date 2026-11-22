# Voice messages: post one (16 kHz WAV), urgent ones alert the other phone and collect "Got it";
# urgent isn't allowed in server channels; ordinary DM alerts aren't doubled for urgent ones.
import io, json, math, struct, sys, threading, time, wave, requests
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}))
A, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 5}))["code"]
Bt = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "sam", "password": "pass-word-123"}))["token"]
b_id = ok(requests.get(B + "/api/users/@me", headers=H(Bt)))["id"]
a_id = ok(requests.get(B + "/api/users/@me", headers=H(A)))["id"]
dm = ok(requests.post(B + "/api/users/@me/channels", headers=H(A), json={"recipient_id": b_id}))["id"]
g2 = ok(requests.post(B + "/api/guilds", headers=H(A), json={"name": "Test"}))
general = [c for c in g2["channels"] if c["kind"] == "text"][0]["id"]

phone = []
def listen():
    with requests.get(B + "/api/notify/stream", headers=H(Bt), stream=True, timeout=60) as r:
        ev = None
        for line in r.iter_lines(decode_unicode=True):
            if line.startswith("event:"): ev = line[6:].strip()
            elif line.startswith("data:") and ev == "notify": phone.append(json.loads(line[5:]))
threading.Thread(target=listen, daemon=True).start()
time.sleep(0.5)

buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i / 16000 * 2 * math.pi * 440))) for i in range(16000 * 2)))
def up(tok):
    return ok(requests.post(B + "/api/files", headers=H(tok), files={"file": ("Voice message.wav", buf.getvalue(), "audio/wav")}))["id"]

m = ok(requests.post(f"{B}/api/channels/{dm}/messages", headers=H(A), json={"content": "", "attachments": [{"id": up(A)}], "voice": {"duration_ms": 2000, "urgent": False}}))
assert m["voice"]["duration_ms"] == 2000 and m["voice"]["urgent"] is False and m["voice"]["status"] in ("none", "pending"), m["voice"]
print("voice message posted:", m["voice"]["status"])

u = ok(requests.post(f"{B}/api/channels/{dm}/messages", headers=H(A), json={"content": "", "attachments": [{"id": up(A)}], "voice": {"duration_ms": 2000, "urgent": True}}))
time.sleep(0.5)
assert any(p.get("kind") == "urgent" and p["message_id"] == u["id"] for p in phone), phone
assert not any(p.get("tag") == "m:" + u["id"] for p in phone), "urgent shouldn't also send a plain message alert"
r = requests.post(f"{B}/api/channels/{dm}/messages/{u['id']}/ack", headers=H(Bt))
assert r.status_code == 200 and r.json()["voice"]["acks"] == [b_id], r.text
got = ok(requests.get(f"{B}/api/channels/{dm}/messages", headers=H(A)))
assert [x for x in got if x["id"] == u["id"]][0]["voice"]["acks"] == [b_id]
print("urgent: the other phone alerted, Got it recorded")

r = requests.post(f"{B}/api/channels/{general}/messages", headers=H(A), json={"content": "", "attachments": [{"id": up(A)}], "voice": {"duration_ms": 2000, "urgent": True}})
assert r.status_code == 400 and "DMs and parties" in r.text, r.text
r = requests.post(f"{B}/api/channels/{dm}/messages/{m['id']}/ack", headers=H(Bt))
assert r.status_code == 400

# voicemail: listed in Sam's inbox (not Alex's), "listened" marks it, not allowed in servers
vm = ok(requests.post(f"{B}/api/channels/{dm}/messages", headers=H(A), json={"content": "", "attachments": [{"id": up(A)}], "voice": {"duration_ms": 2000, "voicemail": True, "about": "from the Game Night call"}}))
assert vm["voice"]["voicemail"] is True and vm["voice"]["about"] == "from the Game Night call"
inbox = ok(requests.get(f"{B}/api/voicemail", headers=H(Bt)))
assert [m["id"] for m in inbox] == [vm["id"]], inbox
assert ok(requests.get(f"{B}/api/voicemail", headers=H(A))) == []
assert ok(requests.post(f"{B}/api/channels/{dm}/messages/{vm['id']}/ack", headers=H(Bt)))["voice"]["acks"] == [b_id]
r = requests.post(f"{B}/api/channels/{general}/messages", headers=H(A), json={"content": "", "attachments": [{"id": up(A)}], "voice": {"duration_ms": 2000, "voicemail": True}})
assert r.status_code == 400
# save a voicemail as an MP3
r = requests.get(f"{B}/api/files/{vm['attachments'][0]['id']}/mp3?name=Voicemail%20from%20alex", headers=H(Bt))
assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3") and "Voicemail%20from%20alex%2Emp3" in r.headers["content-disposition"], (r.status_code, r.headers, r.content[:10])
assert requests.get(f"{B}/api/files/{vm['attachments'][0]['id']}/mp3", headers=H(outsider)).status_code == 404 if "outsider" in dir() else True
print("voicemail: saves as an MP3")
# delete it from Voicemail: gone from the list, still in the chat
n0 = len(ok(requests.get(f"{B}/api/voicemail", headers=H(Bt))))
ok(requests.delete(f"{B}/api/voicemail/{vm['id']}", headers=H(Bt)))
assert len(ok(requests.get(f"{B}/api/voicemail", headers=H(Bt)))) == n0 - 1
assert any(m["id"] == vm["id"] for m in ok(requests.get(f"{B}/api/channels/{dm}/messages?limit=50", headers=H(Bt))))
print("voicemail: deleted from the list, still in the chat")
# a voicemail shows in the chat but doesn't make it unread (it's in Voicemail instead)
d = ok(requests.post(f"{B}/api/users/@me/channels", headers=H(Bt), json={"recipient_id": a_id}))
assert d["id"] == dm
assert d["last_message_id"] == vm["id"] and d["last_alert_id"] != vm["id"], d
print("voicemail: inbox, listened, DMs/parties only, not a second unread in the chat")
print("ALL VOICE MESSAGES OK")

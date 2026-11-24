# Status follows the account (not the device), invisible stays offline when a device
# reconnects, and "Hide what I'm doing" keeps you online but drops your game.
# Also: an Opus voice recording uploads as audio and can be sent as a voice message.
import requests, sys, json, time
from websocket import create_connection
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
s = requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}).json()
A, gid = s["token"], s["guild_id"]
inv = requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 5}).json()["code"]
J = requests.post(B + "/api/auth/register", json={"invite": inv, "username": "jake", "password": "pass-word-123"}).json()["token"]
def connect(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    return ws, json.loads(ws.recv())["d"]
def events(ws, secs=1.0):
    out, end = [], time.time() + secs
    ws.settimeout(0.2)
    while time.time() < end:
        try:
            out.append(json.loads(ws.recv()))
        except Exception:
            pass
    return out
jws, jd = connect(J)
a_id = requests.get(B + "/api/users/@me", headers=H(A)).json()["id"]
pc, d = connect(A)
assert d["my_status"] == {"status": "online", "hide_activity": False}, d["my_status"]
pc.send(json.dumps({"op": "presence", "status": "invisible"}))
ev = [e for e in events(jws) if e["t"] == "PRESENCE_UPDATE" and e["d"]["user_id"] == a_id]
assert ev and ev[-1]["d"]["status"] == "offline", ev
# a second device (the phone) gets the account's status, and its arrival doesn't reveal alex
phone, d2 = connect(A)
assert d2["my_status"]["status"] == "invisible", d2["my_status"]
assert not [e for e in events(jws) if e["t"] == "PRESENCE_UPDATE" and e["d"]["user_id"] == a_id and e["d"]["status"] != "offline"]
# all devices disconnect and come back: still invisible (it's saved)
pc.close(); phone.close(); time.sleep(1.5)
pc, d = connect(A)
assert d["my_status"]["status"] == "invisible"
assert not [e for e in events(jws) if e["t"] == "PRESENCE_UPDATE" and e["d"]["user_id"] == a_id and e["d"]["status"] != "offline"]
# back online, then hide what I'm doing: online, no game, marked hidden; other devices hear about it
phone, _ = connect(A)
pc.send(json.dumps({"op": "presence", "status": "online"}))
pc.send(json.dumps({"op": "activity", "game": "Arc Raiders"}))
evj = events(jws)
assert any(e["t"] == "ACTIVITY_UPDATE" and e["d"]["game"] == "Arc Raiders" for e in evj), evj
pc.send(json.dumps({"op": "presence", "hide_activity": True}))
evj = events(jws)
assert any(e["t"] == "ACTIVITY_UPDATE" and e["d"]["game"] is None for e in evj), evj
up = [e for e in evj if e["t"] == "PRESENCE_UPDATE" and e["d"]["user_id"] == a_id][-1]["d"]
assert up["status"] == "online" and up["hidden"] is True, up
assert any(e["t"] == "MY_STATUS" and e["d"] == {"status": "online", "hide_activity": True} for e in events(phone, 0.5)), "other devices hear about it"
pc.send(json.dumps({"op": "activity", "game": "Arc Raiders"}))  # ignored while hidden
assert not [e for e in events(jws) if e["t"] == "ACTIVITY_UPDATE" and e["d"]["game"]]
_, jd = connect(J)
p = [x for x in jd["presences"] if x["user_id"] == a_id][0]
assert p["hidden"] is True and p["game"] is None, p

# ---- who's reading a chat: shown to people who can see it; hidden people aren't
pc.send(json.dumps({"op": "presence", "hide_activity": False}))
events(jws)
general = [c for g in jd["guilds"] for c in g["channels"] if c["kind"] == "text"][0]["id"]
pc.send(json.dumps({"op": "viewing", "channel_id": general}))
up = [e["d"] for e in events(jws) if e["t"] == "VIEWERS_UPDATE"]
assert up and up[-1] == {"channel_id": general, "user_ids": [a_id]}, up
_, jd2 = connect(J)
assert {"user_id": a_id, "channel_id": general} in jd2["viewers"], jd2["viewers"]
# chat is live: hiding what you do doesn't take you off it (invisible does)
pc.send(json.dumps({"op": "presence", "hide_activity": True}))
up = [e["d"] for e in events(jws) if e["t"] == "VIEWERS_UPDATE"]
assert up and up[-1]["user_ids"] == [a_id], up
pc.send(json.dumps({"op": "presence", "hide_activity": False, "status": "invisible"}))
up = [e["d"] for e in events(jws) if e["t"] == "VIEWERS_UPDATE"]
assert up and up[-1]["user_ids"] == [], up
pc.send(json.dumps({"op": "presence", "status": "online"}))
up = [e["d"] for e in events(jws) if e["t"] == "VIEWERS_UPDATE"]
assert up and up[-1]["user_ids"] == [a_id], up
# a chat jake can't see: he hears nothing about it
g2 = requests.post(f"{B}/api/guilds", headers=H(A), json={"name": "Staff Only"}).json()
g2 = g2.get("guild") or g2
secret = requests.post(f"{B}/api/guilds/{g2['id']}/channels", headers=H(A), json={"name": "staff", "kind": "text"}).json()
pc.send(json.dumps({"op": "viewing", "channel_id": secret["id"]}))
evj = events(jws)
assert not [e for e in evj if e["t"] == "VIEWERS_UPDATE" and e["d"]["channel_id"] == secret["id"]], evj
_, jd3 = connect(J)
assert all(v["channel_id"] != secret["id"] for v in jd3["viewers"]), jd3["viewers"]
# closing the chat (or disconnecting) clears it
pc.send(json.dumps({"op": "viewing", "channel_id": None}))
time.sleep(0.5)
_, jd4 = connect(J)
assert jd4["viewers"] == [], jd4["viewers"]

# an Opus/WebM voice recording stays audio and can be a voice message
webm = bytes([0x1A, 0x45, 0xDF, 0xA3]) + b"\x00" * 200
f = requests.post(B + "/api/files", headers=H(A), files={"file": ("Voice message.webm", webm, "audio/webm")}).json()
f = f[0] if isinstance(f, list) else f
assert f["mime"] == "audio/webm", f
dm = requests.post(B + "/api/users/@me/channels", headers=H(A), json={"recipient_id": jd["user"]["id"]}).json()
r = requests.post(f"{B}/api/channels/{dm['id']}/messages", headers=H(A), json={"content": "", "attachments": [{"id": f["id"]}], "voice": {"duration_ms": 1200, "urgent": False}})
assert r.status_code == 200, r.text
# the same bytes without saying audio are still a video
g = requests.post(B + "/api/files", headers=H(A), files={"file": ("clip.webm", webm, "video/webm")}).json()
g = g[0] if isinstance(g, list) else g
assert g["mime"] == "video/webm", g
print("status ok")

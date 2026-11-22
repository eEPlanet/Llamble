# A call ends only when someone hangs up or really leaves the voice server. Losing the chat
# connection (opening a link, switching apps) never takes you out; a voice server that can't
# be asked never takes anyone out; being gone from the voice room for 30 s does.
import json, sys, threading, time, requests
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from websocket import create_connection
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None

# stand-in for the voice server's "who's in this room" API
MODE = {"m": "present", "ids": set(), "asked": 0}
class LK(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert self.path == "/twirp/livekit.RoomService/ListParticipants" and self.headers["Authorization"].startswith("Bearer ")
        MODE["asked"] += 1
        if MODE["m"] == "error":
            self.send_response(500); self.end_headers(); return
        ps = [{"identity": i} for i in MODE["ids"]] if MODE["m"] == "present" else []
        out = json.dumps({"participants": ps}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)
threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", 8093), LK).serve_forever, daemon=True).start()

s = ok(requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}))
A, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 5}))["code"]
Bt = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "sam", "password": "pass-word-123"}))["token"]
a_id = ok(requests.get(B + "/api/users/@me", headers=H(A)))["id"]
b_id = ok(requests.get(B + "/api/users/@me", headers=H(Bt)))["id"]
dm = ok(requests.post(B + "/api/users/@me/channels", headers=H(A), json={"recipient_id": b_id}))["id"]

def in_call():
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + A)
    while True:
        m = json.loads(ws.recv())
        if m.get("t") == "READY":
            ws.close(); return {v["user_id"] for v in m["d"]["voice_states"] if v["channel_id"] == dm}

# sam's chat connection is open, then sam joins the call
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + Bt); ws.recv()
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(A)))
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(Bt)))
MODE["ids"] = {a_id, b_id}
assert in_call() == {a_id, b_id}

# sam taps a link: the chat connection drops, the call carries on
ws.close()
time.sleep(50)
assert in_call() == {a_id, b_id}, in_call()
assert MODE["asked"] >= 2
print("chat connection gone for 50 s: still in the call")

# voice server can't be asked: nobody is taken out
MODE["m"] = "error"; time.sleep(50)
assert in_call() == {a_id, b_id}
print("voice server unreachable: nobody taken out")

# sam's app really leaves the voice room: taken out after ~30 s, alex stays
MODE["m"] = "present"; MODE["ids"] = {a_id}; time.sleep(20)
assert b_id in in_call(), "taken out too soon"
time.sleep(40)
assert in_call() == {a_id}, in_call()
print("really gone from the voice room: taken out; the other person stays")

# hanging up still ends it at once
ok(requests.post(f"{B}/api/voice/leave", headers=H(A)))
assert in_call() == set()
print("PASS stay in call")

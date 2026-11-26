# Blocking and reporting. Block: the blocked person can't DM, ring or friend you, any
# friendship ends, and it's undone from your list. Report: a message or a person goes to this
# Llamble's admins (and the server's owner) with a copy of the message; they can delete the
# message, ban the person from the server, or dismiss it. Nobody else sees reports.
import json, sys, requests
from websocket import create_connection
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None
def ready(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    d = json.loads(ws.recv())["d"]; ws.close(); return d

s = ok(requests.post(B + "/api/setup", json={"username": "boss", "password": "master-pass1", "server_name": "Town"}))
A, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 5}))["code"]
W = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "wren", "password": "pass-word-123"}))["token"]
X = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "xena", "password": "pass-word-123"}))["token"]
me = lambda t: ok(requests.get(B + "/api/users/@me", headers=H(t)))["id"]
a_id, w_id, x_id = me(A), me(W), me(X)
general = next(c["id"] for c in ready(A)["guilds"][0]["channels"] if c["kind"] == "text")

# ---- block
ok(requests.post(f"{B}/api/friends", headers=H(W), json={"user_id": x_id})); ok(requests.put(f"{B}/api/friends/{w_id}", headers=H(X)))
dm = ok(requests.post(f"{B}/api/users/@me/channels", headers=H(X), json={"recipient_id": w_id}))["id"]
ok(requests.post(f"{B}/api/channels/{dm}/messages", headers=H(X), json={"content": "hi"}))
ok(requests.put(f"{B}/api/blocks/{w_id}", headers=H(W)), 400)  # not yourself
ok(requests.put(f"{B}/api/blocks/{x_id}", headers=H(W)))
assert ready(W)["blocked"] == [x_id] and ready(X)["blocked"] == []
assert [b["user"]["id"] for b in ok(requests.get(f"{B}/api/blocks", headers=H(W)))] == [x_id]
assert not any(f.get("user", f).get("id") == x_id for f in ok(requests.get(f"{B}/api/friends", headers=H(W)))), "friendship ended"
r = requests.post(f"{B}/api/channels/{dm}/messages", headers=H(X), json={"content": "hello?"}); assert r.status_code == 403, r.text
r = requests.post(f"{B}/api/channels/{dm}/messages", headers=H(W), json={"content": "x"}); assert r.status_code == 403, r.text
assert requests.post(f"{B}/api/users/@me/channels", headers=H(X), json={"recipient_id": w_id}).status_code == 403
assert requests.post(f"{B}/api/friends", headers=H(X), json={"user_id": w_id}).status_code == 403
r = requests.post(f"{B}/api/channels/{dm}/ring", headers=H(X), json={})
assert r.status_code in (200, 400, 403) and (r.status_code != 200 or r.json().get("ringing", 0) == 0), r.text
# they still share the server: their messages arrive (the app folds them away for W)
ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(X), json={"content": "in the server"}))
ok(requests.delete(f"{B}/api/blocks/{x_id}", headers=H(W)))
assert ready(W)["blocked"] == []
ok(requests.post(f"{B}/api/channels/{dm}/messages", headers=H(X), json={"content": "back"}))
print("block: no DMs, rings or friend requests either way; friendship ends; unblock undoes it")

# ---- report a message
bad = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(X), json={"content": "something nasty"}))["id"]
ok(requests.post(f"{B}/api/reports", headers=H(W), json={"message_id": bad, "reason": "nope"}), 400)
mine = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(W), json={"content": "mine"}))["id"]
ok(requests.post(f"{B}/api/reports", headers=H(W), json={"message_id": mine, "reason": "spam"}), 400)
rid = ok(requests.post(f"{B}/api/reports", headers=H(W), json={"message_id": bad, "reason": "harassment", "note": "again"}))["id"]
n = [x for x in ok(requests.get(f"{B}/api/notifications", headers=H(A))) if x["kind"] == "report"]
assert len(n) == 1 and n[0]["ref_id"] == rid and n[0]["data"]["about"]["id"] == x_id, n
assert not [x for x in ok(requests.get(f"{B}/api/notifications", headers=H(X))) if x["kind"] == "report"]
reps = ok(requests.get(f"{B}/api/reports", headers=H(A)))
assert len(reps) == 1 and reps[0]["snapshot"]["content"] == "something nasty" and reps[0]["note"] == "again" and reps[0]["status"] == "open", reps
assert ok(requests.get(f"{B}/api/reports", headers=H(W))) == [] and ok(requests.get(f"{B}/api/reports", headers=H(X))) == []
ok(requests.post(f"{B}/api/reports/{rid}/resolve", headers=H(W), json={"action": "dismiss"}), 403)
r = ok(requests.post(f"{B}/api/reports/{rid}/resolve", headers=H(A), json={"action": "delete"}))
assert r["status"] == "deleted" and not r["report"]["message_there"] and r["report"]["snapshot"]["content"] == "something nasty", r
assert bad not in [m["id"] for m in ok(requests.get(f"{B}/api/channels/{general}/messages?limit=20", headers=H(A)))]
print("report a message: admins get it with a copy; they can delete it; nobody else sees reports")

# ---- report a person; ban from the server
pid = ok(requests.post(f"{B}/api/reports", headers=H(W), json={"user_id": x_id, "reason": "spam"}))["id"]
ok(requests.post(f"{B}/api/reports/{pid}/resolve", headers=H(A), json={"action": "ban"}), 400)  # not about a server message
ok(requests.post(f"{B}/api/reports/{pid}/resolve", headers=H(A), json={"action": "dismiss"}))
m2 = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(X), json={"content": "more"}))["id"]
r2 = ok(requests.post(f"{B}/api/reports", headers=H(W), json={"message_id": m2, "reason": "spam"}))["id"]
ok(requests.post(f"{B}/api/reports/{r2}/resolve", headers=H(A), json={"action": "ban"}))
assert gid not in [g["guild"]["id"] for g in ready(X)["guilds"]]
# a report about the server's owner can't be handled by... the owner
o = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(A), json={"content": "owner says"}))["id"]
ro = ok(requests.post(f"{B}/api/reports", headers=H(W), json={"message_id": o, "reason": "other"}))["id"]
assert ro not in [x["id"] for x in ok(requests.get(f"{B}/api/reports", headers=H(A)))]
print("report a person; ban from the server; nobody handles reports about themselves")
print("ALL SAFETY OK")

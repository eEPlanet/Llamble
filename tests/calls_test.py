# Calling someone rings them like a phone: answer, decline, the caller hanging up, and nobody
# answering (missed call). Their phone's listener gets the ring too, and is told when it stops.
import json, sys, threading, time, requests
from websocket import create_connection
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None
s = ok(requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}))
A, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 5}))["code"]
Bt = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "sam", "password": "pass-word-123"}))["token"]
a_id = ok(requests.get(B + "/api/users/@me", headers=H(A)))["id"]
b_id = ok(requests.get(B + "/api/users/@me", headers=H(Bt)))["id"]
dm = ok(requests.post(B + "/api/users/@me/channels", headers=H(A), json={"recipient_id": b_id}))["id"]

def gateway(tok):
    evs = []
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    ws.recv()
    def rd():
        while True:
            try: m = json.loads(ws.recv())
            except Exception: return
            if m.get("t", "").startswith(("CALL_", "CHANNEL_")): evs.append((m["t"], m["d"]))
    threading.Thread(target=rd, daemon=True).start()
    return evs
ea, eb = gateway(A), gateway(Bt)
phone = []
def listen():
    with requests.get(B + "/api/notify/stream", headers=H(Bt), stream=True, timeout=120) as r:
        ev = None
        for line in r.iter_lines(decode_unicode=True):
            if line.startswith("event:"): ev = line[6:].strip()
            elif line.startswith("data:") and ev == "notify": phone.append(json.loads(line[5:]))
threading.Thread(target=listen, daemon=True).start()
time.sleep(0.5)

def wait(evs, t, cond=lambda d: True, secs=5):
    end = time.time() + secs
    while time.time() < end:
        for e in evs:
            if e[0] == t and cond(e[1]): evs.remove(e); return e[1]
        time.sleep(0.05)
    raise AssertionError(f"no {t} in {evs}")
def msgs():
    return [m["content"] for m in ok(requests.get(f"{B}/api/channels/{dm}/messages", headers=H(A)))]

# 0. an urgent call: marked so on screen and on the phone (which rings through Do Not Disturb)
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(A)))
ok(requests.post(f"{B}/api/channels/{dm}/ring", headers=H(A), json={"urgent": True}))
assert wait(eb, "CALL_RING")["urgent"] is True
time.sleep(0.3)
assert any(p.get("kind") == "call" and p.get("urgent") and p["title"] == "URGENT: alex" for p in phone), phone
ok(requests.post(f"{B}/api/channels/{dm}/ring/end", headers=H(Bt), json={"reason": "declined"}))
wait(eb, "CALL_RING_END")
ok(requests.post(f"{B}/api/voice/leave", headers=H(A)))
time.sleep(0.3); ea.clear(); eb.clear(); phone.clear()
print("urgent call: marked on screen and on the phone")

# 1. ring, then decline
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(A)))
r = ok(requests.post(f"{B}/api/channels/{dm}/ring", headers=H(A)))
assert r["ringing"] == 1, r
d = wait(eb, "CALL_RING"); assert d["from"] == a_id and d["channel_id"] == dm and d["urgent"] is False, d
time.sleep(0.3)
assert any(p.get("kind") == "call" and p["channel_id"] == dm and p["title"] == "alex" and not p["urgent"] for p in phone), phone
ok(requests.post(f"{B}/api/channels/{dm}/ring/end", headers=H(Bt), json={"reason": "declined"}))
assert wait(ea, "CALL_DECLINED")["by"] == b_id
assert wait(ea, "CALL_RING_END")["reason"] == "declined"
wait(eb, "CALL_RING_END")
time.sleep(0.3)
assert any(p.get("kind") == "call_end" for p in phone), phone
assert "📞 Missed call" not in msgs()
print("declined: caller told, ringing stopped on the phone, no missed-call note")

# 2. ring, then answer by joining
ok(requests.post(f"{B}/api/channels/{dm}/ring", headers=H(A)))
wait(eb, "CALL_RING")
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(Bt)))
assert wait(eb, "CALL_RING_END")["reason"] == "answered"
assert wait(ea, "CALL_RING_END")["reason"] == "answered"
# ringing someone already in the call rings nobody
assert ok(requests.post(f"{B}/api/channels/{dm}/ring", headers=H(A)))["ringing"] == 0
ok(requests.post(f"{B}/api/voice/leave", headers=H(Bt)))
print("answered: everyone's ringing stopped")

# 3. the caller hangs up first: missed call
ok(requests.post(f"{B}/api/channels/{dm}/ring", headers=H(A)))
wait(eb, "CALL_RING")
ok(requests.post(f"{B}/api/voice/leave", headers=H(A)))
assert wait(eb, "CALL_RING_END")["reason"] == "cancelled"
assert wait(ea, "CALL_RING_END")["reason"] == "cancelled"
time.sleep(0.3)
assert msgs().count("📞 Missed call") == 1, msgs()
print("caller hung up: ringing stopped, missed-call note in the chat")

# 4. nobody answers
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(A)))
ok(requests.post(f"{B}/api/channels/{dm}/ring", headers=H(A)))
wait(eb, "CALL_RING")
assert wait(eb, "CALL_RING_END", secs=40)["reason"] == "missed"
assert wait(ea, "CALL_RING_END")["reason"] == "missed"
time.sleep(0.3)
assert msgs().count("📞 Missed call") == 2, msgs()
print("no answer in 30 s: missed call")

# 5. adding a friend to a call (3-way): rung as a guest, joins the call but not the chat
Ct = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "casey", "password": "pass-word-123"}))["token"]
c_id = ok(requests.get(B + "/api/users/@me", headers=H(Ct)))["id"]
ec = gateway(Ct)
time.sleep(0.3)
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(A)))
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(Bt)))
r = requests.post(f"{B}/api/channels/{dm}/call/add", headers=H(A), json={"user_ids": [c_id]})
assert r.status_code == 400 and "friends" in r.text, r.text  # not friends yet
r = requests.post(f"{B}/api/channels/{dm}/voice", headers=H(Ct))
assert r.status_code >= 400, r.text  # can't just walk in
ok(requests.post(f"{B}/api/friends", headers=H(A), json={"user_id": c_id}))
ok(requests.put(f"{B}/api/friends/{a_id}", headers=H(Ct)))
# adding a friend makes a new party: everyone on the call + them, named after them, not kept yet
r = ok(requests.post(f"{B}/api/channels/{dm}/call/add", headers=H(A), json={"user_ids": [c_id]}))
pid = r["party_id"]
assert r["ringing"] == 1 and pid != dm, r
mv = wait(ea, "CALL_MOVED"); assert mv == {"from": dm, "to": pid}, mv
assert wait(eb, "CALL_MOVED")["to"] == pid
cc = wait(ec, "CHANNEL_CREATE"); assert cc["id"] == pid and cc["unsaved"] is True and {u["id"] for u in cc["recipients"]} == {a_id, b_id, c_id}, cc
assert "&" in cc["name"], cc["name"]  # e.g. "bo & cy"
d = wait(ec, "CALL_RING"); assert d["channel_id"] == pid and set(d["with"]) == {a_id, b_id}, d
for t in (A, Bt, Ct):
    ok(requests.post(f"{B}/api/channels/{pid}/voice", headers=H(t)))
assert wait(ec, "CALL_RING_END")["reason"] == "answered"
# writing in its chat keeps it
ok(requests.post(f"{B}/api/channels/{pid}/messages", headers=H(Ct), json={"content": "here's the link"}))
up = wait(ea, "CHANNEL_UPDATE", lambda d: d["id"] == pid and d["unsaved"] is False); assert up["id"] == pid and up["unsaved"] is False, up
# the DM itself never changed
assert {u["id"] for u in ok(requests.post(f"{B}/api/users/@me/channels", headers=H(A), json={"recipient_id": b_id}))["recipients"]} == {a_id, b_id}
for t in (A, Bt, Ct):
    ok(requests.post(f"{B}/api/voice/leave", headers=H(t)))
print("added a friend: a new party with everyone, the call moved there, writing in it keeps it")

# a call's party can be kept with a name, or left (deleted for you)
ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(A))); ok(requests.post(f"{B}/api/channels/{dm}/voice", headers=H(Bt)))
p2 = ok(requests.post(f"{B}/api/channels/{dm}/call/add", headers=H(A), json={"user_ids": [c_id]}))["party_id"]
k = ok(requests.post(f"{B}/api/parties/{p2}/keep", headers=H(Bt), json={"name": "Saturday crew"}))
assert k["name"] == "Saturday crew" and k["unsaved"] is False, k
for t in (A, Bt):
    ok(requests.post(f"{B}/api/voice/leave", headers=H(t)))
ok(requests.post(f"{B}/api/channels/{p2}/ring/end", headers=H(A), json={"reason": "cancelled"}))
print("a call's party kept with its own name")
print("ALL CALLS OK")

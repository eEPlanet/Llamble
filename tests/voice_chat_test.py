# A voice & video space's chat is only for people in the space: in its call, or still there
# with it open after hanging up. Everyone else only hears that something's new (and whether
# it mentions them), for the unread dot and the red number.
import json, sys, threading, time, requests
from websocket import create_connection
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None

s = ok(requests.post(B + "/api/setup", json={"username": "maya", "password": "demo-pass-123", "server_name": "Family"}))
M, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
K = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "kai", "password": "pass-word-123"}))["token"]
k_id = ok(requests.get(B + "/api/users/@me", headers=H(K)))["id"]

def gateway(tok):
    evs = []
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    rd = json.loads(ws.recv())["d"]
    def rd_loop():
        while True:
            try: m = json.loads(ws.recv())
            except Exception: return
            evs.append((m.get("t"), m.get("d")))
    threading.Thread(target=rd_loop, daemon=True).start()
    return ws, rd, evs
wm, rd, em = gateway(M)
wk, _, ek = gateway(K)
voice = next(c for g in rd["guilds"] if g["guild"]["id"] == gid for c in g["channels"] if c["kind"] == "voice")["id"]

def wait(evs, t, cond=lambda d: True, secs=4):
    end = time.time() + secs
    while time.time() < end:
        for e in list(evs):
            if e[0] == t and cond(e[1]): return e[1]
        time.sleep(0.05)
    return None

# not in the space: can't read or post its chat
ok(requests.get(f"{B}/api/channels/{voice}/messages", headers=H(K)), 403)
ok(requests.post(f"{B}/api/channels/{voice}/messages", headers=H(K), json={"content": "hi"}), 403)
# maya joins the call: she can chat there
ok(requests.post(f"{B}/api/channels/{voice}/voice", headers=H(M)))
m1 = ok(requests.post(f"{B}/api/channels/{voice}/messages", headers=H(M), json={"content": "anyone up for a game?"}))
assert wait(em, "MESSAGE_CREATE", lambda d: d["id"] == m1["id"]), "maya didn't get her own message"
# kai, outside: no message, just "something new" (no mention)
a = wait(ek, "SPACE_ACTIVITY", lambda d: d["message_id"] == m1["id"])
assert a and a["channel_id"] == voice and a["mentions_me"] is False, a
assert not any(t == "MESSAGE_CREATE" and d.get("channel_id") == voice for t, d in ek), "kai got the message itself"
# a mention of kai: he's told it mentions him (and it's in his Notifications)
m2 = ok(requests.post(f"{B}/api/channels/{voice}/messages", headers=H(M), json={"content": f"<@{k_id}> come join"}))
a = wait(ek, "SPACE_ACTIVITY", lambda d: d["message_id"] == m2["id"])
assert a and a["mentions_me"] is True, a
assert any(n["ref_id"] == m2["id"] for n in ok(requests.get(B + "/api/notifications", headers=H(K)))), "mention not in Notifications"
print("outside the space: no chat, just that something's new (and mentions)")

# kai opens the space (comes in): he can read and write
wk.send(json.dumps({"op": "viewing", "channel_id": voice})); time.sleep(0.4)
got = ok(requests.get(f"{B}/api/channels/{voice}/messages", headers=H(K)))
assert [m["id"] for m in got][-2:] == [m1["id"], m2["id"]] or m2["id"] in [m["id"] for m in got], got
k1 = ok(requests.post(f"{B}/api/channels/{voice}/messages", headers=H(K), json={"content": "on my way"}))
assert wait(ek, "MESSAGE_CREATE", lambda d: d["id"] == k1["id"]), "kai in the space didn't get the message"
# and he shows in the space's who's here
v = wait(em, "VIEWERS_UPDATE", lambda d: d["channel_id"] == voice and k_id in d["user_ids"])
assert v, "kai isn't listed in the space"
print("in the space (open, not on the call): reads and writes its chat, listed as here")

# maya hangs up but keeps the space open: she can still chat
wm.send(json.dumps({"op": "viewing", "channel_id": voice})); time.sleep(0.3)
ok(requests.post(f"{B}/api/voice/leave", headers=H(M))); time.sleep(0.3)
ok(requests.post(f"{B}/api/channels/{voice}/messages", headers=H(M), json={"content": "brb, still here in chat"}))
# she leaves the space altogether: the chat closes to her
wm.send(json.dumps({"op": "viewing", "channel_id": None})); time.sleep(0.3)
ok(requests.get(f"{B}/api/channels/{voice}/messages", headers=H(M)), 403)
print("hung up but still there: chat works; left the space: closed")
print("ALL VOICE CHAT OK")

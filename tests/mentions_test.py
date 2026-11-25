# @mentions and replies land in Notifications (servers and parties, not DMs), go away once the
# person has read that chat past them, and go away if the message is deleted.
import sys, requests
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None

s = ok(requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}))
A, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 5}))["code"]
S = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "sam", "password": "pass-word-123"}))["token"]
a_id = ok(requests.get(B + "/api/users/@me", headers=H(A)))["id"]
s_id = ok(requests.get(B + "/api/users/@me", headers=H(S)))["id"]
from websocket import create_connection
import json
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + A)
rd = json.loads(ws.recv())["d"]; ws.close()
general = next(c for g in rd["guilds"] if g["guild"]["id"] == gid for c in g["channels"] if c["kind"] == "text")["id"]

def mentions(t):
    return [n for n in ok(requests.get(B + "/api/notifications", headers=H(t))) if n["kind"] == "mention"]
def post(t, cid, content, reply=None):
    return ok(requests.post(f"{B}/api/channels/{cid}/messages", headers=H(t), json={"content": content, "reply_to": reply}))

# a plain message: nothing
post(A, general, "hello everyone")
assert mentions(S) == []
# an @mention: one notification, saying who, where, and what
m1 = post(A, general, f"<@{s_id}> pizza tonight?")
n = mentions(S)
assert len(n) == 1 and n[0]["ref_id"] == m1["id"] and n[0]["read_at"] is None, n
d = n[0]["data"]
assert d["channel_id"] == general and d["from"]["id"] == a_id and d["reply"] is False and "pizza" in d["preview"] and d["guild"]["id"] == gid, d
# the author never gets their own
assert mentions(A) == []
# a reply to sam's message notifies sam (once, even if it also @mentions him)
mine = post(S, general, "who's in?")
r = post(A, general, f"me! <@{s_id}>", reply=mine["id"])
n = [x for x in mentions(S) if x["ref_id"] == r["id"]]
assert len(n) == 1 and n[0]["data"]["reply"] is True, n
# reading the chat past them marks them read
ok(requests.post(f"{B}/api/channels/{general}/ack", headers=H(S), json={"message_id": r["id"]}))
assert all(x["read_at"] for x in mentions(S)), mentions(S)
# a deleted message takes its notification with it
m3 = post(A, general, f"<@{s_id}> oops wrong person")
assert any(x["ref_id"] == m3["id"] for x in mentions(S))
ok(requests.delete(f"{B}/api/messages/{m3['id']}", headers=H(A)))
assert not any(x["ref_id"] == m3["id"] for x in mentions(S))
print("server mentions and replies: in Notifications, read with the chat, gone when deleted")

# parties count, DMs don't (a DM is all for you anyway)
ok(requests.post(f"{B}/api/friends", headers=H(A), json={"user_id": s_id}))
ok(requests.put(f"{B}/api/friends/{a_id}", headers=H(S)))
party = ok(requests.post(B + "/api/parties", headers=H(A), json={"name": "Saturday", "user_ids": [s_id]}))["id"]
before = len(mentions(S))
pm = post(A, party, f"<@{s_id}> bring chips")
pn = [x for x in mentions(S) if x["ref_id"] == pm["id"]]
assert len(pn) == 1 and pn[0]["data"]["kind"] == "party", pn
dmc = ok(requests.post(B + "/api/users/@me/channels", headers=H(A), json={"recipient_id": s_id}))
# a two-person party is never mistaken for the DM between those two
assert dmc["id"] != party and dmc["kind"] == "dm", dmc
dm = dmc["id"]
post(A, dm, f"<@{s_id}> hey")
got = mentions(S); assert len(got) == before + 1, [(x["data"]["kind"], x["data"]["preview"]) for x in got]
print("party mentions notify; DM mentions don't")
print("ALL MENTIONS OK")

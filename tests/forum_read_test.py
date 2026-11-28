# Forum read tracking: new posts and replies are unread until opened (Unread filter, "New" on
# cards); your own writing is read; opening the last unread post clears the space's dot (its
# read state) and the reply notifications; "Mark all read" clears everything. Editing a post's
# text, title and tags; only its writer (text) or staff (title and tags).
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
fid = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(A), json={"name": "Help", "kind": "forum"}))["id"]
send = lambda t, body: ok(requests.post(f"{B}/api/channels/{fid}/messages", headers=H(t), json=body))
lst = lambda t, f="all": ok(requests.get(f"{B}/api/channels/{fid}/forum?filter={f}", headers=H(t)))["posts"]
def space_read(t):
    d = ready(t); rs = {r["channel_id"]: r["last_read_id"] for r in d.get("read_states", [])}
    last = next(c for g in d["guilds"] for c in g["channels"] if c["id"] == fid).get("last_message_id")
    return rs.get(fid) is not None and rs[fid] >= last

p1 = send(W, {"title": "Shield stutters", "content": "every few minutes"})["id"]
p2 = send(W, {"title": "Movie night", "content": "Friday?"})["id"]
# the writer has read their own posts; others haven't
assert not any(p["unread"] for p in lst(W)) and lst(W, "unread") == []
assert all(p["unread"] for p in lst(X)) and {p["id"] for p in lst(X, "unread")} == {p1, p2}
# writing your own post doesn't mark everyone else's read (but your own is read)
p3 = send(X, {"title": "Xena's question", "content": "?"})["id"]
assert {p["id"] for p in lst(X, "unread")} == {p1, p2}, [p["forum"]["title"] for p in lst(X, "unread")]
assert [p["id"] for p in lst(W, "unread")] == [p3]
ok(requests.get(f"{B}/api/channels/{fid}/forum/{p3}", headers=H(W)))
# with nothing else unread, writing a post leaves the space read (no dot from your own post)
assert space_read(W)
p4 = send(W, {"title": "Another one", "content": "!"})["id"]
assert space_read(W) and lst(W, "unread") == []
# xena follows p1 and wren replies: a notification, p1 unread again for xena
ok(requests.put(f"{B}/api/forum/{p1}/follow", headers=H(X)))
r1 = send(W, {"thread_id": p1, "content": "try wired"})["id"]
nots = lambda t: [n for n in ok(requests.get(B + "/api/notifications", headers=H(t))) if n["kind"] == "forum_reply"]
assert len(nots(X)) == 1 and not nots(X)[0]["read_at"]
# opening p1: read, its notification read; p2 still unread, so the space isn't read yet
ok(requests.get(f"{B}/api/channels/{fid}/forum/{p1}", headers=H(X)))
assert {p["id"] for p in lst(X, "unread")} == {p2, p4}
assert nots(X)[0]["read_at"]
assert not space_read(X)
# opening the last unread post: the space is read (the white dot goes)
ok(requests.get(f"{B}/api/channels/{fid}/forum/{p2}", headers=H(X)))
assert [p["id"] for p in lst(X, "unread")] == [p4]
ok(requests.get(f"{B}/api/channels/{fid}/forum/{p4}", headers=H(X)))
assert lst(X, "unread") == [] and space_read(X), "space should be read"
# a new reply makes p1 unread again; replying yourself keeps it read
send(W, {"thread_id": p1, "content": "or powerline"})
assert [p["id"] for p in lst(X, "unread")] == [p1]
send(X, {"thread_id": p1, "content": "powerline worked"})
assert lst(X, "unread") == []
# Mark all read (the boss has never looked)
assert len(lst(A, "unread")) == 4 and not space_read(A)
ok(requests.post(f"{B}/api/channels/{fid}/forum/read", headers=H(A)))
assert lst(A, "unread") == [] and space_read(A)
print("read tracking ok")

# ---- editing
e = ok(requests.patch(f"{B}/api/messages/{p1}", headers=H(W), json={"content": "every few minutes, on Wi-Fi"}))
assert e["content"] == "every few minutes, on Wi-Fi" and e["edited_at"]
ok(requests.patch(f"{B}/api/messages/{p1}", headers=H(X), json={"content": "hijack"}), 403)
f = ok(requests.patch(f"{B}/api/forum/{p1}", headers=H(W), json={"title": "  Shield stutters on Wi-Fi ", "tags": ["#wifi", "Shield"]}))["forum"]
assert f["title"] == "Shield stutters on Wi-Fi" and f["tags"] == ["wifi", "Shield"], f
ok(requests.patch(f"{B}/api/forum/{p1}", headers=H(X), json={"title": "mine now"}), 403)
ok(requests.patch(f"{B}/api/forum/{p1}", headers=H(W), json={"title": "   "}), 400)
ok(requests.patch(f"{B}/api/forum/{r1}", headers=H(W), json={"title": "a reply"}), 404)
f = ok(requests.patch(f"{B}/api/forum/{p1}", headers=H(A), json={"tags": ["solved-ish"]}))["forum"]  # staff
assert f["tags"] == ["solved-ish"] and f["title"] == "Shield stutters on Wi-Fi"
t = ok(requests.get(f"{B}/api/channels/{fid}/forum/{p1}", headers=H(X)))["post"]
assert t["forum"]["title"] == "Shield stutters on Wi-Fi" and t["content"] == "every few minutes, on Wi-Fi"
print("editing ok")
print("FORUM READ OK")

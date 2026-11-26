# Forum spaces: posts (title, tags) and replies are messages. A reply to the post goes in time
# order; a reply to a reply branches under it; quotes link back without branching. Likes are
# ❤️ reactions. Following a post notifies you of replies. The asker or staff pick a best answer.
import json, sys, requests
from urllib.parse import quote as q
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

f = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(A), json={"name": "Help", "kind": "forum"}))
fid = f["id"]
assert f["kind"] == "forum"
send = lambda t, body: requests.post(f"{B}/api/channels/{fid}/messages", headers=H(t), json=body)

# ---- posts
ok(send(W, {"content": "no title"}), 400)
post = ok(send(W, {"title": "  Shield stutters  ", "content": "Picture stutters every few minutes", "tags": ["#Streaming", "streaming", "wifi", "", "a", "b", "c", "d"]}))
pid = post["id"]
assert post["forum"]["title"] == "Shield stutters" and post["forum"]["tags"] == ["Streaming", "wifi", "a", "b", "c"], post["forum"]
p2 = ok(send(X, {"title": "Movie night?", "content": "Friday?", "tags": ["events"]}))["id"]

# ---- replies: time order, branches, quotes
r1 = ok(send(A, {"thread_id": pid, "content": "Try wired"}))["id"]
r2 = ok(send(X, {"thread_id": pid, "reply_to": r1, "content": "No cable out there"}))["id"]  # branch under r1
r3 = ok(send(A, {"thread_id": pid, "reply_to": r2, "content": "Powerline adapter"}))["id"]   # deeper
r4 = ok(send(X, {"thread_id": pid, "content": "That fixed ours", "quotes": [r3, p2, r3, "nope"]}))["id"]
ok(send(X, {"thread_id": pid, "reply_to": p2, "content": "wrong post"}), 400)
ok(send(X, {"thread_id": p2 + "x", "content": "no such post"}), 400)
ok(send(X, {"thread_id": r1, "content": "a reply isn't a post"}), 400)

t = ok(requests.get(f"{B}/api/channels/{fid}/forum/{pid}", headers=H(W)))
ids = [r["id"] for r in t["replies"]]
assert ids == [r1, r2, r3, r4], ids
by = {r["id"]: r for r in t["replies"]}
rt = lambda r: (by[r]["reply_to"] or {}).get("id")
assert rt(r2) == r1 and rt(r3) == r2 and rt(r1) is None, by[r2]["reply_to"]
assert by[r4]["forum"]["quotes"] == [r3], by[r4]["forum"]  # other posts' messages and junk dropped
assert t["post"]["reply_count"] == 4 and t["post"]["following"], t["post"]
print("posts and replies: titles, tags, branches and quotes")

# ---- likes are ❤️ reactions
ok(requests.put(f"{B}/api/messages/{pid}/reactions/{q('❤️')}", headers=H(A)))
ok(requests.put(f"{B}/api/messages/{r3}/reactions/{q('❤️')}", headers=H(W)))
t = ok(requests.get(f"{B}/api/channels/{fid}/forum/{pid}", headers=H(W)))
assert t["post"]["likes"] == 1 and not t["post"]["liked"]
assert next(r for r in t["replies"] if r["id"] == r3)["liked"]

# ---- list, tags, filters
L = ok(requests.get(f"{B}/api/channels/{fid}/forum", headers=H(A)))
assert [p["id"] for p in L["posts"]] == [p2, pid] and set(L["tags"]) >= {"Streaming", "events"}, L
assert [p["id"] for p in ok(requests.get(f"{B}/api/channels/{fid}/forum?filter=unanswered", headers=H(A)))["posts"]] == [p2]
assert [p["id"] for p in ok(requests.get(f"{B}/api/channels/{fid}/forum?tag=streaming", headers=H(A)))["posts"]] == [pid]
assert [p["id"] for p in ok(requests.get(f"{B}/api/channels/{fid}/forum?filter=following", headers=H(W)))["posts"]] == [pid]
assert ok(requests.get(f"{B}/api/channels/{fid}/forum?filter=solved", headers=H(A)))["posts"] == []
assert [p["id"] for p in ok(requests.get(f"{B}/api/channels/{fid}/forum?before={p2}", headers=H(A)))["posts"]] == [pid]
# a picture post (title + picture, no text) shows under "Pictures and videos"
import io
from PIL import Image
im = Image.new("RGB", (64, 48), (63, 132, 235)); bio = io.BytesIO(); im.save(bio, "PNG"); bio.seek(0)
fo = ok(requests.post(B + "/api/files", headers=H(W), files={"file": ("lake.png", bio, "image/png")}))
fo = fo[0] if isinstance(fo, list) else fo
pic = ok(send(W, {"title": "Sunset at the lake", "attachments": [{"id": fo["id"], "spoiler": False}]}))["id"]
assert [p["id"] for p in ok(requests.get(f"{B}/api/channels/{fid}/forum?filter=media", headers=H(A)))["posts"]] == [pic]
ok(requests.delete(f"{B}/api/messages/{pic}", headers=H(W)))
print("list: newest first; tags; unanswered, following, solved, pictures and videos; paging")

# ---- following tells you about replies
notes = lambda t: [n for n in ok(requests.get(f"{B}/api/notifications", headers=H(t))) if n["kind"] == "forum_reply"]
w_before = len(notes(W))
assert w_before >= 2, notes(W)  # r1 (to the post: W is its writer, it's a reply to... the post) and r4
ok(requests.put(f"{B}/api/forum/{p2}/follow", headers=H(A)))
ok(send(W, {"thread_id": p2, "content": "Friday works"}))
assert any(n["data"]["post_id"] == p2 for n in notes(A)), notes(A)
ok(requests.delete(f"{B}/api/forum/{p2}/follow", headers=H(A)))
n_a = len(notes(A))
ok(send(W, {"thread_id": p2, "content": "Bring snacks"}))
assert len(notes(A)) == n_a, "unfollowed: no more"
# opening the post reads its reply notifications
ok(requests.get(f"{B}/api/channels/{fid}/forum/{pid}", headers=H(W)))
assert all(n["read_at"] for n in notes(W) if n["data"]["post_id"] == pid), notes(W)
print("follow: replies notify followers; opening the post reads them; unfollow stops them")

# ---- best answer
ok(requests.put(f"{B}/api/forum/{pid}/best", headers=H(X), json={"reply_id": r3}), 403)
ok(requests.put(f"{B}/api/forum/{pid}/best", headers=H(W), json={"reply_id": r3}))
assert [p["id"] for p in ok(requests.get(f"{B}/api/channels/{fid}/forum?filter=solved", headers=H(A)))["posts"]] == [pid]
ok(requests.put(f"{B}/api/forum/{pid}/best", headers=H(A), json={"reply_id": p2}), 400)
ok(requests.put(f"{B}/api/forum/{pid}/best", headers=H(A), json={"reply_id": None}))  # staff can clear it
print("best answer: the asker or staff")

# ---- colors
ch = ok(requests.patch(f"{B}/api/channels/{fid}", headers=H(A), json={"style": {"base": "#1d9e75", "branch": "calm"}}))
assert json.loads(ch["style"]) == {"base": "#1d9e75", "branch": "calm"}, ch
ch = ok(requests.patch(f"{B}/api/channels/{fid}", headers=H(A), json={"style": {"base": "red; x", "branch": "weird"}}))
assert json.loads(ch["style"]) == {"base": "", "branch": "llamble"}, ch

# ---- deleting a post deletes its replies; deleting a reply keeps its branch
ok(requests.delete(f"{B}/api/messages/{r2}", headers=H(X)))
ids = [r["id"] for r in ok(requests.get(f"{B}/api/channels/{fid}/forum/{pid}", headers=H(W)))["replies"]]
assert ids == [r1, r3, r4], ids
ok(requests.delete(f"{B}/api/messages/{pid}", headers=H(W)))
ok(requests.get(f"{B}/api/channels/{fid}/forum/{pid}", headers=H(W)), 404)
for r in [r1, r3, r4]:
    assert requests.delete(f"{B}/api/messages/{r}", headers=H(A)).status_code == 404
# chat spaces ignore forum fields
general = next(c["id"] for c in ready(A)["guilds"][0]["channels"] if c["kind"] == "text")
m = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(A), json={"content": "hi", "title": "x", "thread_id": p2}))
assert "forum" not in m
print("ALL FORUM OK")

# The demo account (for app store reviewers) is a sandbox on the same instance, sealed off both
# ways: the demo can't see, find or reach anyone outside it, and nobody outside can see, find or
# reach the demo. It's rebuilt nightly (or on demand) with the same sign-in, survives a reviewer
# deleting the account, and turning it off locks it.
import json, sys, requests
from websocket import create_connection
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None
def ready(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    d = json.loads(ws.recv())["d"]; ws.close(); return d
def login(u, p):
    return requests.post(B + "/api/auth/login", json={"username": u, "password": p})

# the family: an admin, a member, a shared server that's even open in Discover, friends, news
s = ok(requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"}))
A, gid = s["token"], s["guild_id"]
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 5}))["code"]
W = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "wren", "password": "pass-word-123"}))["token"]
a_id = ok(requests.get(B + "/api/users/@me", headers=H(A)))["id"]
w_id = ok(requests.get(B + "/api/users/@me", headers=H(W)))["id"]
ok(requests.post(f"{B}/api/friends", headers=H(A), json={"user_id": w_id})); ok(requests.put(f"{B}/api/friends/{a_id}", headers=H(W)))
ok(requests.patch(f"{B}/api/guilds/{gid}", headers=H(A), json={"discoverable": True}))
ok(requests.post(f"{B}/api/news", headers=H(A), json={"title": "Family news", "body": "private to the family"}))
family_ids = {a_id, w_id, gid}

# turn the demo on
d = ok(requests.put(f"{B}/api/admin/demo", headers=H(A), json={"enabled": True}))
assert d["enabled"] and d["username"] == "llamble-demo" and d["password"], d
ok(requests.put(f"{B}/api/admin/demo", headers=H(W), json={"enabled": True}), 403)  # admins only
D = ok(login(d["username"], d["password"]))["token"]
rd = ready(D)
d_id = rd["user"]["id"]
assert [g["guild"]["name"] for g in rd["guilds"]] == ["The Lake House"], [g["guild"]["name"] for g in rd["guilds"]]
demo_gid = rd["guilds"][0]["guild"]["id"]
demo_people = {m["user"]["id"] for m in rd["guilds"][0]["members"]} - {d_id}
demo_ids = demo_people | {d_id, demo_gid}
blob = json.dumps(rd)
assert not any(i in blob for i in family_ids), "the demo's sign-in data mentions the family"
assert "Family" not in blob
print("demo sees its own world: The Lake House, its people, nothing of the family")

# the demo can't reach out
ok(requests.post(f"{B}/api/friends", headers=H(D), json={"username": "bran"}), 400)
ok(requests.post(f"{B}/api/friends", headers=H(D), json={"user_id": a_id}), 400)
ok(requests.post(f"{B}/api/users/@me/channels", headers=H(D), json={"recipient_id": a_id}), 403)
ok(requests.get(f"{B}/api/users/{a_id}/profile", headers=H(D)), 404)
ok(requests.get(f"{B}/api/users/{a_id}/greeting", headers=H(D)), 404)
ok(requests.post(f"{B}/api/parties", headers=H(D), json={"name": "x", "user_ids": [a_id]}), 403)
assert ok(requests.get(f"{B}/api/news", headers=H(D))) == []
home = json.dumps(ok(requests.get(f"{B}/api/home", headers=H(D))))
assert "Family news" not in home and not any(i in home for i in family_ids), "family shows on the demo's Home"
for path in ["/api/discover", f"/api/guilds/{demo_gid}/invite-search?q=b", "/api/admin/users", "/api/kids"]:
    r = requests.get(B + path, headers=H(D)); assert r.status_code == 403, (path, r.status_code)
ok(requests.post(f"{B}/api/invites/{inv}", headers=H(D)), 403)
ok(requests.post(f"{B}/api/discover/{gid}/join", headers=H(D)), 403)
ok(requests.patch(f"{B}/api/users/@me", headers=H(D), json={"current_password": d["password"], "new_password": "changed-it-123"}), 403)
print("the demo can't find, friend, message, party, invite, join, read news or change its password")

# inside, the real app works: chat, friends, calls (nobody answers: voicemail)
general = next(c["id"] for c in rd["guilds"][0]["channels"] if c["kind"] == "text")
ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(D), json={"content": "hi from the reviewer"}))
friends = ok(requests.get(f"{B}/api/friends", headers=H(D)))
assert {f["user"]["display_name"] for f in friends if f.get("state", "friend") == "friend"} >= {"Maya", "Sam"}, friends
print("inside the demo: chat and friends work")

# the family can't see or reach the demo (the admin included)
for tok, me in [(A, a_id), (W, w_id)]:
    blob = json.dumps(ready(tok))
    assert not any(i in blob for i in demo_ids), "the family's sign-in data mentions the demo"
    assert "Lake House" not in blob
    for name in ["llamble-demo", "demo-maya"]:
        ok(requests.post(f"{B}/api/friends", headers=H(tok), json={"username": name}), 400)
    ok(requests.post(f"{B}/api/users/@me/channels", headers=H(tok), json={"recipient_id": d_id}), 403)
    ok(requests.get(f"{B}/api/users/{d_id}/profile", headers=H(tok)), 404)
    ok(requests.post(f"{B}/api/parties", headers=H(tok), json={"name": "x", "user_ids": [d_id]}), 403)
    found = ok(requests.get(f"{B}/api/guilds/{gid}/invite-search?q=demo", headers=H(A)))
    assert not any(u["id"] in demo_ids for u in (found if isinstance(found, list) else found.get("users", []))), found
assert demo_gid not in json.dumps(ok(requests.get(f"{B}/api/discover", headers=H(W))))
r = ok(requests.post(f"{B}/api/guilds/{gid}/invite-people", headers=H(A), json={"user_ids": [d_id]}))
assert r["sent"] == [], r
ok(requests.post(f"{B}/api/kids", headers=H(A), json={"username": "kiddo", "display_name": "Kiddo", "password": "kid-pass-123"}))
kids = ok(requests.get(f"{B}/api/kids", headers=H(A))); kid = (kids[0].get("id") or kids[0]["user"]["id"])
r = requests.post(f"{B}/api/kids/{kid}/contacts", headers=H(A), json={"user": "llamble-demo"}); assert r.status_code == 400 and "no account named" in r.text, r.text
print("the family (admin included) can't find, friend, message, party, invite or see the demo")

# reset: the content comes back, the sign-in stays
ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(D), json={"content": "a reviewer's mess"}))
r = ok(requests.post(f"{B}/api/admin/demo/reset", headers=H(A)))
assert r["password"] == d["password"]
D2 = ok(login(d["username"], d["password"]))["token"]
rd2 = ready(D2)
assert [g["guild"]["name"] for g in rd2["guilds"]] == ["The Lake House"]
assert rd2["user"]["id"] == d_id
# a reviewer deletes the account (Google may test it): the next reset brings it back
ok(requests.delete(f"{B}/api/users/@me", headers=H(D2), json={"password": d["password"]}))
assert login(d["username"], d["password"]).status_code != 200
ok(requests.post(f"{B}/api/admin/demo/reset", headers=H(A)))
D3 = ok(login(d["username"], d["password"]))["token"]
assert ready(D3)["user"]["username"] == "llamble-demo"
print("reset puts the demo back with the same sign-in, even after the reviewer deleted it")

# off: nobody can sign in to it
ok(requests.put(f"{B}/api/admin/demo", headers=H(A), json={"enabled": False}))
assert login(d["username"], d["password"]).status_code != 200
assert requests.get(f"{B}/api/users/@me", headers=H(D3)).status_code == 401
print("off: the demo can't be signed in to")
print("ALL DEMO OK")

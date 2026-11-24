# Who can get into a server (open / preview / request / invite), Open servers, previews,
# requests to join, Invite to Llamble, and "Add as friends" on invites.
import sys, requests
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def call(method, path, tok, expect=200, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code == expect, (method, path, r.status_code, r.text[:300])
    return r.json() if r.text else None
s = requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}).json()
A, home = s["token"], s["guild_id"]
a_id = call("GET", "/api/users/@me", A)["id"]
call("PUT", "/api/admin/settings", A, json={"guild_create": "all"})
def signup(code, name):
    r = requests.post(B + "/api/auth/register", json={"invite": code, "username": name, "password": "pass-word-123"})
    assert r.status_code == 200, r.text
    t = r.json()["token"]
    return t, call("GET", "/api/users/@me", t)["id"]
def notes(tok, kind):
    return [n for n in call("GET", "/api/notifications", tok) if n["kind"] == kind]
def friends(tok):
    return {f["user"]["id"]: f["state"] for f in call("GET", "/api/friends", tok)}

# ---- servers start invite-only; only staff can invite there
J, j_id = signup(call("POST", f"/api/guilds/{home}/invites", A, json={"max_uses": 1})["code"], "jake")
assert friends(J) == {}  # no "add as friends" on that one
call("POST", f"/api/guilds/{home}/invites", J, expect=403, json={})
call("POST", f"/api/guilds/{home}/invite-people", J, expect=403, json={"user_ids": [a_id]})
assert call("GET", "/api/discover", J)["servers"] == []

# ---- Invite to Llamble: any member, one use, 7 days; add as friends
inv = call("POST", "/api/invites/llamble", J, json={"add_friend": True})
assert inv["max_uses"] == 1 and inv["expires_at"] > 0
pv = requests.get(B + f"/api/invites/{inv['code']}").json()
assert pv["guild"] is None, pv
S, s_id = signup(inv["code"], "sam")
assert friends(S) == {j_id: "friend"} and friends(J)[s_id] == "friend"
assert [n["data"]["by"]["id"] for n in notes(J, "invite_accepted")] == [s_id]
r = requests.post(B + "/api/auth/register", json={"invite": inv["code"], "username": "sam2", "password": "pass-word-123"})
assert r.status_code == 400  # used up
users = {u["username"]: u for u in call("GET", "/api/admin/users", A)}
assert users["sam"]["invited_by"] == "jake" and users["jake"]["invited_by"] == "alex", users["sam"]
# without the box: no friendship
inv2 = call("POST", "/api/invites/llamble", J, json={"add_friend": False})
T, t_id = signup(inv2["code"], "tess")
assert friends(T) == {}
# admins can turn it off (admins can still make them)
call("PUT", "/api/admin/settings", A, json={"member_invites": False})
call("POST", "/api/invites/llamble", J, expect=403, json={})
call("POST", "/api/invites/llamble", A, json={})
call("PUT", "/api/admin/settings", A, json={"member_invites": True})
# kids can't
kid = call("POST", "/api/kids", A, json={"username": "kiddo", "password": "kid-pass-123"})
k_id = kid["id"] if "id" in kid else kid["user"]["id"]
K = requests.post(B + "/api/auth/login", json={"username": "kiddo", "password": "kid-pass-123"}).json()["token"]
call("POST", "/api/invites/llamble", K, expect=403, json={})

# ---- server link invite with add as friends (staff)
code = call("POST", f"/api/guilds/{home}/invites", A, json={"max_uses": 5, "add_friend": True})["code"]
call("POST", f"/api/invites/{code}", S)
assert friends(S)[a_id] == "friend"

# ---- Open: listed, preview, join; any member can invite
games = call("POST", "/api/guilds", A, json={"name": "Game Night"})
games = (games.get("guild") or games)["id"]
call("PATCH", f"/api/guilds/{games}", J, expect=404, json={"join_mode": "open"})
call("PATCH", f"/api/guilds/{games}", A, expect=400, json={"join_mode": "public"})
g = call("PATCH", f"/api/guilds/{games}", A, json={"join_mode": "open", "description": "Friday games"})
assert g["join_mode"] == "open" and g["description"] == "Friday games"
lst = call("GET", "/api/discover", J)["servers"]
assert [(x["name"], x["join_mode"], x["member_count"], x["description"]) for x in lst] == [("Game Night", "open", 1, "Friday games")], lst
assert lst[0]["listed_at"]
assert call("GET", "/api/discover?q=friday", J)["servers"][0]["id"] == games
assert call("GET", "/api/discover?q=zzz", J)["servers"] == []
assert call("GET", "/api/discover", A)["servers"] == []  # already in it
pre = call("GET", f"/api/discover/{games}", J)
chat = [c for c in pre["channels"] if c["kind"] == "text"][0]
assert pre["guild"]["member"] is False and any(c["kind"] == "voice" for c in pre["channels"])
call("POST", f"/api/channels/{chat['id']}/messages", A, json={"content": "anyone up for cards?"})
msgs = call("GET", f"/api/discover/{games}/channels/{chat['id']}/messages", J)
assert [m["content"] for m in msgs] == ["anyone up for cards?"]
# preview is read-only: the normal routes stay closed
call("POST", f"/api/channels/{chat['id']}/messages", J, expect=404, json={"content": "hi"})
call("GET", f"/api/channels/{chat['id']}/messages", J, expect=404)
call("POST", f"/api/discover/{games}/request", J, expect=400, json={})
r = call("POST", f"/api/discover/{games}/join", J)
assert r["guild_id"] == games
assert call("GET", "/api/discover", J)["servers"] == []
call("POST", f"/api/guilds/{games}/invites", J, json={})  # members can invite to Open servers
# kids: joining an Open server still needs a parent (unless a parent owns it)
jg = call("POST", "/api/guilds", J, json={"name": "Jake's"})
jg = (jg.get("guild") or jg)["id"]
call("PATCH", f"/api/guilds/{jg}", J, json={"join_mode": "open"})
r = call("POST", f"/api/discover/{jg}/join", K)
assert r.get("pending") is True, r

# ---- Preview, then request
call("PATCH", f"/api/guilds/{games}", A, json={"join_mode": "preview"})
call("POST", f"/api/guilds/{games}/invites", J, expect=403, json={})  # back to staff only
call("POST", f"/api/discover/{games}/join", T, expect=403)
assert call("GET", f"/api/discover/{games}/channels/{chat['id']}/messages", T)
r = call("POST", f"/api/discover/{games}/request", T, json={"note": "I'm Jake's cousin"})
assert r["status"] == "pending"
assert call("GET", "/api/discover", T)["servers"][0]["request"] == {"status": "pending"}
n = notes(A, "join_request")
assert len(n) == 1 and n[0]["data"]["note"] == "I'm Jake's cousin" and n[0]["data"]["from"]["id"] == t_id
assert notes(J, "join_request") == []  # not staff
call("GET", f"/api/guilds/{games}/join-requests", J, expect=403)
assert [x["user"]["id"] for x in call("GET", f"/api/guilds/{games}/join-requests", A)] == [t_id]
call("POST", f"/api/guilds/{games}/join-requests/{t_id}/decline", J, expect=403)
call("POST", f"/api/guilds/{games}/join-requests/{t_id}/decline", A)
assert notes(A, "join_request") == []
assert notes(T, "join_declined")
r = call("POST", f"/api/discover/{games}/request", T, expect=403, json={})
assert call("GET", "/api/discover", T)["servers"][0]["request"]["status"] == "declined"
# someone else asks and is approved
r = call("POST", f"/api/discover/{games}/request", S, json={})
call("POST", f"/api/guilds/{games}/join-requests/{s_id}/approve", A)
assert call("GET", f"/api/discover/{games}", S)["guild"]["member"] is True
assert notes(S, "join_approved")
call("POST", f"/api/guilds/{games}/join-requests/{s_id}/approve", A, expect=400)  # already handled
# cancel your own request
U, u_id = signup(call("POST", "/api/invites/llamble", A, json={})["code"], "uma")
call("POST", f"/api/discover/{games}/request", U, json={})
call("DELETE", f"/api/discover/{games}/request", U)
assert notes(A, "join_request") == [] and call("GET", f"/api/guilds/{games}/join-requests", A) == []

# ---- Request only: listed, no preview
call("PATCH", f"/api/guilds/{games}", A, json={"join_mode": "request"})
pre = call("GET", f"/api/discover/{games}", U)
assert pre["channels"] == [] and pre["guild"]["name"] == "Game Night"
call("GET", f"/api/discover/{games}/channels/{chat['id']}/messages", U, expect=404)
call("POST", f"/api/discover/{games}/request", U, json={})

# ---- Invite only: gone from the list and the preview
call("PATCH", f"/api/guilds/{games}", A, json={"join_mode": "invite"})
assert games not in [x["id"] for x in call("GET", "/api/discover", U)["servers"]]
call("GET", f"/api/discover/{games}", U, expect=404)
# banned people never see it
call("PATCH", f"/api/guilds/{games}", A, json={"join_mode": "open"})
call("PUT", f"/api/guilds/{games}/bans/{u_id}", A, json={})
assert games not in [x["id"] for x in call("GET", "/api/discover", U)["servers"]]
call("GET", f"/api/discover/{games}", U, expect=404)
# a locked chat drops out of the preview
call("POST", f"/api/channels/{chat['id']}/lock", A, json={"locked": True})
assert chat["id"] not in [c["id"] for c in call("GET", f"/api/discover/{games}", T)["channels"]]
call("GET", f"/api/discover/{games}/channels/{chat['id']}/messages", T, expect=404)
# ---- spaces: a new category made with the space, and moving a space into a new one
w = call("POST", f"/api/guilds/{games}/channels", A, json={"name": "Movie Night", "kind": "watch", "new_category": "Watch"})
assert w["parent_id"]
v = call("POST", f"/api/guilds/{games}/channels", A, json={"name": "Lounge", "kind": "voice"})
assert v["parent_id"] is None
v2 = call("PATCH", f"/api/channels/{v['id']}", A, json={"new_category": "Hangout"})
assert v2["parent_id"] and v2["parent_id"] != w["parent_id"]
v3 = call("PATCH", f"/api/channels/{v['id']}", A, json={"parent_id": w["parent_id"]})
assert v3["parent_id"] == w["parent_id"]
v4 = call("PATCH", f"/api/channels/{v['id']}", A, json={"parent_id": None})
assert v4["parent_id"] is None
print("discover ok")

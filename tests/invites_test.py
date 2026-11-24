# In-app server invites (search, cards in DMs and parties, join, remind) and the
# Notifications desk.
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
def join(gid, name, display=None):
    inv = call("POST", f"/api/guilds/{gid}/invites", A, json={"max_uses": 5})["code"]
    r = requests.post(B + "/api/auth/register", json={"invite": inv, "username": name, "password": "pass-word-123", "display_name": display}).json()
    return r["token"], call("GET", "/api/users/@me", r["token"])["id"]
def notes(tok, kind=None):
    return [n for n in call("GET", "/api/notifications", tok) if kind is None or n["kind"] == kind]

# jake shares Family with alex; sam is only in "Elsewhere" (alex is there, jake isn't)
Jt, j_id = join(home, "jake", "Jake Ray")
other = call("POST", "/api/guilds", A, json={"name": "Elsewhere"})
other = (other.get("guild") or other)["id"]
St, s_id = join(other, "sam", "Samantha")
game = call("POST", "/api/guilds", Jt, json={"name": "Game Night"})
game = (game.get("guild") or game)["id"]
# Open, so members (not just staff) can invite people to it
call("PATCH", f"/api/guilds/{game}", Jt, json={"join_mode": "open"})

# ---- search: connections only by default (friends + shared servers)
r = call("GET", f"/api/guilds/{game}/invite-search?q=sam", Jt)
assert r["scope"] == "connections" and r["people"] == [], r
r = call("GET", f"/api/guilds/{game}/invite-search?q=ale", Jt)
assert [p["id"] for p in r["people"]] == [a_id] and r["people"][0]["member"] is False, r
assert call("GET", f"/api/guilds/{game}/invite-search?q=ray", Jt)["people"] == []  # not yourself
# display names match too, and people already in the server are marked
r = call("GET", f"/api/guilds/{other}/invite-search?q=samant", A)
assert [(p["id"], p["member"]) for p in r["people"]] == [(s_id, True)], r
call("GET", f"/api/guilds/{game}/invite-search?q=x", St, expect=404)  # not in the server
# instance setting: everyone
call("PUT", "/api/admin/settings", A, json={"invite_search": "everyone"})
r = call("GET", f"/api/guilds/{game}/invite-search?q=samant", Jt)
assert [p["id"] for p in r["people"]] == [s_id], r
call("PUT", "/api/admin/settings", A, expect=400, json={"invite_search": "nobody"})
call("PUT", "/api/admin/settings", A, json={"invite_search": "connections"})

# ---- kids never show up, except to their own parent
kid = call("POST", "/api/kids", A, json={"username": "kiddo", "password": "kid-pass-123"})
k_id = kid["id"] if "id" in kid else kid["user"]["id"]
call("POST", f"/api/kids/{k_id}/guilds", A, json={"guild_id": home})
Kt = requests.post(B + "/api/auth/login", json={"username": "kiddo", "password": "kid-pass-123"}).json()["token"]
call("PUT", "/api/admin/settings", A, json={"invite_search": "everyone"})
assert [p for p in call("GET", f"/api/guilds/{game}/invite-search?q=kid", Jt)["people"]] == []
call("PUT", "/api/admin/settings", A, json={"invite_search": "connections"})
# jake can't invite the kid even by id
r = call("POST", f"/api/guilds/{game}/invite-people", Jt, json={"user_ids": [k_id]})
assert r["sent"] == [] and r["skipped"][0]["user_id"] == k_id, r

# ---- invite one person: a card in the DM, a notification for them
r = call("POST", f"/api/guilds/{game}/invite-people", Jt, json={"user_ids": [a_id, j_id]})
assert len(r["sent"]) == 1 and r["sent"][0]["user_id"] == a_id and r["skipped"][0]["user_id"] == j_id, r
card, dm = r["sent"][0]["card_id"], r["sent"][0]["channel_id"]
msgs = call("GET", f"/api/channels/{dm}/messages", A)
m = [x for x in msgs if x["embeds"] and x["embeds"][0].get("type") == "invite"]
assert m and m[0]["embeds"][0]["card_id"] == card and m[0]["embeds"][0]["guild"]["name"] == "Game Night", msgs
n = notes(A, "server_invite")
assert len(n) == 1 and n[0]["data"]["card_id"] == card and n[0]["read_at"] is None and n[0]["data"]["from"]["id"] == j_id, n
c = call("GET", f"/api/invite-cards/{card}", Jt)
assert c["is_inviter"] and c["people"][0]["seen"] is False and c["people"][0]["joined"] is False, c
c = call("GET", f"/api/invite-cards/{card}", A)  # opening it counts as seeing it
assert notes(A, "server_invite")[0]["read_at"] is not None
assert call("GET", f"/api/invite-cards/{card}", Jt)["people"][0]["seen"] is True
call("GET", f"/api/invite-cards/{card}", St, expect=404)  # not in that chat
call("POST", f"/api/invite-cards/{card}/join", St, expect=403)
r = call("POST", f"/api/invite-cards/{card}/join", A)
assert r["guild_id"] == game and r["card"]["me"]["joined"] is True, r
assert notes(A, "server_invite") == []  # dealt with
acc = notes(Jt, "invite_accepted")
assert len(acc) == 1 and acc[0]["data"]["by"]["id"] == a_id, acc

# ---- invite a party: one card in the party chat, progress, one reminder
call("POST", "/api/friends", Jt, json={"username": "sam"})
call("PUT", f"/api/friends/{j_id}", St)
p = call("POST", "/api/parties", Jt, json={"user_ids": [a_id, s_id]})
assert notes(St, "party_added")[0]["data"]["party"]["id"] == p["id"]
dt, d_id = join(home, "dee")
call("POST", "/api/friends", Jt, json={"username": "dee"}); call("PUT", f"/api/friends/{j_id}", dt)
p2 = call("POST", "/api/parties", Jt, json={"user_ids": [a_id, s_id, d_id]})
r = call("POST", f"/api/guilds/{game}/invite-party", Jt, json={"party_id": p2["id"]})
pc = r["card_id"]
c = call("GET", f"/api/invite-cards/{pc}", St)
assert c["party"] and len(c["people"]) == 3, c
joined = {x["user"]["id"]: x["joined"] for x in c["people"]}
assert joined == {a_id: True, s_id: False, d_id: False}, joined  # alex is already in
assert [x["data"]["card_id"] for x in notes(A, "server_invite")] == []  # no notification for someone already in
assert len(notes(dt, "server_invite")) == 1
# everyone in the party sees who hasn't joined; only the inviter can remind, once
call("POST", f"/api/invite-cards/{pc}/remind/{d_id}", St, expect=403)
call("POST", f"/api/invite-cards/{pc}/remind/{d_id}", Jt)
call("POST", f"/api/invite-cards/{pc}/remind/{d_id}", Jt, expect=400)
call("POST", f"/api/invite-cards/{pc}/remind/{a_id}", Jt, expect=400)  # already in
assert len(notes(dt, "server_invite")) == 1 and notes(dt, "server_invite")[0]["data"]["reminder"] is True
call("POST", f"/api/invite-cards/{pc}/decline", dt)
c = call("GET", f"/api/invite-cards/{pc}", Jt)
assert {x["user"]["id"]: x["declined"] for x in c["people"]}[d_id] is True
call("POST", f"/api/invite-cards/{pc}/join", St)
c = call("GET", f"/api/invite-cards/{pc}", A)
assert {x["user"]["id"]: x["joined"] for x in c["people"]} == {a_id: True, s_id: True, d_id: False}, c
assert notes(Jt, "invite_accepted") and len(notes(Jt, "invite_accepted")) == 1  # party joins don't notify the inviter

# ---- a parent invites their own kid (the parent has to be in the server)
r = call("GET", f"/api/guilds/{game}/invite-search?q=kid", A)
assert [x["id"] for x in r["people"]] == [k_id] and r["people"][0]["your_kid"] is True, r
r = call("POST", f"/api/guilds/{game}/invite-people", A, json={"user_ids": [k_id]})
kc = r["sent"][0]["card_id"]
call("POST", f"/api/invite-cards/{kc}/join", Kt)
assert call("GET", f"/api/invite-cards/{kc}", Kt)["me"]["joined"] is True
call("POST", f"/api/guilds/{game}/invite-people", Kt, expect=403, json={"user_ids": [a_id]})  # kids don't invite

# ---- friend requests come and go as notifications
call("POST", "/api/friends", dt, json={"username": "alex"})
fr = notes(A, "friend_request")
assert len(fr) == 1 and fr[0]["data"]["from"]["id"] == d_id, fr
call("POST", "/api/friends", dt, json={"username": "alex"})  # asking again doesn't stack
assert len(notes(A, "friend_request")) == 1
call("PUT", f"/api/friends/{d_id}", A)
assert notes(A, "friend_request") == [] and notes(dt, "friend_accepted")[0]["data"]["by"]["id"] == a_id
call("POST", "/api/friends", St, json={"username": "dee"})
call("DELETE", f"/api/friends/{s_id}", dt)  # declined
assert notes(dt, "friend_request") == []

# ---- removed from a server / a party
call("DELETE", f"/api/guilds/{game}/members/{s_id}", Jt)
rm = notes(St, "server_removed")
assert rm and rm[0]["data"]["guild"]["name"] == "Game Night" and rm[0]["data"]["banned"] is False, rm
call("DELETE", f"/api/parties/{p['id']}/members/{s_id}", Jt)
assert notes(St, "party_removed")[0]["data"]["party"]["id"] == p["id"]
assert notes(St, "party_added") and all(x["data"]["party"]["id"] != p["id"] for x in notes(St, "party_added"))

# ---- joining by any route clears every invite to that server
g3 = call("POST", "/api/guilds", Jt, json={"name": "Movie Club"}); g3 = (g3.get("guild") or g3)["id"]
call("POST", f"/api/guilds/{g3}/invite-people", Jt, json={"user_ids": [d_id]})
call("POST", f"/api/guilds/{g3}/invite-party", Jt, json={"party_id": p2["id"]})
assert len([x for x in notes(dt, "server_invite") if x["data"]["guild"]["id"] == g3]) == 2
code = call("POST", f"/api/guilds/{g3}/invites", Jt, json={})["code"]
call("POST", f"/api/invites/{code}", dt)  # joined with a link instead
assert [x for x in notes(dt, "server_invite") if x["data"]["guild"]["id"] == g3] == []

# ---- read and clear
unread = [x["id"] for x in notes(St) if x["read_at"] is None]
assert unread
call("POST", "/api/notifications/read", St, json={"ids": unread[:1]})
assert [x for x in notes(St) if x["id"] == unread[0]][0]["read_at"] is not None
call("POST", "/api/notifications/read", St, json={})
assert all(x["read_at"] for x in notes(St))
one = notes(St)[0]["id"]
call("DELETE", f"/api/notifications/{one}", Jt, expect=404)  # not yours
call("DELETE", f"/api/notifications/{one}", St)
call("DELETE", "/api/notifications/all", St)
assert notes(St) == []
print("invites ok")

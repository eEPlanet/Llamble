# Show spaces: off air only the crew can come in; going live tells followers; the audience
# can't send anything; hands in order; bring up / mute / send back change what someone may
# send; moderators manage hands but don't run the show; the director's choices go to all;
# scheduled shows with Interested, reminders and cancel; ending sends guests back.
import json, sys, time, requests
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
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(A), json={"max_uses": 9}))["code"]
reg = lambda n: ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": n, "password": "pass-word-123"}))["token"]
W, X, Y = reg("wren"), reg("xena"), reg("yuri")
me = lambda t: ok(requests.get(B + "/api/users/@me", headers=H(t)))["id"]
a_id, w_id, x_id, y_id = me(A), me(W), me(X), me(Y)

st = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(A), json={"name": "Friday Night Live", "kind": "stage"}))
cid = st["id"]
assert st["kind"] == "stage"
S = lambda t: ok(requests.get(f"{B}/api/channels/{cid}/stage", headers=H(t)))
join = lambda t: requests.post(f"{B}/api/channels/{cid}/voice", headers=H(t))
post = lambda t, path, body=None: requests.post(f"{B}/api/channels/{cid}/stage/{path}", headers=H(t), json=body or {})
notes = lambda t, kind: [n for n in ok(requests.get(f"{B}/api/notifications", headers=H(t))) if n["kind"] == kind]

# ---- off air: only the crew
ok(requests.put(f"{B}/api/channels/{cid}/follow", headers=H(X)))
assert S(X)["following"] and not S(X)["live"] and not S(X)["can_run"]
r = join(X); assert r.status_code == 403 and "isn't live" in r.text, r.text
j = ok(join(A)); assert j["can_speak"] and j["can_video"], j  # staff: on stage
ok(post(X, "live", {"title": "nope"}), 403)

# ---- going live
ok(post(A, "live", {"title": "  Friday Night Live #1 "}))
sa = S(A)
assert sa["live"] and sa["title"] == "Friday Night Live #1" and any(r["user_id"] == a_id and r["role"] == "host" for r in sa["roles"]), sa
assert [n["data"]["title"] for n in notes(X, "show_live")] == ["Friday Night Live #1"]
assert not notes(A, "show_live")
assert any(x["channel_id"] == cid for x in ready(X)["stages"])
ok(post(A, "live"), 400)  # already live
print("off air only the crew comes in; going live tells followers")

# ---- the audience: can't send anything; hands in order
j = ok(join(X)); assert not j["can_speak"] and not j["can_video"], j
ok(join(W)); ok(join(Y))
ok(post(Y, "hand", {"up": True})); ok(post(X, "hand", {"up": True})); ok(post(X, "hand", {"up": True}))
assert [h["user_id"] for h in S(A)["hands"]] == [y_id, x_id]
ok(post(Y, "hand", {"up": False}))
assert [h["user_id"] for h in S(A)["hands"]] == [x_id]
ok(post(A, "hand", {"up": True}), 400)  # already on stage

# ---- bring up, mute, send back
ok(post(W, "bring", {"user_id": x_id}), 403)
ok(post(A, "bring", {"user_id": x_id}))
sa = S(A); assert sa["hands"] == [] and any(r["user_id"] == x_id and r["role"] == "guest" for r in sa["roles"])
j = ok(join(X)); assert j["can_speak"] and j["can_video"], j
ok(post(A, "mute", {"user_id": x_id, "muted": True}))
j = ok(join(X)); assert not j["can_speak"] and j["can_video"], j
ok(post(A, "mute", {"user_id": x_id, "muted": False}))
ok(post(A, "mute", {"user_id": y_id, "muted": True}), 400)  # not on stage
ok(post(X, "back", {"user_id": x_id}))  # a guest can step down
j = ok(join(X)); assert not j["can_speak"] and not j["can_video"], j
print("audience sends nothing; hands in order; bring up, mute, send back")

# ---- moderators manage hands, but don't run the show
ok(post(W, "role", {"user_id": w_id, "role": "moderator"}), 403)
ok(post(A, "role", {"user_id": w_id, "role": "moderator"}))
assert S(W)["can_manage"] and not S(W)["can_run"]
ok(post(Y, "hand", {"up": True}))
ok(post(W, "bring", {"user_id": y_id}))
ok(post(W, "back", {"user_id": y_id}))
ok(post(W, "hands", {"open": False}))
ok(post(X, "hand", {"up": True}), 400)
ok(post(W, "hands", {"open": True}))
ok(post(W, "end"), 403)
ok(post(W, "director", {"layout": "grid"}), 403)
ok(post(W, "role", {"user_id": y_id, "role": "host"}), 403)
# a second host (can run it)
ok(post(A, "role", {"user_id": y_id, "role": "host"}))
assert S(Y)["can_run"]
j = ok(join(Y)); assert j["can_speak"], j
ok(post(A, "role", {"user_id": y_id, "role": "none"}))
print("moderators manage hands; hosts run it")

# ---- the director
ok(post(A, "director", {"layout": "screen", "focus": "screen:" + a_id, "hold": True, "follow_talk": True, "pip": "talkers", "pip_pos": "tl", "pip_size": "l"}))
assert S(X)["director"] == {"layout": "screen", "focus": "screen:" + a_id, "hold": True, "follow_talk": True, "pip": "talkers", "pip_pos": "tl", "pip_size": "l"}, S(X)["director"]
ok(post(A, "director", {"lower_third": {"text": " Maya ", "sub": "Host"}, "title": "Friday Night Live", "card": "Be right back", "junk": 1}))
d = S(X)["director"]
assert d["lower_third"] == {"text": "Maya", "sub": "Host"} and d["title"] == "Friday Night Live" and d["card"] == "Be right back" and "junk" not in d and d["layout"] == "screen", d
ok(post(A, "director", {"card": None, "title": "", "layout": "weird", "lower_third": {"text": ""}}))
d = S(X)["director"]
assert d["card"] is None and d["title"] is None and d["lower_third"] is None and d["layout"] == "auto" and d["focus"] == "screen:" + a_id, d

# ---- ending: guests go back, hands go down
ok(post(Y, "hand", {"up": True}))
ok(post(A, "bring", {"user_id": x_id}))
ok(post(A, "end"))
sa = S(A)
assert not sa["live"] and sa["hands"] == [] and not any(r["role"] == "guest" for r in sa["roles"]), sa
assert any(r["user_id"] == w_id and r["role"] == "moderator" for r in sa["roles"]), "show roles stay"
r = join(X); assert r.status_code == 403
assert not any(x["channel_id"] == cid for x in ready(X)["stages"])
print("director's choices go to everyone; ending sends guests back")

# ---- scheduled shows
soon = int(time.time() * 1000) + 10 * 60_000
later = int(time.time() * 1000) + 3 * 86_400_000
ok(requests.post(f"{B}/api/channels/{cid}/stage/events", headers=H(X), json={"title": "x", "starts_at": later}), 403)
ok(requests.post(f"{B}/api/channels/{cid}/stage/events", headers=H(A), json={"title": "", "starts_at": later}), 400)
e1 = ok(requests.post(f"{B}/api/channels/{cid}/stage/events", headers=H(A), json={"title": "Game night", "description": "Bring snacks", "starts_at": soon}))["id"]
e2 = ok(requests.post(f"{B}/api/channels/{cid}/stage/events", headers=H(A), json={"title": "Season finale", "starts_at": later}))["id"]
assert {n["data"]["title"] for n in notes(X, "show_scheduled")} == {"Game night", "Season finale"}, "followers hear about new shows"
assert not notes(W, "show_scheduled")
ok(requests.put(f"{B}/api/stage-events/{e1}/interested", headers=H(W)))
ok(requests.put(f"{B}/api/stage-events/{e2}/interested", headers=H(W)))
ev = {e["id"]: e for e in S(W)["events"]}
assert [e["id"] for e in S(W)["events"]] == [e1, e2] and ev[e1]["interested"] == 2, ev  # the scheduler is interested too
assert set(S(W)["my_interested"]) == {e1, e2}
ok(requests.delete(f"{B}/api/stage-events/{e2}/interested", headers=H(W)))
ok(requests.put(f"{B}/api/stage-events/{e2}/interested", headers=H(W)))
# the 15-minute reminder (checked every minute)
for _ in range(80):
    if notes(W, "show_reminder"):
        break
    time.sleep(1)
r = notes(W, "show_reminder")
assert len(r) == 1 and r[0]["data"]["when"] == "soon" and r[0]["data"]["title"] == "Game night", r
# going live picks the show that's about to start, and pings the interested
ok(post(A, "live"))
assert S(A)["title"] == "Game night" and S(A)["event_id"] == e1
assert any(n["data"]["title"] == "Game night" for n in notes(W, "show_live"))
ok(post(A, "end"))
assert [e["id"] for e in S(W)["events"]] == [e2]
# cancelling tells the interested; its reminders go away
ok(requests.delete(f"{B}/api/stage-events/{e2}", headers=H(X)), 403)
ok(requests.delete(f"{B}/api/stage-events/{e2}", headers=H(A)))
assert [n["data"]["title"] for n in notes(W, "show_cancelled")] == ["Season finale"]
assert not [n for n in notes(X, "show_scheduled") if n["data"]["title"] == "Season finale"]
assert S(W)["events"] == []
ok(requests.delete(f"{B}/api/channels/{cid}/follow", headers=H(X)))
assert not S(X)["following"]
print("scheduled shows: followers told; interested get reminders and the live ping; cancel tells them")
print("ALL STAGE OK")

# Watch Party spaces: the queue, who controls what's playing, skip votes, the movie library,
# streaming from your device, kids, and the admin switches.
import sys, requests, jwt
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def call(method, path, tok, expect=200, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code == expect, (method, path, r.status_code, r.text[:300])
    return r.json() if r.text else None
s = requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}).json()
A, gid = s["token"], s["guild_id"]
inv = call("POST", f"/api/guilds/{gid}/invites", A, json={"max_uses": 9})["code"]
def reg(n):
    r = requests.post(B + "/api/auth/register", json={"invite": inv, "username": n, "password": "pass-word-123"}).json()
    return r["token"], call("GET", "/api/users/@me", r["token"])["id"]
Jt, j_id = reg("jake")
St, s_id = reg("sam")
Dt, d_id = reg("dee")

# ---- a Watch Party space (needs Manage Channels); voice join works, with no camera
call("POST", f"/api/guilds/{gid}/channels", Jt, expect=403, json={"name": "Movie Night", "kind": "watch"})
w = call("POST", f"/api/guilds/{gid}/channels", A, json={"name": "Movie Night", "kind": "watch"})
assert w["kind"] == "watch", w
cid = w["id"]
v = call("POST", f"/api/channels/{cid}/voice", Jt)
grants = jwt.decode(v["token"], options={"verify_signature": False})["video"]
assert "camera" not in grants.get("canPublishSources", []) and "screen_share" in grants.get("canPublishSources", []), grants
for t in (A, St, Dt):
    call("POST", f"/api/channels/{cid}/voice", t)
# messages work in the space (its chat)
call("POST", f"/api/channels/{cid}/messages", St, json={"content": "popcorn ready"})
# no recording here
r = requests.post(f"{B}/api/channels/{cid}/shows", headers=H(A), json={})
assert r.status_code >= 400, r.status_code

# ---- the queue: anyone adds; the first item starts playing
r = call("POST", f"/api/channels/{cid}/watch/queue", Jt, json={"kind": "link", "src": "https://youtu.be/dQw4w9WgXcQ?t=4", "title": "Song"})
assert r["now"]["item"]["kind"] == "youtube" and r["now"]["item"]["src"] == "dQw4w9WgXcQ" and r["now"]["playing"], r
yt = r["now"]["item"]["id"]
r = call("POST", f"/api/channels/{cid}/watch/queue", St, json={"kind": "link", "src": "https://example.com/films/night.mp4"})
assert r["queue"][0]["kind"] == "url" and r["queue"][0]["title"] == "night.mp4", r
url_item = r["queue"][0]["id"]
call("POST", f"/api/channels/{cid}/watch/queue", St, expect=400, json={"kind": "link", "src": "file:///etc/passwd"})
call("POST", f"/api/channels/{cid}/watch/queue", St, expect=400, json={"kind": "library", "src": "nope"})

# ---- controls: whoever queued it, or Run watch party / Manage Channels
call("POST", f"/api/channels/{cid}/watch/control", St, expect=403, json={"action": "pause"})
r = call("POST", f"/api/channels/{cid}/watch/control", Jt, json={"action": "pause", "pos_ms": 61000})
assert r["now"]["playing"] is False and r["now"]["pos_ms"] == 61000, r["now"]
r = call("POST", f"/api/channels/{cid}/watch/control", A, json={"action": "seek", "pos_ms": 5000})  # owner can
assert r["now"]["pos_ms"] == 5000 and r["run"] is True
assert call("GET", f"/api/channels/{cid}/watch", St)["run"] is False
# give sam "Run watch party" through a role
role = call("POST", f"/api/guilds/{gid}/roles", A, json={"name": "Host", "permissions": 1 << 18})
call("PUT", f"/api/guilds/{gid}/members/{s_id}/roles/{role['id']}", A)
assert call("GET", f"/api/channels/{cid}/watch", St)["run"] is True
call("POST", f"/api/channels/{cid}/watch/control", St, json={"action": "play"})
# removing: only the adder or a runner
dee_item = call("POST", f"/api/channels/{cid}/watch/queue", Dt, json={"kind": "link", "src": "https://example.com/a.webm"})["queue"][-1]["id"]
call("DELETE", f"/api/channels/{cid}/watch/queue/{dee_item}", Jt, expect=403)
call("DELETE", f"/api/channels/{cid}/watch/queue/{dee_item}", Dt)

# ---- "ended" from any player only counts for what's still playing
call("POST", f"/api/channels/{cid}/watch/control", Dt, json={"action": "ended", "item_id": "old"})
assert call("GET", f"/api/channels/{cid}/watch", Dt)["now"]["item"]["id"] == yt
r = call("POST", f"/api/channels/{cid}/watch/control", Dt, json={"action": "ended", "item_id": yt})
assert r["now"]["item"]["id"] == url_item, r

# ---- skip votes: more than half of the 4 people in the room
call("POST", f"/api/channels/{cid}/watch/skip", Jt)
r = call("POST", f"/api/channels/{cid}/watch/skip", Dt)
assert r["now"]["item"]["id"] == url_item and r["now"]["skip_votes"] == 2, r["now"]
r = call("POST", f"/api/channels/{cid}/watch/skip", A)
assert r["now"] is None and r["queue"] == [], r

# ---- movie library: instance staff only
f = requests.post(B + "/api/files", headers=H(A), files={"file": ("Big Movie.mp4", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 100, "video/mp4")}).json()
f = f[0] if isinstance(f, list) else f
call("POST", "/api/watch/library", Jt, expect=403, json={"file_id": f["id"], "title": "Big Movie"})
call("POST", "/api/watch/library", A, json={"file_id": f["id"], "title": "Big Movie"})
lib = call("GET", "/api/watch/library", Dt)
assert lib["on"] and [m["title"] for m in lib["movies"]] == ["Big Movie"], lib
assert requests.get(f"{B}/api/files/{f['id']}", headers=H(Dt)).status_code == 200  # members can play it
r = call("POST", f"/api/channels/{cid}/watch/queue", Dt, json={"kind": "library", "src": f["id"]})
assert r["now"]["item"]["kind"] == "library" and r["now"]["item"]["title"] == "Big Movie"
call("POST", f"/api/channels/{cid}/watch/control", Dt, json={"action": "next"})

# ---- stream from your device: only while you're in the room; ends when you leave
call("POST", "/api/voice/leave", Dt)
call("POST", f"/api/channels/{cid}/watch/queue", Dt, expect=400, json={"kind": "device", "title": "Home video"})
call("POST", f"/api/channels/{cid}/voice", Dt)
r = call("POST", f"/api/channels/{cid}/watch/queue", Dt, json={"kind": "device", "src": "", "title": "Home video"})
assert r["now"]["item"]["kind"] == "device" and r["now"]["item"]["src"] == d_id
call("POST", f"/api/channels/{cid}/watch/queue", Dt, json={"kind": "device", "src": "", "title": "Second clip"})
call("POST", "/api/voice/leave", Dt)
r = call("GET", f"/api/channels/{cid}/watch", A)
assert r["now"] is None and r["queue"] == [], r

# ---- late joiners come in with their mic held while something plays
Et, e_id = reg("eve")
call("POST", "/api/voice/leave", St)
call("POST", f"/api/channels/{cid}/watch/queue", Jt, json={"kind": "link", "src": "https://example.com/long.mp4"})
v = call("POST", f"/api/channels/{cid}/voice", Et)
assert v["held"] is True and v["can_speak"] is False, v
assert "microphone" not in jwt.decode(v["token"], options={"verify_signature": False})["video"].get("canPublishSources", [])
assert call("POST", f"/api/channels/{cid}/voice", A)["held"] is False  # staff aren't held
st = call("GET", f"/api/channels/{cid}/watch", Jt)
assert st["held"] == [e_id], st["held"]
call("POST", f"/api/channels/{cid}/watch/ask-to-talk", Et)
assert call("GET", f"/api/channels/{cid}/watch", Jt)["asked"] == [e_id]
call("POST", f"/api/channels/{cid}/watch/ask-to-talk", Jt, expect=400)  # jake isn't held
call("POST", f"/api/channels/{cid}/watch/let-talk/{e_id}", Dt, expect=403)  # dee doesn't run it
call("POST", f"/api/channels/{cid}/watch/let-talk/{e_id}", Jt)
st = call("GET", f"/api/channels/{cid}/watch", Jt)
assert st["held"] == [] and st["asked"] == [], st
# leaving and coming back while it plays: held again; a pause lets everyone talk
call("POST", "/api/voice/leave", Et)
assert call("POST", f"/api/channels/{cid}/voice", Et)["held"] is True
call("POST", f"/api/channels/{cid}/watch/control", Jt, json={"action": "pause"})
assert call("GET", f"/api/channels/{cid}/watch", Jt)["held"] == []
call("POST", f"/api/channels/{cid}/watch/control", Jt, json={"action": "next"})

# ---- locking a room on the fly: nobody new comes in (people inside stay, staff can enter)
call("POST", f"/api/channels/{cid}/lock", Dt, expect=403, json={"locked": True})
ch = call("POST", f"/api/channels/{cid}/lock", A, json={"locked": True})
assert ch["locked"] is True
call("POST", f"/api/channels/{cid}/voice", St, expect=403)
call("POST", f"/api/channels/{cid}/voice", Et)  # already inside
call("POST", f"/api/channels/{cid}/lock", A, json={"locked": False})
call("POST", f"/api/channels/{cid}/voice", St)

# ---- admin switches
call("PUT", "/api/admin/settings", A, json={"watch_library": False, "watch_device_stream": False})
assert call("GET", "/api/watch/library", Dt) == {"on": False, "movies": []}
call("POST", f"/api/channels/{cid}/watch/queue", Dt, expect=403, json={"kind": "library", "src": f["id"]})
assert "screen_share" not in jwt.decode(call("POST", f"/api/channels/{cid}/voice", Dt)["token"], options={"verify_signature": False})["video"].get("canPublishSources", [])
call("POST", f"/api/channels/{cid}/watch/queue", Dt, expect=403, json={"kind": "device", "src": ""})
call("PUT", "/api/admin/settings", A, json={"watch_party": False})
call("POST", f"/api/guilds/{gid}/channels", A, expect=403, json={"name": "Another", "kind": "watch"})
call("GET", f"/api/channels/{cid}/watch", A, expect=403)
call("POST", f"/api/channels/{cid}/voice", A, expect=403)
call("PUT", "/api/admin/settings", A, json={"watch_party": True, "watch_library": True, "watch_device_stream": True})

# ---- kids: only when a parent turns it on
kid = call("POST", "/api/kids", A, json={"username": "kiddo", "password": "kid-pass-123"})
k_id = kid["id"] if "id" in kid else kid["user"]["id"]
call("POST", f"/api/kids/{k_id}/guilds", A, json={"guild_id": gid})
Kt = requests.post(B + "/api/auth/login", json={"username": "kiddo", "password": "kid-pass-123"}).json()["token"]
call("POST", f"/api/channels/{cid}/voice", Kt, expect=403)
call("POST", f"/api/channels/{cid}/watch/queue", Kt, expect=403, json={"kind": "link", "src": "https://youtu.be/dQw4w9WgXcQ"})
call("POST", f"/api/kids/{k_id}/settings", A, json={"watch_party": True})
call("POST", f"/api/channels/{cid}/voice", Kt)
print("watch ok")

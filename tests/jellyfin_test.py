# Jellyfin as a Watch Party library (against fake_jellyfin.py), plus posters and subtitles
# for uploaded library movies.
import sys, subprocess, time, os, requests
B = sys.argv[1]
JF_PORT = 8197
here = os.path.dirname(os.path.abspath(__file__))
jf = subprocess.Popen([sys.executable, os.path.join(here, "fake_jellyfin.py"), str(JF_PORT)])
time.sleep(0.8)
H = lambda t: {"Authorization": "Bearer " + t}
def call(method, path, tok, expect=200, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code == expect, (method, path, r.status_code, r.text[:300])
    return r.json() if r.text and r.headers.get("content-type", "").startswith("application/json") else r
try:
    s = requests.post(B + "/api/setup", json={"username": "alex", "password": "master-pass1", "server_name": "Family"}).json()
    A, gid = s["token"], s["guild_id"]
    inv = call("POST", f"/api/guilds/{gid}/invites", A, json={"max_uses": 9})["code"]
    J = requests.post(B + "/api/auth/register", json={"invite": inv, "username": "jake", "password": "pass-word-123"}).json()["token"]

    # ---- not connected yet
    call("GET", "/api/watch/jellyfin/items", J, expect=400)
    # ---- admin connects: wrong key, then right; picks the Movies library only
    call("PUT", "/api/admin/settings", A, expect=400, json={"jellyfin_url": "ftp://nas"})
    call("PUT", "/api/admin/settings", A, json={"jellyfin_url": f"http://127.0.0.1:{JF_PORT}/", "jellyfin_key": "wrong"})
    r = call("GET", "/api/watch/jellyfin/libraries", A, expect=400)
    assert "API key" in str(r), r
    call("PUT", "/api/admin/settings", A, json={"jellyfin_key": "test-jf-key"})
    libs = call("GET", "/api/watch/jellyfin/libraries", A)["libraries"]
    assert [l["name"] for l in libs] == ["Movies", "Home Videos", "Collections", "More Movies"] and not any(l["shared"] for l in libs), libs
    call("GET", "/api/watch/jellyfin/libraries", J, expect=403)
    call("PUT", "/api/admin/settings", A, json={"jellyfin_libraries": ["movielib"]})
    assert call("GET", "/api/watch/library", J)["jellyfin"] is True

    # ---- browsing: only the shared library; series open to episodes
    items = call("GET", "/api/watch/jellyfin/items", J)["items"]
    assert sorted(i["title"] for i in items) == ["A Show", "The Big Film", "Wide Film"], items
    assert [i["title"] for i in call("GET", "/api/watch/jellyfin/items?q=big", J)["items"]] == ["The Big Film"]
    eps = call("GET", "/api/watch/jellyfin/items?series=s1", J)["items"]
    assert eps[0]["title"] == "A Show · S1E1 · Pilot" and eps[0]["kind"] == "episode", eps
    call("GET", "/api/watch/jellyfin/items?series=homelib", J, expect=404)

    # ---- collections: a shared Collections library shows each collection like a folder; its
    # movies (only linked, living in a library that isn't shared) can be opened and played
    call("POST", "/api/watch/jellyfin/c1/session", J, expect=404)  # not shared yet
    call("PUT", "/api/admin/settings", A, json={"jellyfin_libraries": ["movielib", "boxlib"]})
    items = call("GET", "/api/watch/jellyfin/items", J)["items"]
    coll = [i for i in items if i["kind"] == "collection"]
    assert [i["title"] for i in coll] == ["The Trilogy"], items
    inside = call("GET", "/api/watch/jellyfin/items?collection=b1", J)["items"]
    assert [(i["title"], i["kind"]) for i in inside] == [("Part One", "movie")], inside
    call("GET", "/api/watch/jellyfin/items?collection=homelib", J, expect=404)
    assert call("POST", "/api/watch/jellyfin/c1/session", J)["direct"] is True
    call("PUT", "/api/admin/settings", A, json={"jellyfin_libraries": ["movielib"]})

    # ---- the private library can't be reached in any way
    for path in ("/api/watch/jellyfin/h1/stream", "/api/watch/jellyfin/h1/poster", "/api/watch/jellyfin/h1/subs/2"):
        call("GET", path, J, expect=404)
    call("POST", "/api/watch/jellyfin/h1/session", J, expect=404)

    # ---- playing: direct when the browser can, converted (HLS) otherwise; subtitles
    s1 = call("POST", "/api/watch/jellyfin/m1/session", J)
    assert s1["direct"] is True and s1["subs"][0]["label"] == "English" and s1["duration_ms"] == 7_200_000, s1
    s2 = call("POST", "/api/watch/jellyfin/m2/session", J)
    assert s2["direct"] is False
    # 4K-style HEVC in MKV: a device that plays HEVC gets it repackaged as it is; one that
    # doesn't gets 1080p H.264 at a set bitrate; plain H.264 is never re-encoded
    assert "MaxWidth=1920" in s2["hls"] and "VideoBitrate=10000000" in s2["hls"] and "VideoCodec=h264&" in s2["hls"], s2["hls"]
    s2h = call("POST", "/api/watch/jellyfin/m2/session?hevc=1", J)
    assert "VideoCodec=hevc,h264" in s2h["hls"] and "SegmentContainer=mp4" in s2h["hls"] and "MaxWidth" not in s2h["hls"], s2h["hls"]
    assert "AllowVideoStreamCopy=true" in s1["hls"] and "MaxWidth" not in s1["hls"], s1["hls"]
    # a bitrate is always sent (Jellyfin reads "none" as zero and shrinks the picture to nothing)
    for x in (s1, s2, s2h):
        assert "VideoBitrate=" in x["hls"], x["hls"]
    assert s1["info"]["plan"] == "direct" and s2["info"]["plan"] == "convert" and s2h["info"]["plan"] in ("copy", "direct"), (s1["info"], s2["info"], s2h["info"])
    r = requests.get(B + "/api/watch/jellyfin/m1/stream", headers={**H(J), "Range": "bytes=100-199"})
    assert r.status_code == 206 and len(r.content) == 100 and r.headers["content-range"].startswith("bytes 100-199/"), (r.status_code, r.headers)
    assert requests.get(B + "/api/watch/jellyfin/m1/stream").status_code == 401  # needs signing in
    sub = call("GET", "/api/watch/jellyfin/m1/subs/2", J)
    assert sub.content.startswith(b"WEBVTT"), sub.content
    assert call("GET", "/api/watch/jellyfin/m1/poster", J).content.startswith(b"\xff\xd8")
    # HLS: signed path, no sign-in needed for the parts; a wrong item or tampered path fails
    hls = s1["hls"]
    assert "test-jf-key" not in hls and "Token" not in hls  # the Jellyfin key never leaves the server
    r = requests.get(B + hls)
    assert r.status_code == 200 and b"main.m3u8" in r.content, (r.status_code, r.text)
    base = hls.split("/master.m3u8")[0]
    assert requests.get(B + base + "/hls1/main/0.ts").content == b"TSPART"
    assert requests.get(B + base.replace("/m1/", "/h1/") + "/master.m3u8").status_code == 403
    tok = base.split("/api/watch/jf/")[1].split("/")[0]
    assert requests.get(B + base.replace(tok, tok[:-1] + ("0" if tok[-1] != "0" else "1")) + "/master.m3u8").status_code == 403

    # ---- queueing a Jellyfin movie in a Watch Party
    w = call("POST", f"/api/guilds/{gid}/channels", A, json={"name": "Movie Night", "kind": "watch"})
    r = call("POST", f"/api/channels/{w['id']}/watch/queue", J, json={"kind": "jellyfin", "src": "m1"})
    assert r["now"]["item"]["kind"] == "jellyfin" and r["now"]["item"]["title"] == "The Big Film", r
    call("POST", f"/api/channels/{w['id']}/watch/queue", J, expect=400, json={"kind": "jellyfin", "src": "h1"})
    call("POST", f"/api/channels/{w['id']}/watch/queue", J, expect=400, json={"kind": "jellyfin", "src": "s1"})  # pick an episode
    # a movie from a shared collection queues; the collection itself doesn't
    call("PUT", "/api/admin/settings", A, json={"jellyfin_libraries": ["movielib", "boxlib"]})
    r = call("POST", f"/api/channels/{w['id']}/watch/queue", J, json={"kind": "jellyfin", "src": "c1"})
    assert any(i["title"] == "Part One" for i in r["queue"]), r
    call("POST", f"/api/channels/{w['id']}/watch/queue", J, expect=400, json={"kind": "jellyfin", "src": "b1"})
    call("PUT", "/api/admin/settings", A, json={"jellyfin_libraries": ["movielib"]})

    # ---- uploaded movies: subtitles are pulled from the video; posters are uploaded
    clip = "/tmp/jf_clip.mp4"
    srt = "/tmp/jf_clip.srt"
    open(srt, "w").write("1\n00:00:00,000 --> 00:00:01,500\nHello there\n")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-i", srt, "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:s", "mov_text", clip], check=True)
    f = requests.post(B + "/api/files", headers=H(A), files={"file": ("Clip.mp4", open(clip, "rb"), "video/mp4")}).json()
    f = f[0] if isinstance(f, list) else f
    call("POST", "/api/watch/library", A, json={"file_id": f["id"], "title": "Clip"})
    for _ in range(40):
        m = [x for x in call("GET", "/api/watch/library", J)["movies"] if x["file_id"] == f["id"]][0]
        if m["subs_file_id"]:
            break
        time.sleep(0.5)
    assert m["subs_file_id"] and not m["poster_file_id"], m
    v = call("GET", f"/api/files/{m['subs_file_id']}", J)
    assert v.content.startswith(b"WEBVTT") and b"Hello there" in v.content, v.content[:80]
    # staff can replace them (an .srt becomes WebVTT); members can't
    s2 = requests.post(B + "/api/files", headers=H(A), files={"file": ("better.srt", b"1\n00:00:00,000 --> 00:00:01,000\nBetter\n", "application/x-subrip")}).json()
    s2 = s2[0] if isinstance(s2, list) else s2
    call("PATCH", f"/api/watch/library/{f['id']}", J, expect=403, json={"subs_file_id": s2["id"]})
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=200x300", "-frames:v", "1", "/tmp/jf_poster.jpg"], check=True)
    pf = requests.post(B + "/api/files", headers=H(A), files={"file": ("poster.jpg", open("/tmp/jf_poster.jpg", "rb"), "image/jpeg")}).json()
    pf = pf[0] if isinstance(pf, list) else pf
    call("PATCH", f"/api/watch/library/{f['id']}", J, expect=403, json={"poster_file_id": pf["id"]})
    call("PATCH", f"/api/watch/library/{f['id']}", A, json={"subs_file_id": s2["id"], "poster_file_id": pf["id"], "title": "Clip (2026)"})
    m = [x for x in call("GET", "/api/watch/library", J)["movies"] if x["file_id"] == f["id"]][0]
    assert call("GET", f"/api/files/{m['poster_file_id']}", J).headers["content-type"].startswith("image/")
    assert m["title"] == "Clip (2026)" and b"Better" in call("GET", f"/api/files/{m['subs_file_id']}", J).content
    # ---- uploads: over the limit says why (not a dropped connection); instance admins (movies) can go bigger
    call("PUT", "/api/admin/settings", A, json={"max_upload_mb": 1})
    big = b"\0" * (2 * 1024 * 1024)
    r = requests.post(B + "/api/files", headers=H(J), files={"file": ("big.mp4", big, "video/mp4")})
    assert r.status_code == 413 and "too big" in r.json()["error"], (r.status_code, r.text[:200])
    r = requests.post(B + "/api/files", headers=H(A), files={"file": ("big.mp4", big, "video/mp4")})
    assert r.status_code == 413  # admins too, for normal uploads
    r = requests.post(B + "/api/files?purpose=library", headers=H(A), files={"file": ("big.mp4", big, "video/mp4")})
    assert r.status_code == 200, r.text[:200]
    r = requests.post(B + "/api/files?purpose=library", headers=H(J), files={"file": ("big.mp4", big, "video/mp4")})
    assert r.status_code == 413
    print("jellyfin ok")
finally:
    jf.terminate()

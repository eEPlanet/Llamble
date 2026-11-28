# A tiny stand-in for a Jellyfin server, for tests: two libraries (Movies is shared, Home
# Videos isn't), a movie with a text subtitle track, a series with an episode, posters,
# a file stream that honors Range, and an HLS playlist with a relative part.
import json, sys, re, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = "test-jf-key"
VIDEO = bytes(range(256)) * 40  # 10240 bytes
ITEMS = {
    "movielib": {"Id": "movielib", "Name": "Movies", "Type": "CollectionFolder"},
    "homelib": {"Id": "homelib", "Name": "Home Videos", "Type": "CollectionFolder"},
    "m1": {"Id": "m1", "Name": "The Big Film", "Type": "Movie", "ProductionYear": 1999, "RunTimeTicks": 72_000_000_000, "ImageTags": {"Primary": "x"}, "parent": "movielib",
           "MediaSources": [{"Id": "m1", "Container": "mp4", "MediaStreams": [
               {"Type": "Video", "Codec": "h264", "Index": 0}, {"Type": "Audio", "Codec": "aac", "Index": 1},
               {"Type": "Subtitle", "Codec": "subrip", "Index": 2, "Language": "eng", "DisplayTitle": "English", "IsTextSubtitleStream": True, "IsDefault": True}]}]},
    "m2": {"Id": "m2", "Name": "Wide Film", "Type": "Movie", "ImageTags": {}, "parent": "movielib",
           "MediaSources": [{"Id": "m2", "Container": "mkv", "MediaStreams": [{"Type": "Video", "Codec": "hevc", "Index": 0}, {"Type": "Audio", "Codec": "dts", "Index": 1}]}]},
    # a real little movie (FAKE_JF_VIDEO) with a slow subtitle track (FAKE_JF_SLOW_SUBS seconds),
    # the way Jellyfin pulls subtitles out of a big MKV
    "m3": {"Id": "m3", "Name": "Real Movie", "Type": "Movie", "RunTimeTicks": 1_200_000_000, "ImageTags": {}, "parent": "movielib",
           "MediaSources": [{"Id": "m3", "Container": "webm", "MediaStreams": [
               {"Type": "Video", "Codec": "vp8", "Index": 0}, {"Type": "Audio", "Codec": "opus", "Index": 1},
               {"Type": "Subtitle", "Codec": "subrip", "Index": 2, "Language": "eng", "DisplayTitle": "English", "IsTextSubtitleStream": True, "IsDefault": True},
               {"Type": "Subtitle", "Codec": "subrip", "Index": 3, "Language": "spa", "DisplayTitle": "Spanish", "IsTextSubtitleStream": True}]}]},
    "s1": {"Id": "s1", "Name": "A Show", "Type": "Series", "ImageTags": {"Primary": "y"}, "parent": "movielib"},
    "e1": {"Id": "e1", "Name": "Pilot", "Type": "Episode", "SeriesName": "A Show", "ParentIndexNumber": 1, "IndexNumber": 1, "parent": "s1",
           "MediaSources": [{"Id": "e1", "Container": "mp4", "MediaStreams": [{"Type": "Video", "Codec": "h264", "Index": 0}]}]},
    "h1": {"Id": "h1", "Name": "Private Birthday", "Type": "Video", "parent": "homelib"},
    # a Collections library: its box set only links to a movie that lives in another library
    # (one that isn't shared), the way Jellyfin collections work
    "boxlib": {"Id": "boxlib", "Name": "Collections", "Type": "CollectionFolder"},
    "morelib": {"Id": "morelib", "Name": "More Movies", "Type": "CollectionFolder"},
    "b1": {"Id": "b1", "Name": "The Trilogy", "Type": "BoxSet", "ImageTags": {"Primary": "z"}, "parent": "boxlib", "links": ["c1"]},
    "c1": {"Id": "c1", "Name": "Part One", "Type": "Movie", "ProductionYear": 2001, "ImageTags": {}, "parent": "morelib",
           "MediaSources": [{"Id": "c1", "Container": "mp4", "MediaStreams": [{"Type": "Video", "Codec": "h264", "Index": 0}, {"Type": "Audio", "Codec": "aac", "Index": 1}]}]},
}

def ancestors(i):
    out, p = [], ITEMS.get(i, {}).get("parent")
    while p:
        out.append({"Id": p})
        p = ITEMS.get(p, {}).get("parent")
    return out

if not os.environ.get("FAKE_JF_VIDEO"):
    ITEMS.pop("m3")  # only for the player test
REAL = open(os.environ["FAKE_JF_VIDEO"], "rb").read() if os.environ.get("FAKE_JF_VIDEO") else VIDEO
STOPS = []      # "stop converting" calls (DELETE /Videos/ActiveEncodings)
SUB_HITS = []   # subtitle tracks asked for

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_DELETE(self):
        path, _, q = self.path.partition("?")
        if path == "/Videos/ActiveEncodings" and f'Token="{KEY}"' in self.headers.get("Authorization", ""):
            STOPS.append(q); return self.send(204, b"")
        self.send(404, {"error": path})
    def send(self, code, body, ctype="application/json", extra=None):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith("/_test"):
            return self.send(200, {"stops": STOPS, "subs": SUB_HITS})
        if f'Token="{KEY}"' not in self.headers.get("Authorization", ""):
            return self.send(401, {"error": "no"})
        path, _, q = self.path.partition("?")
        if path == "/_test":
            return self.send(200, {"stops": STOPS, "subs": SUB_HITS})
        if path == "/Library/VirtualFolders":
            return self.send(200, [{"Name": "Movies", "ItemId": "movielib", "CollectionType": "movies"}, {"Name": "Home Videos", "ItemId": "homelib", "CollectionType": "homevideos"},
                                   {"Name": "Collections", "ItemId": "boxlib", "CollectionType": "boxsets"}, {"Name": "More Movies", "ItemId": "morelib", "CollectionType": "movies"}])
        if path == "/Items":
            pm = re.search(r"ParentId=(\w+)", q)
            if not pm:  # an item list naming no library: some Jellyfin versions answer 400
                return self.send(400, {"error": "Bad Request"})
            parent = pm.group(1)
            term = re.search(r"SearchTerm=([^&]*)", q)
            ids = re.search(r"Ids=(\w+)", q)
            def under(i, root):
                # a box set's movies are linked to it (asked by the box set's id), not filed under it
                if i in ITEMS.get(root, {}).get("links", []): return True
                return any(a["Id"] == root for a in ancestors(i))
            if ids:
                i = ids.group(1)
                return self.send(200, {"Items": [ITEMS[i]] if i in ITEMS and under(i, parent) else []})
            tm = re.search(r"IncludeItemTypes=([\w,]+)", q)
            types = tm.group(1).split(",") if tm else ["Movie", "Series", "Video", "BoxSet", "Episode"]
            items = [v for k, v in ITEMS.items() if v["Type"] in types and under(k, parent)]
            if term:
                t = term.group(1).replace("+", " ").lower()
                items = [v for v in items if t in v["Name"].lower()]
            return self.send(200, {"Items": items})
        m = re.match(r"^/Items/(\w+)/Ancestors$", path)
        if m: return self.send(200, [a for a in ancestors(m.group(1)) if ITEMS.get(a["Id"], {}).get("Type") != "CollectionFolder"] + [{"Id": "root"}])
        m = re.match(r"^/Shows/(\w+)/Episodes$", path)
        if m: return self.send(200, {"Items": [v for v in ITEMS.values() if v.get("parent") == m.group(1)]})
        m = re.match(r"^/Items/(\w+)/Images/Primary$", path)
        if m: return self.send(200, b"\xff\xd8\xff\xe0poster", "image/jpeg")
        m = re.match(r"^/Items/(\w+)$", path)
        if m: return self.send(405, {"error": "older Jellyfin: use /Users/{id}/Items/{id} or /Items?Ids="})
        m = re.match(r"^/Videos/(\w+)/stream$", path)
        if m and "MediaSourceId=" not in q: return self.send(404, {"error": "no media source"})
        if m:
            data, ctype = (REAL, "video/webm") if m.group(1) == "m3" else (VIDEO, "video/mp4")
            r = self.headers.get("Range")
            if r:
                a, b = r.replace("bytes=", "").split("-")
                a, b = int(a), int(b) if b else len(data) - 1
                b = min(b, len(data) - 1)
                return self.send(206, data[a:b + 1], ctype, {"Content-Range": f"bytes {a}-{b}/{len(data)}", "Accept-Ranges": "bytes"})
            return self.send(200, data, ctype, {"Accept-Ranges": "bytes"})
        m = re.match(r"^/Videos/(\w+)/master\.m3u8$", path)
        if m: return self.send(200, b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmain.m3u8?x=1\n", "application/vnd.apple.mpegurl")
        m = re.match(r"^/Videos/(\w+)/hls1/main/0\.ts$", path)
        if m: return self.send(200, b"TSPART", "video/mp2t")
        m = re.match(r"^/Videos/(\w+)/(\w+)/Subtitles/(\d+)/0/Stream\.vtt$", path)
        if m:
            SUB_HITS.append(m.group(3))
            if m.group(1) == "m3": time.sleep(float(os.environ.get("FAKE_JF_SLOW_SUBS", "0")))
            return self.send(200, b"WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n", "text/vtt")
        self.send(404, {"error": path})

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()

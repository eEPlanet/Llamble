# A tiny stand-in for a Jellyfin server, for tests: two libraries (Movies is shared, Home
# Videos isn't), a movie with a text subtitle track, a series with an episode, posters,
# a file stream that honors Range, and an HLS playlist with a relative part.
import json, sys, re
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
    "s1": {"Id": "s1", "Name": "A Show", "Type": "Series", "ImageTags": {"Primary": "y"}, "parent": "movielib"},
    "e1": {"Id": "e1", "Name": "Pilot", "Type": "Episode", "SeriesName": "A Show", "ParentIndexNumber": 1, "IndexNumber": 1, "parent": "s1",
           "MediaSources": [{"Id": "e1", "Container": "mp4", "MediaStreams": [{"Type": "Video", "Codec": "h264", "Index": 0}]}]},
    "h1": {"Id": "h1", "Name": "Private Birthday", "Type": "Video", "parent": "homelib"},
}

def ancestors(i):
    out, p = [], ITEMS.get(i, {}).get("parent")
    while p:
        out.append({"Id": p})
        p = ITEMS.get(p, {}).get("parent")
    return out

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json", extra=None):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if f'Token="{KEY}"' not in self.headers.get("Authorization", ""):
            return self.send(401, {"error": "no"})
        path, _, q = self.path.partition("?")
        if path == "/Library/VirtualFolders":
            return self.send(200, [{"Name": "Movies", "ItemId": "movielib", "CollectionType": "movies"}, {"Name": "Home Videos", "ItemId": "homelib", "CollectionType": "homevideos"}])
        if path == "/Items":
            parent = re.search(r"ParentId=(\w+)", q).group(1)
            term = re.search(r"SearchTerm=([^&]*)", q)
            def under(i, root):
                return any(a["Id"] == root for a in ancestors(i))
            items = [v for k, v in ITEMS.items() if v["Type"] in ("Movie", "Series", "Video") and under(k, parent)]
            if term:
                t = term.group(1).replace("+", " ").lower()
                items = [v for v in items if t in v["Name"].lower()]
            return self.send(200, {"Items": items})
        m = re.match(r"^/Items/(\w+)/Ancestors$", path)
        if m: return self.send(200, ancestors(m.group(1)))
        m = re.match(r"^/Shows/(\w+)/Episodes$", path)
        if m: return self.send(200, {"Items": [v for v in ITEMS.values() if v.get("parent") == m.group(1)]})
        m = re.match(r"^/Items/(\w+)/Images/Primary$", path)
        if m: return self.send(200, b"\xff\xd8\xff\xe0poster", "image/jpeg")
        m = re.match(r"^/Items/(\w+)$", path)
        if m and m.group(1) in ITEMS: return self.send(200, ITEMS[m.group(1)])
        m = re.match(r"^/Videos/(\w+)/stream$", path)
        if m:
            r = self.headers.get("Range")
            if r:
                a, b = r.replace("bytes=", "").split("-")
                a, b = int(a), int(b) if b else len(VIDEO) - 1
                return self.send(206, VIDEO[a:b + 1], "video/mp4", {"Content-Range": f"bytes {a}-{b}/{len(VIDEO)}", "Accept-Ranges": "bytes"})
            return self.send(200, VIDEO, "video/mp4", {"Accept-Ranges": "bytes"})
        m = re.match(r"^/Videos/(\w+)/master\.m3u8$", path)
        if m: return self.send(200, b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmain.m3u8?x=1\n", "application/vnd.apple.mpegurl")
        m = re.match(r"^/Videos/(\w+)/hls1/main/0\.ts$", path)
        if m: return self.send(200, b"TSPART", "video/mp2t")
        m = re.match(r"^/Videos/(\w+)/(\w+)/Subtitles/(\d+)/0/Stream\.vtt$", path)
        if m: return self.send(200, b"WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n", "text/vtt")
        self.send(404, {"error": path})

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()

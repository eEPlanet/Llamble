#!/usr/bin/env python3
"""Writes llamble.com's detail pages (site/<page>.html) from the text below.

Edit the PAGES list and run: python3 tools/site/make_pages.py
Only list what Llamble does today; plans go in the roadmap, not here.
"""
import html, os

SITE = os.path.join(os.path.dirname(__file__), "..", "..", "site")

PAGES = [
    {
        "file": "chat.html",
        "title": "Chat",
        "lead": "Servers with spaces for every kind of talk, and direct messages for everything else. It all lives on a server you run.",
        "media": ("clip", "chat", "Typing a message in a chat; a friend answers and gets a reaction"),
        "cards": [
            ("💬 Servers and spaces", [
                "A server is a group with its own people, spaces and rules",
                "Spaces group themselves by type: Chat, Voice & Video, Watch",
                "Make your own groups and drag spaces between them",
                "Each server has a Board: sticky notes, highlights and news",
            ]),
            ("✍️ Messages", [
                "Replies, reactions, editing and @mentions",
                "Pictures, videos and files up to the size your server allows",
                "GIFs, voice messages and search",
                "Share any message to another chat",
            ]),
            ("🧹 Keeping it tidy", [
                "Staff can delete messages, or many at once",
                "Spaces can clear old messages automatically after a set number of days",
                "Lock a space so only staff can go in",
            ]),
            ("📱 Everywhere", [
                "Windows app, Android app, or any browser",
                "On phones, one panel at a time, made for thumbs",
                "Everything is stored on your server, not ours",
            ]),
        ],
    },
    {
        "file": "voice.html",
        "title": "Voice and video",
        "lead": "Rooms you drop into and out of, with the sound quality and controls of a studio when you want them.",
        "media": ("clip", "voice", "Joining a voice room: the people talking light up"),
        "caption": "Shown: the practice room from the built-in tutorial.",
        "cards": [
            ("🎙️ Sound", [
                "Mic presets from Data saver to Maximum (32 to 510 kbps)",
                "AI noise suppression that runs on your device",
                "Push-to-talk, mute and deafen with hotkeys",
                "Turn each person up or down, or mute everyone else for a moment",
            ]),
            ("📷 Cameras and screens", [
                "Cameras with background effects",
                "Share your screen with its sound, up to 4K where your server allows",
                "Android phones can share their screen too",
            ]),
            ("🎬 Shows and recording", [
                "Record a show from a room, with a director's controls",
                "Windows: record your games on your graphics card",
                "Instant replay: save the last moments with a hotkey",
            ]),
            ("🔊 Extras", [
                "A soundboard for each server",
                "Say \"Hey Llamble\" to ask the AI in a room (if it's on)",
                "On Android, calls keep going with the screen off",
            ]),
        ],
    },
    {
        "file": "watch.html",
        "title": "Watch parties",
        "lead": "A shared player that stays in sync for everyone in the room, with voice and chat beside it.",
        "media": ("img", "watch-party", "A Watch Party room with its queue"),
        "cards": [
            ("🍿 What you can play", [
                "YouTube videos and other links and streams",
                "Movies uploaded to your server's library",
                "Your own Jellyfin library",
                "A video from your own device",
            ]),
            ("🎞️ The room", [
                "A queue anyone in the room can see",
                "Posters and subtitles",
                "Voice and chat side by side with the movie",
            ]),
            ("🛡️ Who decides", [
                "The server admin chooses which sources are allowed",
                "Staff choose who can run the player",
                "Parents can turn Watch Party on or off for each kid",
            ]),
        ],
    },
    {
        "file": "friends.html",
        "title": "Friends and parties",
        "lead": "See who's around and what they're up to, then talk, call or bring them together.",
        "media": ("clip", "friends", "Accepting a friend request and opening their page"),
        "cards": [
            ("👋 Friends", [
                "Add people by username; they accept",
                "See who's online and what game they're playing",
                "Favorites at the top, and private notes only you see",
                "Hide what you're doing, or go invisible",
            ]),
            ("🎉 Parties", [
                "A small group with its own chat and voice",
                "Start one from a friend's page or a call",
                "Invite a whole party to a server at once",
            ]),
            ("💌 Inviting people", [
                "Invite to Llamble: a one-use link that lasts 7 days",
                "Invites can make you friends right away",
                "Admins can turn member invites off",
            ]),
            ("💬 Talk", [
                "Direct messages, parties and voicemail in one place",
                "Message or call from anyone's name",
            ]),
        ],
        "extra_clip": ("dm", "Sending a direct message and getting a reply"),
    },
    {
        "file": "calls.html",
        "title": "Calls and voicemail",
        "lead": "Calls ring like a phone, and nobody misses a message.",
        "media": ("img", "voicemail-greeting", "Choosing a voicemail greeting"),
        "cards": [
            ("📞 Calls", [
                "Ringing with a full-screen Accept and Decline",
                "Missed calls show up so you can call back",
                "Add more people to make a group call",
                "Android rings even when the app is closed",
            ]),
            ("📮 Voicemail", [
                "Callers can leave a voicemail after your greeting",
                "Greetings: a standard one, your words read by a server voice, or record your own",
                "Voicemails get written out as text when the server's speech model is on",
            ]),
            ("⚡ Urgent messages", [
                "Mark a voice message urgent when it can't wait",
            ]),
        ],
    },
    {
        "file": "servers.html",
        "title": "Servers and who gets in",
        "lead": "Each server decides how people join, and who looks after it.",
        "media": ("img", "open-servers", "Open servers you can find and join"),
        "cards": [
            ("🚪 Four ways in", [
                "Open: listed, look around, then join",
                "Look around, then request to join",
                "Request only",
                "Invite only: not listed",
            ]),
            ("🔭 Finding servers", [
                "The binoculars list the open servers on your Llamble",
                "Staff answer requests; after a no, you can ask again in 7 days",
            ]),
            ("🧑‍✈️ Staff", [
                "Built-in roles: Admin, Supervisor, Moderator and Guest",
                "Make your own roles with any mix of powers",
                "Kick and ban",
            ]),
            ("🏠 Your instance", [
                "The instance admin runs the whole Llamble: accounts, settings, updates",
                "Choose who can create servers",
            ]),
        ],
    },
    {
        "file": "families.html",
        "title": "Families",
        "lead": "Kid accounts with parents in charge of who they talk to and where they go.",
        "media": None,
        "cards": [
            ("👨‍👩‍👧 Kid accounts", [
                "Parents make the account and can be its guardians together",
                "Kids can always message their parents",
            ]),
            ("✅ Parents approve", [
                "Chat only with people a parent OKs",
                "Joining a server needs a parent's OK (servers run by family are OK'd automatically)",
                "Kids ask in the app; parents answer in Settings → Family",
            ]),
            ("🌙 Limits", [
                "Quiet hours: no chatting or calls at set times",
                "Kid-safe AI answers whenever a kid is in the conversation",
                "Turn Watch Party on or off",
                "Choose whether they can delete their own messages",
            ]),
        ],
    },
    {
        "file": "ai.html",
        "title": "Optional AI",
        "lead": "An assistant that runs on your own server, not someone else's. Off if you don't want it.",
        "media": None,
        "cards": [
            ("🦙 In chats", [
                "Mention the AI in any chat, or message it directly",
                "Make pictures with /imagine",
                "Kid-safe answers when a kid is in the conversation",
            ]),
            ("🗣️ In rooms", [
                "Say \"Hey Llamble\" in a voice room to ask out loud",
                "It answers with a voice that runs on your server",
            ]),
            ("💻 Your hardware", [
                "The admin picks the model, sized to the server",
                "Members on Windows can lend an idle graphics card to help",
                "Server admins choose where the AI is allowed",
            ]),
        ],
    },
]

NAV = [("chat.html", "Chat"), ("voice.html", "Voice & video"), ("watch.html", "Watch parties"), ("friends.html", "Friends"),
       ("calls.html", "Calls"), ("servers.html", "Servers"), ("families.html", "Families"), ("ai.html", "AI")]

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title} · Llamble</title>
<meta name="description" content="{desc}" />
<link rel="icon" href="favicon.png" />
<link rel="stylesheet" href="style.css" />
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="brand" href="./"><img src="icon.png" alt="" />Llamble</a>
    <nav>
      <a href="./#tour">Tour</a>
      <a href="./#download">Download</a>
      <a href="./#web">Web app</a>
      <a href="./#server">Run a server</a>
      <a href="https://github.com/eEPlanet/Llamble">GitHub</a>
    </nav>
  </header>
  <div class="page-hero">
    <a class="back" href="./#tour">← Back to the tour</a>
    <h1>{title}</h1>
    <p class="lead">{lead}</p>
  </div>
{media}
</div>
<section>
  <div class="wrap">
    <div class="detail">
{cards}
    </div>
{extra}
  </div>
</section>
<section>
  <div class="wrap">
    <h2>More about Llamble</h2>
    <div class="next-pages">
{nav}
    </div>
    <p style="margin-top:26px"><a class="btn primary" href="./#download">Get Llamble</a> <a class="btn ghost" href="./#server">Run your own server</a></p>
  </div>
</section>
<div class="wrap">
  <footer>
    <span>Llamble · free to self-host · <a href="https://github.com/eEPlanet/Llamble">github.com/eEPlanet/Llamble</a></span>
    <span><a href="https://github.com/eEPlanet/Llamble/issues">Report a problem</a></span>
  </footer>
</div>
<script>
  (() => {{
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const vids = document.querySelectorAll("video.shot");
    if (still) return vids.forEach((v) => (v.controls = true));
    const io = new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? e.target.play().catch(() => {{}}) : e.target.pause())), {{ threshold: 0.35 }});
    vids.forEach((v) => io.observe(v));
  }})();
</script>
</body>
</html>
"""

e = html.escape


def media_html(m, caption=None):
    if not m:
        return ""
    kind, name, alt = m
    if kind == "clip":
        tag = f'<video class="shot" src="clips/{name}.mp4" poster="clips/{name}.webp" muted loop playsinline preload="none" aria-label="{e(alt)}"></video>'
    else:
        tag = f'<img class="shot" src="screenshots/{name}.webp" alt="{e(alt)}" />'
    cap = f'\n  <p class="caption">{e(caption)}</p>' if caption else ""
    return f"  {tag}{cap}"


for p in PAGES:
    cards = "\n".join(
        f'      <div class="card"><h3>{e(h)}</h3><ul>' + "".join(f"<li>{e(i)}</li>" for i in items) + "</ul></div>" for h, items in p["cards"]
    )
    extra = ""
    if p.get("extra_clip"):
        name, alt = p["extra_clip"]
        extra = f'    <div style="margin-top:32px">{media_html(("clip", name, alt)).strip()}</div>'
    nav = "\n".join(f'      <a href="{f}">{e(t)}</a>' for f, t in NAV if f != p["file"])
    out = TEMPLATE.format(title=e(p["title"]), desc=e(p["lead"]), lead=e(p["lead"]), media=media_html(p["media"], p.get("caption")), cards=cards, extra=extra, nav=nav)
    with open(os.path.join(SITE, p["file"]), "w") as f:
        f.write(out)
    print("wrote", p["file"])

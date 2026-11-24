// A Watch Party space: the shared player and its queue, with the space's chat beside it.
// Voice is the room itself: join to watch and talk. No screen share, camera or recording.
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { Track } from "livekit-client";
import { api, media, session, upload } from "../api";
import { can, selectChannel, useStore } from "../store";
import { P } from "../types";
import type { Channel } from "../types";
import { toast } from "../ui";
import { joinVoice, leaveVoice, needVideo, participants, setPeopleMuted, useVoice } from "../voice";
import { goOnline } from "../viewing";
import { canStreamFromDevice, loadWatch, startDeviceStream, stopDeviceStream, targetMs, useMyStream, useWatch, watchAction, type WatchItem, type WatchState } from "../watch";
import { ChatView } from "./ChatView";
import { Avatar } from "./common";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

const KIND_LABEL: Record<WatchItem["kind"], string> = { youtube: "YouTube", url: "Link", library: "Movie library", jellyfin: "Jellyfin", device: "From their device" };

export function WatchView({ channel }: { channel: Channel }) {
  const cid = channel.id;
  const st = useWatch((s) => s.byChannel[cid]);
  const v = useVoice();
  const inRoom = v.channelId === cid;
  const people = useStore((s) => Object.values(s.voiceStates).filter((x) => x.channel_id === cid).map((x) => x.user_id).join(","));
  const users = useStore((s) => s.users);
  const kidBlocked = useStore((s) => !!s.me?.is_kid);
  useEffect(() => {
    loadWatch(cid);
    const t = setInterval(() => loadWatch(cid), 30_000);
    return () => clearInterval(t);
  }, [cid]);

  return (
    <div className="watch-split">
      <div className="watch-main">
        <header className="chat-header">
          <span className="watch-emoji">🍿</span>
          <span className="chat-title">{channel.name}</span>
          <span className="watch-people">
            {people
              .split(",")
              .filter(Boolean)
              .map((u) => (
                <span key={u} title={users[u]?.display_name}>
                  <Avatar user={users[u]} size={24} />
                </span>
              ))}
          </span>
          {channel.locked && <span className="muted small" title="Locked: only staff can come in">🔒 Locked</span>}
          {inRoom ? (
            <button className="btn small red" onClick={() => leaveVoice()}>
              Leave
            </button>
          ) : (
            <button className="btn small green" disabled={v.status === "connecting" || (channel.locked && !can(channel.guild_id!, P.LOCK_SPACES) && !can(channel.guild_id!, P.MANAGE_CHANNELS))} onClick={() => joinVoice(cid).catch((e) => toast(e.message, "error"))}>
              {channel.locked ? "🔒 Locked" : v.status === "connecting" ? "Joining…" : "Join to watch"}
            </button>
          )}
        </header>
        {inRoom && st ? (
          <Player cid={cid} st={st} />
        ) : (
          <div className="watch-idle">
            <div className="watch-idle-icon">🍿</div>
            <h2>{channel.name}</h2>
            <p className="muted">{st?.now ? <>Playing now: <b>{st.now.item.title}</b></> : "Nothing is playing yet."}</p>
            <p className="muted small">Join to watch together and talk. Anyone in the room can add to the queue.</p>
            {kidBlocked && <p className="muted small">If it won't let you in, ask a parent to turn on Watch Party for you.</p>}
          </div>
        )}
        {st && <Queue cid={cid} st={st} inRoom={inRoom} />}
      </div>
      <div className="watch-chat">
        <ChatView key={cid} channel={channel} />
      </div>
    </div>
  );
}

function useMe() {
  return useStore((s) => s.me?.id || "");
}

/** The shared player. YouTube, links and library movies play here and line up with the room;
 * a stream from someone's device is their live video. */
function Player({ cid, st }: { cid: string; st: WatchState }) {
  const me = useMe();
  const now = st.now;
  const item = now?.item;
  const mayRun = !!item && (item.added_by === me || st.run);
  const users = useStore((s) => s.users);
  const [vol, setVol] = useState(() => Number(localStorage.getItem("llamble.watchVol") ?? "1"));
  useEffect(() => localStorage.setItem("llamble.watchVol", String(vol)), [vol]);

  const act = (action: string, extra: any = {}) => watchAction(cid, "/control", { action, ...extra }).catch((e) => toast(e.message, "error"));

  if (!item) {
    return (
      <div className="watch-stage empty">
        <div className="muted">Nothing is playing. Add something to the queue below.</div>
      </div>
    );
  }
  return (
    <div className="watch-stage">
      <div className="watch-screen">
        {item.kind === "youtube" ? (
          <YouTubePlayer key={item.id} cid={cid} item={item} vol={vol} />
        ) : item.kind === "device" ? (
          <DeviceStream key={item.id} cid={cid} item={item} vol={vol} />
        ) : (
          <FilePlayer key={item.id} cid={cid} item={item} vol={vol} />
        )}
      </div>
      <div className="watch-bar">
        <div className="watch-now">
          <b className="ellipsis">{item.title}</b>
          <span className="muted small">
            {KIND_LABEL[item.kind]} · added by {users[item.added_by]?.display_name || "someone"}
          </span>
        </div>
        {item.kind !== "device" && <Progress cid={cid} st={st} mayRun={mayRun} onSeek={(ms) => act("seek", { pos_ms: ms })} />}
        <div className="watch-controls">
          {mayRun && item.kind !== "device" && (
            <button className="btn small" onClick={() => act(now!.playing ? "pause" : "play", { pos_ms: Math.round(targetMs(cid) || 0) })}>
              {now!.playing ? "⏸ Pause" : "▶ Play"}
            </button>
          )}
          {mayRun ? (
            <button className="btn small" onClick={() => act("next")}>
              ⏭ Next
            </button>
          ) : (
            <button className="btn small" disabled={now!.voted} onClick={() => watchAction(cid, "/skip").catch((e) => toast(e.message, "error"))}>
              {now!.voted ? `Voted to skip (${now!.skip_votes}/${Math.floor(st.in_room / 2) + 1})` : `Vote to skip${now!.skip_votes ? ` (${now!.skip_votes}/${Math.floor(st.in_room / 2) + 1})` : ""}`}
            </button>
          )}
          <PeopleMute />
          <label className="watch-vol" title="Volume (just for you)">
            🔊
            <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} />
          </label>
        </div>
        <TalkRequests cid={cid} st={st} mayRun={mayRun} />
      </div>
    </div>
  );
}

/** Silence everyone else's voices for me (the movie keeps playing); stays until I turn it off. */
export function PeopleMute({ small }: { small?: boolean }) {
  const on = useVoice((v) => v.peopleMuted);
  return (
    <button className={"btn small" + (on ? " primary" : "")} title="Silence everyone else's voices for you only. Turn it off to hear them again." onClick={() => setPeopleMuted(!on)}>
      {on ? "🔇 People muted" : small ? "🔇 Mute people" : "🔇 Mute people"}
    </button>
  );
}

/** Held late joiners: ask to talk. Whoever runs what's playing: let them talk. */
function TalkRequests({ cid, st, mayRun }: { cid: string; st: WatchState; mayRun: boolean }) {
  const me = useMe();
  const users = useStore((s) => s.users);
  const held = st.held.includes(me);
  const asked = st.asked.includes(me);
  const act = (path: string) => watchAction(cid, path).catch((e) => toast(e.message, "error"));
  return (
    <>
      {held && (
        <div className="watch-held">
          <span>🎬 You came in during the video, so your mic is off until it pauses or ends.</span>
          <button className="btn small" disabled={asked} onClick={() => act("/ask-to-talk")}>
            {asked ? "Asked to talk…" : "Ask to talk"}
          </button>
        </div>
      )}
      {mayRun && st.asked.length > 0 && (
        <div className="watch-held">
          {st.asked.map((u) => (
            <span key={u} className="watch-ask">
              ✋ {users[u]?.display_name || "Someone"} asked to talk
              <button className="btn small primary" onClick={() => act(`/let-talk/${u}`)}>
                Let them talk
              </button>
            </span>
          ))}
        </div>
      )}
      {mayRun && st.held.length > 0 && (
        <button className="btn small link" onClick={() => act("/let-talk/all")}>
          Let everyone talk ({st.held.length} waiting)
        </button>
      )}
    </>
  );
}

function Progress({ cid, st, mayRun, onSeek }: { cid: string; st: WatchState; mayRun: boolean; onSeek: (ms: number) => void }) {
  const dur = useWatchDuration((s) => s.ms[st.now?.item.id || ""] || 0);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const at = Math.min(targetMs(cid) || 0, dur || Infinity);
  return (
    <div className="watch-progress">
      <span className="small muted">{fmt(at)}</span>
      <input type="range" min={0} max={Math.max(1, dur)} value={Math.min(at, dur || at)} disabled={!mayRun || !dur} onChange={(e) => onSeek(Number(e.target.value))} />
      <span className="small muted">{dur ? fmt(dur) : "–:––"}</span>
    </div>
  );
}

// how long each playing item is (learned by whoever's player loads it)
const useWatchDuration = create<{ ms: Record<string, number> }>(() => ({ ms: {} }));
const setDuration = (id: string, ms: number) => ms > 0 && isFinite(ms) && useWatchDuration.setState((s) => ({ ms: { ...s.ms, [id]: ms } }));

/** Keep a player lined up with the room: right spot (within 1.5 s) and playing or paused. */
function useSync(cid: string, item: WatchItem, get: () => { pos: number; paused: boolean } | null, set: (posMs: number | null, play: boolean) => void) {
  const now = useWatch((s) => s.byChannel[cid]?.now);
  useEffect(() => {
    const line = () => {
      const want = targetMs(cid);
      const cur = get();
      const st = useWatch.getState().byChannel[cid]?.now;
      if (want === null || !cur || !st || st.item.id !== item.id) return;
      const off = Math.abs(cur.pos - want);
      set(off > 1500 ? want : null, st.playing);
    };
    line();
    const t = setInterval(line, 3000);
    return () => clearInterval(t);
  }, [cid, item.id, now?.playing, now?.pos_ms, now?.at_ms]);
}

function reportEnded(cid: string, item: WatchItem) {
  watchAction(cid, "/control", { action: "ended", item_id: item.id }).catch(() => {});
}

/** A link or a library movie: a plain video element (HLS streams through hls.js where needed). */
interface Source {
  src: string;
  /** converted (HLS) playback to fall back to if the file won't play as it is */
  fallback?: string;
  subs: { url: string; label: string; lang?: string; on?: boolean }[];
}

let libraryCache: Promise<any> | null = null;
function libraryList(): Promise<any> {
  libraryCache ||= api("/api/watch/library").finally(() => setTimeout(() => (libraryCache = null), 30_000));
  return libraryCache;
}

/** Subtitles are fetched with your sign-in and handed to the player as a local file. */
async function vttBlob(path: string): Promise<string> {
  const r = await fetch(media(path));
  if (!r.ok) throw new Error("no subtitles");
  return URL.createObjectURL(new Blob([await r.text()], { type: "text/vtt" }));
}

async function resolveSource(item: WatchItem): Promise<Source> {
  if (item.kind === "url") return { src: item.src, subs: [] };
  if (item.kind === "library") {
    const lib = await libraryList().catch(() => ({ movies: [] }));
    const m = (lib.movies || []).find((x: any) => x.file_id === item.src);
    const subs = m?.subs_file_id ? [{ url: await vttBlob(`/api/files/${m.subs_file_id}`).catch(() => ""), label: "Subtitles" }].filter((x) => x.url) : [];
    return { src: media(`/api/files/${item.src}`), subs };
  }
  // Jellyfin
  const s = await api(`/api/watch/jellyfin/${item.src}/session`, { method: "POST" });
  const hls = session.server + s.hls;
  const subs = [];
  for (const t of s.subs || []) {
    const url = await vttBlob(`/api/watch/jellyfin/${item.src}/subs/${t.index}?source=${encodeURIComponent(s.media_source_id)}`).catch(() => "");
    if (url) subs.push({ url, label: t.label, lang: t.lang || undefined, on: !!t.default });
  }
  return s.direct ? { src: media(`/api/watch/jellyfin/${item.src}/stream`), fallback: hls, subs } : { src: hls, subs };
}

/** A link, a library movie or a Jellyfin item: one video element (HLS through hls.js where
 * needed), lined up with the room, with subtitles (CC) when there are any. */
function FilePlayer({ cid, item, vol }: { cid: string; item: WatchItem; vol: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [useFallback, setUseFallback] = useState(false);
  const [cc, setCc] = useState(() => localStorage.getItem("llamble.cc") === "1");
  useEffect(() => {
    let dead = false;
    setSource(null);
    setUseFallback(false);
    resolveSource(item)
      .then((s) => !dead && setSource(s))
      .catch((e) => !dead && setProblem(e.message || "This video couldn't be loaded."));
    return () => {
      dead = true;
    };
  }, [item.id]);
  const src = source ? (useFallback && source.fallback ? source.fallback : source.src) : "";
  useEffect(() => {
    const el = ref.current!;
    if (!src) return;
    let hls: any = null;
    const isHls = /\.m3u8(\?|$)/i.test(src);
    if (isHls && !el.canPlayType("application/vnd.apple.mpegurl")) {
      import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported()) return setProblem("This device can't play that stream.");
        hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(el);
      });
    } else el.src = src;
    return () => {
      hls?.destroy();
      el.removeAttribute("src");
      el.load();
    };
  }, [src]);
  // subtitles: show the default (or first) track when CC is on
  useEffect(() => {
    const el = ref.current;
    if (!el || !source) return;
    const tracks = Array.from(el.textTracks);
    const pick = Math.max(0, source.subs.findIndex((x) => x.on));
    tracks.forEach((t, i) => (t.mode = cc && i === pick ? "showing" : "hidden"));
  }, [cc, source, src]);
  useEffect(() => {
    if (ref.current) ref.current.volume = vol;
  }, [vol]);
  useSync(
    cid,
    item,
    () => (ref.current && src ? { pos: ref.current.currentTime * 1000, paused: ref.current.paused } : null),
    (pos, play) => {
      const el = ref.current;
      if (!el) return;
      if (pos !== null) el.currentTime = pos / 1000;
      if (play && el.paused) el.play().catch(() => setProblem("Tap the video to start it (your browser blocked autoplay)."));
      if (!play && !el.paused) el.pause();
    },
  );
  return (
    <>
      <video
        ref={ref}
        className="watch-video"
        playsInline
        onLoadedMetadata={(e) => {
          setDuration(item.id, e.currentTarget.duration * 1000);
          setProblem("");
        }}
        onEnded={() => reportEnded(cid, item)}
        onError={() => {
          // the file as-is didn't play here: switch to Jellyfin's converted version
          if (source?.fallback && !useFallback) return setUseFallback(true);
          setProblem("This video couldn't be played here. The link may not allow it, or the format isn't supported.");
        }}
        onClick={(e) => e.currentTarget.paused && useWatch.getState().byChannel[cid]?.now?.playing && e.currentTarget.play().then(() => setProblem(""))}
      >
        {source?.subs.map((t, i) => <track key={t.url} kind="subtitles" src={t.url} label={t.label} srcLang={t.lang} default={i === 0} />)}
      </video>
      {!!source?.subs.length && (
        <button
          className={"watch-cc" + (cc ? " on" : "")}
          title={cc ? "Hide subtitles" : "Show subtitles"}
          onClick={() => {
            localStorage.setItem("llamble.cc", cc ? "0" : "1");
            setCc(!cc);
          }}
        >
          CC
        </button>
      )}
      {!source && !problem && <div className="watch-problem">Loading…</div>}
      {problem && <div className="watch-problem">{problem}</div>}
    </>
  );
}

// ---------------------------------------------------------------- YouTube

let ytReady: Promise<any> | null = null;
function loadYouTube(): Promise<any> {
  if ((window as any).YT?.Player) return Promise.resolve((window as any).YT);
  ytReady ||= new Promise((ok, fail) => {
    (window as any).onYouTubeIframeAPIReady = () => ok((window as any).YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      ytReady = null;
      fail(new Error("YouTube couldn't load"));
    };
    document.head.appendChild(s);
  });
  return ytReady;
}

function YouTubePlayer({ cid, item, vol }: { cid: string; item: WatchItem; vol: number }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<any>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let dead = false;
    loadYouTube()
      .then((YT) => {
        if (dead || !host.current) return;
        const div = document.createElement("div");
        host.current.appendChild(div);
        player.current = new YT.Player(div, {
          videoId: item.src,
          width: "100%",
          height: "100%",
          host: "https://www.youtube-nocookie.com",
          playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, origin: location.origin.startsWith("http") ? location.origin : undefined },
          events: {
            onReady: (e: any) => {
              e.target.setVolume(Math.round(vol * 100));
              setDuration(item.id, e.target.getDuration() * 1000);
            },
            onStateChange: (e: any) => {
              if (e.data === 0) reportEnded(cid, item);
              if (e.data === 1) setDuration(item.id, e.target.getDuration() * 1000);
            },
            onError: (e: any) => setProblem(e.data === 101 || e.data === 150 || e.data === 153 ? "This video's owner doesn't allow it to be played outside YouTube." : "YouTube couldn't play this video."),
          },
        });
      })
      .catch((e) => setProblem(e.message));
    return () => {
      dead = true;
      try {
        player.current?.destroy();
      } catch {}
      player.current = null;
    };
  }, [item.id]);
  useEffect(() => {
    try {
      player.current?.setVolume?.(Math.round(vol * 100));
    } catch {}
  }, [vol]);
  useSync(
    cid,
    item,
    () => {
      const p = player.current;
      if (!p?.getCurrentTime) return null;
      return { pos: p.getCurrentTime() * 1000, paused: p.getPlayerState() !== 1 };
    },
    (pos, play) => {
      const p = player.current;
      if (!p?.seekTo) return;
      if (pos !== null) p.seekTo(pos / 1000, true);
      const state = p.getPlayerState();
      if (play && state !== 1 && state !== 3) p.playVideo();
      if (!play && state === 1) p.pauseVideo();
    },
  );
  return (
    <>
      <div ref={host} className="watch-video yt" />
      {problem && <div className="watch-problem">{problem}</div>}
    </>
  );
}

// ---------------------------------------------------------------- from someone's device

/** The streamer plays the file here and sends it; everyone else sees their live video. */
function DeviceStream({ cid, item, vol }: { cid: string; item: WatchItem; vol: number }) {
  const me = useMe();
  const mine = item.src === me;
  return mine ? <MyStream cid={cid} item={item} vol={vol} /> : <TheirStream item={item} vol={vol} />;
}

function MyStream({ cid, item, vol }: { cid: string; item: WatchItem; vol: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const file = useMyStream((s) => (s.itemId === item.id ? s.file : null));
  const live = useMyStream((s) => s.live);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    const el = ref.current;
    if (!el || !file) return;
    const url = URL.createObjectURL(file);
    el.src = url;
    el.play()
      .then(() => startDeviceStream(el))
      .catch((e) => setProblem(e.message || "The video couldn't start"));
    return () => {
      stopDeviceStream();
      URL.revokeObjectURL(url);
    };
  }, [file]);
  useEffect(() => {
    if (ref.current) ref.current.volume = vol;
  }, [vol]);
  if (!file)
    return (
      <div className="watch-problem">
        This was queued from your device on another screen (or before a reload). Press Next, or pick the file again:{" "}
        <label className="btn small">
          Choose file
          <input type="file" accept="video/*,audio/*" hidden onChange={(e) => e.target.files?.[0] && useMyStream.setState({ file: e.target.files[0], itemId: item.id })} />
        </label>
      </div>
    );
  return (
    <>
      <video ref={ref} className="watch-video" playsInline controls onEnded={() => (stopDeviceStream(), reportEnded(cid, item))} />
      <div className="watch-live-tag">{live ? "🔴 Streaming to the room" : "Starting…"}</div>
      {problem && <div className="watch-problem">{problem}</div>}
    </>
  );
}

function TheirStream({ item, vol }: { item: WatchItem; vol: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const version = useVoice((v) => v.version);
  useEffect(() => {
    needVideo(item.src, "screen", true);
    return () => needVideo(item.src, "screen", false);
  }, [item.src]);
  const track = useMemo(() => {
    const p = participants().find((x) => x.identity === item.src);
    return p?.getTrackPublication(Track.Source.ScreenShare)?.track || null;
  }, [item.src, version]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  useEffect(() => {
    if (ref.current) ref.current.volume = vol;
  }, [vol]);
  return (
    <>
      <video ref={ref} className="watch-video" playsInline autoPlay muted={false} />
      {!track && <div className="watch-problem">Waiting for their video…</div>}
    </>
  );
}

// ---------------------------------------------------------------- the queue

function Queue({ cid, st, inRoom }: { cid: string; st: WatchState; inRoom: boolean }) {
  const me = useMe();
  const users = useStore((s) => s.users);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [lib, setLib] = useState(false);
  const add = async (body: any) => {
    setBusy(true);
    try {
      const r = await watchAction(cid, "/queue", body);
      setLink("");
      return r;
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const streamFile = async (f: File) => {
    const before = new Set([st.now?.item.id, ...st.queue.map((q) => q.id)]);
    const r = await add({ kind: "device", title: f.name.replace(/\.[^.]+$/, "") });
    const mine = r && [r.now?.item, ...r.queue].find((x) => x && !before.has(x.id) && x.kind === "device");
    if (mine) useMyStream.setState({ file: f, itemId: mine.id });
  };
  return (
    <div className="watch-queue">
      <div className="watch-queue-head">
        <b>Up next</b>
        <span className="muted small">{st.queue.length ? `${st.queue.length} in the queue` : "The queue is empty"}</span>
      </div>
      {st.queue.map((q, i) => (
        <div key={q.id} className="watch-q">
          <span className="muted small">{i + 1}</span>
          <span className="grow ellipsis">
            <b>{q.title}</b> <span className="muted small">· {KIND_LABEL[q.kind]} · {users[q.added_by]?.display_name || "someone"}</span>
          </span>
          {(q.added_by === me || st.run) && (
            <button className="btn small link" title="Remove" onClick={() => watchAction(cid, `/queue/${q.id}`, undefined, "DELETE").catch((e) => toast(e.message, "error"))}>
              ✕
            </button>
          )}
        </div>
      ))}
      {inRoom ? (
        <div className="watch-add">
          <form
            className="row gap"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim()) add({ kind: "link", src: link.trim() });
            }}
          >
            <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a YouTube or video link" />
            <button className="btn primary" disabled={busy || !link.trim()}>
              Add
            </button>
          </form>
          <div className="row gap" style={{ flexWrap: "wrap" }}>
            {st.sources.library && (
              <button className="btn small" onClick={() => setLib(!lib)}>
                🎬 Movie library
              </button>
            )}
            {st.sources.device && canStreamFromDevice() && (
              <label className="btn small" title="Plays a video file from this device to everyone in the room. Keep this window open while it plays.">
                📁 Stream a file from this device
                <input type="file" accept="video/*,audio/*" hidden onChange={(e) => e.target.files?.[0] && streamFile(e.target.files[0])} />
              </label>
            )}
          </div>
          {lib && <LibraryPicker onPick={(kind, id) => (add({ kind, src: id }), setLib(false))} />}
        </div>
      ) : (
        <div className="muted small">Join the room to add to the queue.</div>
      )}
    </div>
  );
}

/** Movies to pick: the instance's Jellyfin libraries and/or its uploaded movies, with posters. */
function LibraryPicker({ onPick }: { onPick: (kind: "library" | "jellyfin", id: string) => void }) {
  const [lib, setLib] = useState<{ jellyfin: boolean; movies: any[] } | null>(null);
  const [tab, setTab] = useState<"jellyfin" | "uploaded">("jellyfin");
  const [q, setQ] = useState("");
  const [series, setSeries] = useState<{ id: string; title: string } | null>(null);
  const [jf, setJf] = useState<any[] | null>(null);
  useEffect(() => {
    api("/api/watch/library")
      .then((r) => {
        setLib(r);
        if (!r.jellyfin) setTab("uploaded");
      })
      .catch(() => setLib({ jellyfin: false, movies: [] }));
  }, []);
  useEffect(() => {
    if (tab !== "jellyfin" || !lib?.jellyfin) return;
    setJf(null);
    const t = setTimeout(
      () =>
        api(`/api/watch/jellyfin/items?${series ? `series=${series.id}` : `q=${encodeURIComponent(q.trim())}`}`)
          .then((r) => setJf(r.items))
          .catch((e) => (toast(e.message, "error"), setJf([]))),
      q ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [tab, q, series, lib?.jellyfin]);
  if (!lib) return <div className="muted small">Loading…</div>;
  const uploaded = lib.movies.filter((m) => !q.trim() || m.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="watch-lib">
      <div className="row gap">
        {lib.jellyfin && (
          <div className="tabs">
            <button className={"tab" + (tab === "jellyfin" ? " on" : "")} onClick={() => (setTab("jellyfin"), setSeries(null))}>
              Jellyfin
            </button>
            <button className={"tab" + (tab === "uploaded" ? " on" : "")} onClick={() => setTab("uploaded")}>
              Uploaded
            </button>
          </div>
        )}
        {!series && <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />}
        {series && (
          <button className="btn small" onClick={() => setSeries(null)}>
            ‹ {series.title}
          </button>
        )}
      </div>
      <div className="poster-grid">
        {tab === "jellyfin" &&
          (jf === null ? (
            <div className="muted small">Loading…</div>
          ) : (
            jf.map((it) => (
              <button key={it.id} className="poster" onClick={() => (it.kind === "series" ? setSeries({ id: it.id, title: it.title }) : onPick("jellyfin", it.id))} title={it.title}>
                {it.has_poster ? <img src={media(`/api/watch/jellyfin/${it.id}/poster`)} alt="" loading="lazy" /> : <span className="poster-blank">🎬</span>}
                <span className="poster-title">{it.title}</span>
                <span className="muted small">{it.kind === "series" ? "Show ›" : it.year || ""}</span>
              </button>
            ))
          ))}
        {tab === "uploaded" &&
          uploaded.map((m) => (
            <button key={m.file_id} className="poster" onClick={() => onPick("library", m.file_id)} title={m.title}>
              {m.poster_file_id ? <img src={media(`/api/files/${m.poster_file_id}`)} alt="" loading="lazy" /> : <span className="poster-blank">🎬</span>}
              <span className="poster-title">{m.title}</span>
              {m.subs_file_id && <span className="muted small">CC</span>}
            </button>
          ))}
        {tab === "uploaded" && !uploaded.length && <div className="muted small">No uploaded movies{q ? " match" : " yet. Instance staff can add them in Settings → Watch Party"}.</div>}
        {tab === "jellyfin" && jf?.length === 0 && <div className="muted small">Nothing found.</div>}
      </div>
    </div>
  );
}

/** Settings → Watch Party (instance staff): the module switches, Jellyfin and the uploaded movies. */
export function WatchAdmin({ f, set }: { f: any; set: (k: string, v: any) => void }) {
  const [movies, setMovies] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [up, setUp] = useState<number | null>(null);
  const reload = () => api("/api/watch/library").then((r) => setMovies(r.movies)).catch(() => {});
  useEffect(() => {
    reload();
  }, [f.watch_library]);
  const addMovie = async (file: File) => {
    setUp(0);
    try {
      const u = await upload(file, file.name, (p: number) => setUp(p), undefined, "library");
      await api("/api/watch/library", { body: { file_id: u.id, title: title.trim() || file.name.replace(/\.[^.]+$/, "") } });
      setTitle("");
      reload();
      // the poster and subtitles are pulled from the video in the background
      setTimeout(reload, 6000);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setUp(null);
    }
  };
  const attach = async (fid: string, what: "poster_file_id" | "subs_file_id", file: File) => {
    try {
      const u = await upload(file, file.name);
      await api(`/api/watch/library/${fid}`, { method: "PATCH", body: { [what]: u.id } });
      reload();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <>
      <div className="profile-section">Watch Party</div>
      <label className="perm-row">
        <span className="grow">
          <b>Watch Party spaces</b>
          <div className="muted small">Servers can add Watch Party spaces: voice, chat and a shared player with a queue.</div>
        </span>
        <input type="checkbox" checked={f.watch_party ?? true} onChange={(e) => set("watch_party", e.target.checked)} />
      </label>
      <label className="perm-row">
        <span className="grow">
          <b>Movie library</b>
          <div className="muted small">Movies from your Jellyfin server and/or movies uploaded here, for everyone's watch parties.</div>
        </span>
        <input type="checkbox" checked={f.watch_library ?? true} onChange={(e) => set("watch_library", e.target.checked)} />
      </label>
      <label className="perm-row">
        <span className="grow">
          <b>Stream a file from your device</b>
          <div className="muted small">Members can play a video file from their own device to the room (it isn't stored on the server).</div>
        </span>
        <input type="checkbox" checked={f.watch_device_stream ?? true} onChange={(e) => set("watch_device_stream", e.target.checked)} />
      </label>
      {(f.watch_library ?? true) && <JellyfinSetup f={f} set={set} />}
      {(f.watch_library ?? true) && (
        <div className="watch-admin-lib">
          <div className="small">
            <b>Uploaded movies</b> <span className="muted">(only add movies you have the right to show to your members)</span>
          </div>
          {movies.map((m) => (
            <div key={m.file_id} className="watch-q">
              {m.poster_file_id ? <img className="lib-thumb" src={media(`/api/files/${m.poster_file_id}`)} alt="" /> : <span className="lib-thumb">🎬</span>}
              <span className="grow ellipsis">
                {m.title} {m.subs_file_id && <span className="muted small">· CC</span>}
              </span>
              <label className="btn small link" title="Use your own poster picture">
                Poster…
                <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && attach(m.file_id, "poster_file_id", e.target.files[0])} />
              </label>
              <label className="btn small link" title="Subtitles: a .srt or .vtt file">
                Subtitles…
                <input type="file" accept=".srt,.vtt,text/vtt" hidden onChange={(e) => e.target.files?.[0] && attach(m.file_id, "subs_file_id", e.target.files[0])} />
              </label>
              <button className="btn small link" onClick={() => api(`/api/watch/library/${m.file_id}`, { method: "DELETE" }).then(reload)}>
                Remove
              </button>
            </div>
          ))}
          <div className="row gap">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" />
            <label className="btn small">
              {up !== null ? `Uploading ${Math.round(up * 100)}%` : "Add a movie…"}
              <input type="file" accept="video/*" hidden disabled={up !== null} onChange={(e) => e.target.files?.[0] && addMovie(e.target.files[0])} />
            </label>
          </div>
          <div className="muted small">Built-in subtitles are taken from the video automatically. Add a poster with Poster…; you can replace the subtitles with Subtitles….</div>
        </div>
      )}
    </>
  );
}

/** Connect a Jellyfin server and choose which of its libraries to share. */
function JellyfinSetup({ f, set }: { f: any; set: (k: string, v: any) => void }) {
  const [url, setUrl] = useState(f.jellyfin_url || "");
  const [key, setKey] = useState(f.jellyfin_key || "");
  const [libs, setLibs] = useState<{ id: string; name: string; type?: string; shared: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (body: any) => api("/api/admin/settings", { method: "PUT", body });
  const find = async () => {
    setBusy(true);
    try {
      await save({ jellyfin_url: url.trim(), jellyfin_key: key.trim() });
      set("jellyfin_url", url.trim());
      set("jellyfin_key", key.trim());
      setLibs((await api("/api/watch/jellyfin/libraries")).libraries);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (f.jellyfin_url && f.jellyfin_key) api("/api/watch/jellyfin/libraries").then((r) => setLibs(r.libraries)).catch(() => {});
  }, []);
  const toggle = async (id: string, on: boolean) => {
    const next = Array.from(new Set([...(f.jellyfin_libraries || []).filter((x: string) => x !== id), ...(on ? [id] : [])]));
    try {
      await save({ jellyfin_libraries: next });
      set("jellyfin_libraries", next);
      setLibs((l) => l && l.map((x) => (x.id === id ? { ...x, shared: on } : x)));
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const disconnect = async () => {
    await save({ jellyfin_url: "", jellyfin_key: "", jellyfin_libraries: [] }).catch(() => {});
    set("jellyfin_url", "");
    set("jellyfin_key", "");
    set("jellyfin_libraries", []);
    setUrl("");
    setKey("");
    setLibs(null);
  };
  return (
    <div className="watch-admin-lib">
      <div className="small">
        <b>Jellyfin</b> <span className="muted">(play movies and shows from your Jellyfin server; members don't need Jellyfin accounts)</span>
      </div>
      <div className="row gap" style={{ flexWrap: "wrap" }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://your-nas:8096" />
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key (Jellyfin dashboard → API Keys)" autoComplete="off" />
        <button className="btn small primary" disabled={busy || !url.trim() || !key.trim()} onClick={find}>
          {busy ? "Connecting…" : libs ? "Reconnect" : "Connect"}
        </button>
        {f.jellyfin_url && (
          <button className="btn small link" onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>
      {libs && (
        <>
          <div className="muted small">Share these libraries with Watch Parties:</div>
          {libs.map((l) => (
            <label key={l.id} className="jf-lib-row">
              <input type="checkbox" checked={l.shared} onChange={(e) => toggle(l.id, e.target.checked)} />
              <span>{l.name}</span>
            </label>
          ))}
        </>
      )}
    </div>
  );
}

/** What people see when they open a locked space. */
export function LockedSpace({ channel }: { channel: Channel }) {
  return (
    <div className="watch-idle locked-space">
      <div className="watch-idle-icon">🔒</div>
      <h2>{channel.name} is locked</h2>
      <p className="muted">The moderators have closed it for now. It'll open again when they unlock it.</p>
    </div>
  );
}

/** Opening a chat while invisible: chats are live, so going in shows you as Online. */
export function InvisibleGate({ channel }: { channel: Channel }) {
  return (
    <div className="watch-idle locked-space">
      <div className="watch-idle-icon">⚪</div>
      <h2>You're invisible</h2>
      <p className="muted">Chats are live: opening #{channel.name} shows you as Online, and people can see you're here.</p>
      <div className="row gap">
        <button className="btn primary" onClick={() => goOnline()}>
          Go online and open it
        </button>
        <button className="btn" onClick={() => selectChannel(channel.guild_id!, null)}>
          Not now
        </button>
      </div>
    </div>
  );
}

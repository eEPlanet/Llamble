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
import { joinVoice, leaveVoice, needVideo, participants, setFriendsOnly, setPeopleMuted, toggleDeafen, toggleMute, useVoice } from "../voice";
import { HearButton } from "./HearButton";
import { goOnline } from "../viewing";
import { canStreamFromDevice, loadWatch, startDeviceStream, stopDeviceStream, targetMs, useMyStream, useWatch, watchAction, type WatchItem, type WatchState } from "../watch";
import { ChatView } from "./ChatView";
import { Avatar, Icon } from "./common";

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
  // chat or the queue, beside the player (below it on a phone)
  const [side, setSide] = useState<"chat" | "queue">("chat");
  // full screen: the player fills the screen; its controls (and the chat, if opened) sit on a bar
  // that fades away while you watch and comes back when you move or tap
  const [full, setFull] = useState(false);
  const [fullChat, setFullChat] = useState(false);
  const [bar, setBar] = useState(true);
  const hideT = useRef<number>();
  const wake = () => {
    setBar(true);
    clearTimeout(hideT.current);
    hideT.current = window.setTimeout(() => setBar(false), 3000);
  };
  const toggleFull = (on: boolean) => {
    setFull(on);
    setFullChat(false);
    if (on) {
      wake();
      // also hide the system's bars where the device allows it
      document.documentElement
        .requestFullscreen?.()
        // phones: turn the movie sideways (where the device allows it)
        .then(() => (screen.orientation as any)?.lock?.("landscape"))
        .catch(() => {});
    } else {
      try {
        (screen.orientation as any)?.unlock?.();
      } catch {}
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  };
  useEffect(() => {
    // Esc or the system's back gesture left full screen
    const f = () => !document.fullscreenElement && setFull(false);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);
  useEffect(() => {
    if (!full) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && toggleFull(false);
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [full]);
  useEffect(() => {
    if (!inRoom && full) toggleFull(false);
  }, [inRoom]);
  useEffect(() => {
    loadWatch(cid);
    const t = setInterval(() => loadWatch(cid), 30_000);
    return () => clearInterval(t);
  }, [cid]);

  return (
    <div
      className={"watch-split" + (full ? " full" + (bar || fullChat ? "" : " bar-hidden") + (fullChat ? " full-chat" : "") : "")}
      onPointerMove={full ? wake : undefined}
      onPointerDown={full ? wake : undefined}
    >
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
        </header>
        {inRoom && st ? (
          <>
            <Player cid={cid} st={st} full={full} onFull={toggleFull} fullChat={fullChat} onFullChat={() => setFullChat(!fullChat)} />
            <div className="call-controls watch-call">
              <button className={"call-btn" + (v.muted ? " off" : "")} onClick={toggleMute} title="Mute" disabled={!v.canSpeak}>
                <Icon name={v.muted ? "micOff" : "mic"} size={22} />
              </button>
              <button className={"call-btn" + (v.deafened ? " off" : "")} onClick={toggleDeafen} title="Deafen">
                <Icon name={v.deafened ? "deaf" : "headphones"} size={22} />
              </button>
              <HearButton call />
              <button className="call-btn hang" onClick={() => leaveVoice()} title="Disconnect">
                <Icon name="phoneOff" size={22} />
              </button>
            </div>
          </>
        ) : (
          // the same as a Voice & Video room you're not in yet
          <div className="voice-view idle">
            <span className="watch-idle-icon">🍿</span>
            <h2>{channel.name}</h2>
            <p className="muted">
              {people ? `${people.split(",").filter(Boolean).length} watching` : "No one is here yet."}
              {st?.now ? <> · Playing now: <b>{st.now.item.title}</b></> : ""}
            </p>
            <button
              className="btn green"
              disabled={v.status === "connecting" || (channel.locked && !can(channel.guild_id!, P.LOCK_SPACES) && !can(channel.guild_id!, P.MANAGE_CHANNELS))}
              onClick={() => joinVoice(cid).catch((e) => toast(e.message, "error"))}
            >
              {channel.locked ? "🔒 Locked" : v.status === "connecting" ? (v.step ? v.step + "…" : "Connecting…") : "Join Watch Party"}
            </button>
            {v.error && <p className="form-error">{v.error}</p>}
            {kidBlocked && <p className="muted small">If it won't let you in, ask a parent to turn on Watch Party for you.</p>}
          </div>
        )}
      </div>
      <div className="watch-chat">
        <div className="watch-tabs">
          <button className={"watch-tab" + (side === "chat" ? " on" : "")} onClick={() => setSide("chat")}>
            💬 Chat
          </button>
          <button className={"watch-tab" + (side === "queue" ? " on" : "")} onClick={() => setSide("queue")}>
            🎬 Queue{st?.queue?.length ? ` (${st.queue.length})` : ""}
          </button>
        </div>
        <div className="watch-side">{side === "chat" || fullChat ? <ChatView key={cid} channel={channel} /> : st ? <Queue cid={cid} st={st} inRoom={inRoom} /> : null}</div>
      </div>
    </div>
  );
}

function useMe() {
  return useStore((s) => s.me?.id || "");
}

/** The shared player. YouTube, links and library movies play here and line up with the room;
 * a stream from someone's device is their live video. */
function Player({ cid, st, full, onFull, fullChat, onFullChat }: { cid: string; st: WatchState; full: boolean; onFull: (on: boolean) => void; fullChat: boolean; onFullChat: () => void }) {
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
          {mayRun && item.kind !== "device" && <SeekButton cid={cid} itemId={item.id} dir={-1} onSeek={(ms) => act("seek", { pos_ms: ms })} />}
          {mayRun && item.kind !== "device" && (
            <button className="btn small" onClick={() => act(now!.playing ? "pause" : "play", { pos_ms: Math.round(targetMs(cid) || 0) })}>
              {now!.playing ? "⏸ Pause" : "▶ Play"}
            </button>
          )}
          {mayRun && item.kind !== "device" && <SeekButton cid={cid} itemId={item.id} dir={1} onSeek={(ms) => act("seek", { pos_ms: ms })} />}
          {mayRun ? (
            <button className="btn small" onClick={() => act("next")}>
              ⏭ Next
            </button>
          ) : (
            <button className="btn small" disabled={now!.voted} onClick={() => watchAction(cid, "/skip").catch((e) => toast(e.message, "error"))}>
              {now!.voted ? `Voted to skip (${now!.skip_votes}/${Math.floor(st.in_room / 2) + 1})` : `Vote to skip${now!.skip_votes ? ` (${now!.skip_votes}/${Math.floor(st.in_room / 2) + 1})` : ""}`}
            </button>
          )}
          <label className="watch-vol" title="Volume (just for you)">
            🔊
            <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} />
          </label>
          <MuteChoices />
          {full && (
            <button className={"btn small" + (fullChat ? " primary" : "")} onClick={onFullChat}>
              💬 Chat
            </button>
          )}
          <button className="btn small" onClick={() => onFull(!full)} title={full ? "Leave full screen (Esc)" : "Full screen"}>
            {full ? "↙ Exit full screen" : "⛶ Full screen"}
          </button>
        </div>
        <TalkRequests cid={cid} st={st} mayRun={mayRun} />
      </div>
    </div>
  );
}

/** Back or forward 15 seconds. Hold it to keep going (faster the longer you hold). */
function SeekButton({ cid, itemId, dir, onSeek }: { cid: string; itemId: string; dir: 1 | -1; onSeek: (ms: number) => void }) {
  const dur = useWatchDuration((s) => s.ms[itemId] || 0);
  const held = useRef<{ t: number; pos: number; steps: number } | null>(null);
  const jump = () => {
    const h = held.current!;
    const step = h.steps < 4 ? 15_000 : h.steps < 10 ? 30_000 : 60_000;
    h.pos = Math.max(0, Math.min(dur ? dur - 1000 : Infinity, h.pos + dir * step));
    h.steps++;
    onSeek(Math.round(h.pos));
  };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    held.current = { t: 0, pos: targetMs(cid) || 0, steps: 0 };
    jump();
    const h = held.current;
    h.t = window.setTimeout(function again() {
      if (held.current !== h) return;
      jump();
      h.t = window.setTimeout(again, 350);
    }, 500);
  };
  const up = () => {
    if (held.current) clearTimeout(held.current.t);
    held.current = null;
  };
  const back = dir < 0;
  return (
    <button
      className="btn small"
      title={back ? "Back 15 seconds (hold to rewind)" : "Forward 15 seconds (hold to fast forward)"}
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={up}
      onPointerCancel={up}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSeek(Math.max(0, Math.min(dur ? dur - 1000 : Infinity, (targetMs(cid) || 0) + dir * 15_000)));
        }
      }}
    >
      {back ? "⟲ 15" : "15 ⟳"}
    </button>
  );
}

/** Mute everyone else, or hear only friends (and only friends hear you): for whoever picks it. */
function MuteChoices() {
  const v = useVoice();
  return (
    <>
      <button
        className={"btn small" + (v.peopleMuted ? " red" : "")}
        onClick={() => setPeopleMuted(!v.peopleMuted)}
        title="Silence everyone else's voices for you (the movie keeps playing)"
      >
        🔇 {v.peopleMuted ? "Everyone muted" : "Mute everyone"}
      </button>
      <button
        className={"btn small" + (v.friendsOnly ? " green" : "")}
        onClick={() => setFriendsOnly(!v.friendsOnly)}
        title="Hear only your friends, and only they hear you"
      >
        💚 {v.friendsOnly ? "Friends only: on" : "Friends only"}
      </button>
    </>
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
/** Keep a player lined up with the room, gently, the way watch-together players do:
 * - a little off (under 5 s): play a touch faster or slower until it's caught up (no jumps, so
 *   no rebuffering; a converted stream that jumps makes Jellyfin restart its conversion)
 * - far off, or stuck on one frame: jump to the room's spot, then leave it alone for a while
 * - while it's loading or buffering it isn't judged at all
 * Returns a function to line up right now (call it when the video becomes ready). */
function useSync(
  cid: string,
  item: WatchItem,
  get: () => { pos: number; paused: boolean; busy?: boolean } | null,
  set: (posMs: number | null, play: boolean, rate?: number) => void,
) {
  const now = useWatch((s) => s.byChannel[cid]?.now);
  const lineRef = useRef<() => void>(() => {});
  // always the latest player: these checks outlive renders (an old copy from before the video
  // loaded never saw it, so a movie you came back to sat on a black frame)
  const io = useRef({ get, set });
  io.current = { get, set };
  useEffect(() => {
    let last = -1;
    let stuck = 0;
    let quietUntil = 0;
    // A jump takes time to load (a server converting the movie starts over at the new spot),
    // and the room keeps going meanwhile: jumping to where the room IS lands behind again, and
    // again, forever ("loading" until someone pauses). So time each jump, and once one has
    // landed behind, jump to where the room WILL be when it's loaded.
    let jumpedAt = 0;
    let loadMs = 0;
    let chases = 0;
    const line = () => {
      const want = targetMs(cid);
      const cur = io.current.get();
      const st = useWatch.getState().byChannel[cid]?.now;
      if (want === null || !cur || !st || st.item.id !== item.id) return;
      if (!st.playing) {
        // paused: everyone on the same frame
        chases = 0;
        io.current.set(Math.abs(cur.pos - want) > 300 ? want : null, false, 1);
        return;
      }
      if (cur.busy) {
        // loading or buffering: start it (it plays once it has enough), don't judge it
        io.current.set(null, true, 1);
        return;
      }
      if (jumpedAt) {
        loadMs = Math.min(20000, Date.now() - jumpedAt);
        jumpedAt = 0;
      }
      stuck = !cur.paused && Math.abs(cur.pos - last) < 100 ? stuck + 1 : 0;
      last = cur.pos;
      const off = cur.pos - want; // ahead > 0, behind < 0
      const t = Date.now();
      if (Math.abs(off) < 1500) chases = 0;
      if ((Math.abs(off) > 5000 || stuck >= 2 || cur.paused) && t >= quietUntil) {
        const jump = Math.abs(off) > 1000 || stuck >= 2;
        // behind after a jump already: aim ahead by how long the last one took to load
        const lead = jump && off < 0 && chases > 0 ? loadMs + 1000 : 0;
        io.current.set(jump ? want + lead : null, true, 1);
        if (jump) {
          jumpedAt = t;
          if (off < 0) chases++;
        }
        stuck = 0;
        quietUntil = t + 8000; // give it time to settle after a jump
      } else if (Math.abs(off) > 400) {
        io.current.set(null, true, off > 0 ? 0.95 : 1.05);
      } else {
        io.current.set(null, true, 1);
      }
    };
    lineRef.current = () => {
      // ready after loading: judge now, but not straight after our own jump (that's line()'s
      // timing to measure; jumping again at once is what made it chase forever)
      if (!jumpedAt) quietUntil = 0;
      line();
    };
    line();
    const iv = setInterval(line, 2000);
    return () => clearInterval(iv);
  }, [cid, item.id, now?.playing, now?.pos_ms, now?.at_ms]);
  return () => lineRef.current();
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
  /** what the file is and how it's being sent (Jellyfin), for Stream info */
  info?: { file?: string; codec?: string; width?: number; height?: number; bitrate?: number; container?: string; plan?: string };
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

/** Can this device play HEVC (H.265) video itself? (Most 4K files are HEVC.) */
function canHevc(): boolean {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"');
  } catch {
    return false;
  }
}

async function resolveSource(item: WatchItem): Promise<Source> {
  if (item.kind === "url") return { src: item.src, subs: [] };
  if (item.kind === "library") {
    const lib = await libraryList().catch(() => ({ movies: [] }));
    const m = (lib.movies || []).find((x: any) => x.file_id === item.src);
    const subs = m?.subs_file_id ? [{ url: await vttBlob(`/api/files/${m.subs_file_id}`).catch(() => ""), label: "Subtitles" }].filter((x) => x.url) : [];
    return { src: media(`/api/files/${item.src}`), subs };
  }
  // Jellyfin (telling it whether this device plays HEVC itself, so 4K isn't converted)
  const s = await api(`/api/watch/jellyfin/${item.src}/session${canHevc() ? "?hevc=1" : ""}`, { method: "POST" });
  const hls = session.server + s.hls;
  const subs = [];
  for (const t of s.subs || []) {
    const url = await vttBlob(`/api/watch/jellyfin/${item.src}/subs/${t.index}?source=${encodeURIComponent(s.media_source_id)}`).catch(() => "");
    if (url) subs.push({ url, label: t.label, lang: t.lang || undefined, on: !!t.default });
  }
  return s.direct ? { src: media(`/api/watch/jellyfin/${item.src}/stream?source=${encodeURIComponent(s.media_source_id)}`), fallback: hls, subs, info: s.info } : { src: hls, subs, info: s.info };
}

/** A link, a library movie or a Jellyfin item: one video element (HLS through hls.js where
 * needed), lined up with the room, with subtitles (CC) when there are any. */
function FilePlayer({ cid, item, vol }: { cid: string; item: WatchItem; vol: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [useFallback, setUseFallback] = useState(false);
  const [cc, setCc] = useState(() => localStorage.getItem("llamble.cc") === "1");
  const [showInfo, setShowInfo] = useState(false);
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
  const lineUp = useSync(
    cid,
    item,
    () => {
      const el = ref.current;
      if (!el || !src || el.readyState === 0) return null;
      // loading, seeking or out of data: not judged
      return { pos: el.currentTime * 1000, paused: el.paused, busy: el.seeking || el.readyState < 3 };
    },
    (pos, play, rate = 1) => {
      const el = ref.current;
      if (!el) return;
      if (pos !== null) el.currentTime = pos / 1000;
      if (el.playbackRate !== rate) el.playbackRate = rate;
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
          // ready: go to the room's spot and play now, not at the next check
          lineUp();
        }}
        onCanPlay={() => lineUp()}
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
      {source && (
        <button className={"watch-info-btn" + (showInfo ? " on" : "")} title="Stream info" onClick={() => setShowInfo(!showInfo)}>
          i
        </button>
      )}
      {showInfo && source && <StreamInfo video={ref} source={source} converted={useFallback || !!source.info && source.info.plan !== "direct" && /\.m3u8/i.test(src)} />}
      {!source && !problem && <div className="watch-problem">Loading…</div>}
      {problem && <div className="watch-problem">{problem}</div>}
    </>
  );
}

/** How this video is reaching you: the file, how it's sent, and the picture actually playing. */
function StreamInfo({ video, source, converted }: { video: React.RefObject<HTMLVideoElement | null>; source: Source; converted: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const el = video.current;
  const i = source.info;
  const mbps = (b?: number) => (b ? (b / 1e6).toFixed(1) + " Mbps" : "");
  const plan = !i
    ? "The file as it is"
    : i.plan === "direct" && !converted
      ? "The file as it is (full quality)"
      : i.plan === "convert"
        ? "Converted by Jellyfin to 1080p H.264"
        : "Passed through by Jellyfin (full quality)";
  let dropped = "";
  try {
    const q = el?.getVideoPlaybackQuality?.();
    if (q && q.totalVideoFrames) dropped = `${q.droppedVideoFrames} of ${q.totalVideoFrames}`;
  } catch {}
  return (
    <div className="watch-info">
      {i?.file && (
        <div>
          <b>File:</b> {i.file}
          {i.width && i.height ? ` · ${i.width}×${i.height}` : ""} {mbps(i.bitrate) && "· " + mbps(i.bitrate)}
        </div>
      )}
      <div>
        <b>Sent as:</b> {plan}
      </div>
      <div>
        <b>Playing:</b> {el && el.videoWidth ? `${el.videoWidth}×${el.videoHeight}` : "not started"}
      </div>
      {dropped && (
        <div>
          <b>Dropped frames:</b> {dropped}
        </div>
      )}
    </div>
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
            onError: (e: any) =>
              setProblem(
                e.data === 101 || e.data === 150
                  ? "This video's owner doesn't allow it to be played outside YouTube."
                  : e.data === 152 || e.data === 153
                    ? "YouTube wouldn't load its player here (error " + e.data + ")."
                    : e.data === 100
                      ? "That YouTube video is private or was removed."
                      : "YouTube couldn't play this video.",
              ),
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
      const state = p.getPlayerState();
      // 3: buffering (not judged)
      return { pos: p.getCurrentTime() * 1000, paused: state !== 1 && state !== 3, busy: state === 3 };
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
  // a show (its episodes) or a collection (its movies) that's open
  const [series, setSeries] = useState<{ id: string; title: string; kind: string } | null>(null);
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
        api(`/api/watch/jellyfin/items?${series ? `${series.kind === "collection" ? "collection" : "series"}=${series.id}` : `q=${encodeURIComponent(q.trim())}`}`)
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
              <button key={it.id} className="poster" onClick={() => (it.kind === "series" || it.kind === "collection" ? setSeries({ id: it.id, title: it.title, kind: it.kind }) : onPick("jellyfin", it.id))} title={it.title}>
                {it.has_poster ? <img src={media(`/api/watch/jellyfin/${it.id}/poster`)} alt="" loading="lazy" /> : <span className="poster-blank">🎬</span>}
                <span className="poster-title">{it.title}</span>
                <span className="muted small">{it.kind === "series" ? "Show ›" : it.kind === "collection" ? "Collection ›" : it.year || ""}</span>
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

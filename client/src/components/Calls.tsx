// The phone-style call screens (calls.ts): a full-screen "X is calling" with Accept / Decline
// for the person being rung; the dialer-style call screen (who, the timer, mute, where the
// sound comes out, video, add people, hang up); and a small bar when it's minimized.
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { startCall, addToCall, acceptCall, cancelCall, declineCall, hangUp, showCallScreen, useCalls } from "../calls";
import { canPickRoute, currentKind, refreshRoutes, routeIcon, routeLabel, setRoute, useRoutes } from "../audioroute";
import { currentChannelId, homeOf, selectChannel, useStore } from "../store";
import type { Channel } from "../types";
import { sounds } from "../sounds";
import { toast } from "../ui";
import { canShareScreen, defaultShareQuality, flipCamera, participants, getRoom, startScreenShare, stopScreenShare, toggleCamera, toggleMute, useVoice } from "../voice";
import { androidSend, isAndroidApp } from "../android";
import { openModal } from "../ui";
import { Track } from "livekit-client";
import { Tile, type TileSpec } from "./VoiceView";
import { VoicemailRecorder } from "./VoiceMessage";
import type { VmTarget } from "../voicemsg";
import { Avatar, Icon } from "./common";

export function CallScreens() {
  const incoming = useCalls((s) => s.incoming);
  const outgoing = useCalls((s) => s.outgoing);
  const view = useCalls((s) => s.view);
  const callId = useVoice((s) => s.channelId);
  const kind = useStore((s) => (callId ? s.channels[callId]?.kind : undefined));
  const guestOf = useCalls((s) => s.guestOf);
  // the call screen is for DM and party calls (and calls we were added to), not server voice rooms
  const isCall = !!callId && (kind === "dm" || kind === "party" || guestOf === callId);
  return (
    <>
      {incoming && <IncomingCall />}
      {!incoming && view && (isCall || outgoing) && <CallScreen />}
      {!incoming && !callId && <NoAnswer />}
      {!incoming && !callId && <KeepPartyPrompt />}
    </>
  );
}

function IncomingCall() {
  const c = useCalls((s) => s.incoming)!;
  const from = useStore((s) => s.users[c.from]);
  return (
    <div className={"call-screen" + (c.urgent ? " urgent" : "")} role="dialog" aria-label={c.urgent ? "Urgent incoming call" : "Incoming call"}>
      <div className="call-card">
        {c.urgent && <div className="call-urgent">URGENT CALL</div>}
        <div className="call-pulse">
          <Avatar user={from} size={112} />
        </div>
        <div className="call-name">{from?.display_name ?? c.name ?? "Someone"}</div>
        <div className="muted">{c.guest && c.with?.length ? `wants to add you to a call${c.party ? ` in ${c.party}` : ""}` : c.party ? `is calling ${c.party}` : "is calling you"}</div>
        <div className="call-actions">
          <button className="call-btn decline" onClick={declineCall} aria-label="Decline">
            <Icon name="phone-off" size={28} />
            <span>Decline</span>
          </button>
          <button className="call-btn accept" onClick={acceptCall} aria-label="Accept">
            <Icon name="phone" size={28} />
            <span>Accept</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const isPhoneUA = /Android|iPhone|iPad/.test(navigator.userAgent);

export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + String(sec).padStart(2, "0");
}

/** The dialer-style screen while calling or in a call. */
function CallScreen() {
  const outgoing = useCalls((s) => s.outgoing);
  const since = useCalls((s) => s.since);
  const guestOf = useCalls((s) => s.guestOf);
  const v = useVoice();
  const cid = v.channelId ?? outgoing?.channel_id ?? null;
  const me = useStore((s) => s.me?.id);
  const ch = useStore((s) => (cid ? s.channels[cid] : undefined));
  const users = useStore((s) => s.users);
  const inCall = useStore(useShallow((s) => Object.values(s.voiceStates).filter((x) => x.channel_id === cid && x.user_id !== me).map((x) => x.user_id)));
  const [, tickNow] = useState(0);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => tickNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    refreshRoutes();
  }, [v.status]);
  // who's shown: people in the call, else who we're ringing
  const ringing = (ch?.recipients ?? []).filter((u) => u.id !== me).map((u) => u.id);
  const shown = inCall.length ? inCall : ringing;
  const names = shown.map((id) => users[id]?.display_name ?? ch?.recipients?.find((r) => r.id === id)?.display_name ?? "Someone");
  const title = ch?.kind === "party" ? ch.name : names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(" & ") || "Call";
  const status = outgoing && !inCall.length ? "Calling…" : v.status === "connecting" ? "Connecting…" : v.status === "reconnecting" ? "Reconnecting…" : since ? clock(Date.now() - since) : inCall.length ? "" : "Waiting for others…";
  const routes = useRoutes();
  const curKind = currentKind(routes);
  const cur = routes.routes.find((r) => r.id === routes.current) ?? routes.routes.find((r) => r.kind === curKind);
  const speaker = routes.routes.find((r) => r.kind === "speaker");
  const bt = routes.routes.find((r) => r.kind === "bluetooth");
  const ear = routes.routes.find((r) => r.kind === "headset") ?? routes.routes.find((r) => r.kind === "earpiece");
  const video = useVideoTiles();
  // with MY camera on, sound never comes out of the earpiece: speaker (or Bluetooth / a headset).
  // Someone else's camera doesn't move my sound (no blasting an ear): I get a chime and a note.
  const headset = routes.routes.find((r) => r.kind === "headset");
  const offSpeaker = v.camera ? (bt ?? headset) : (bt ?? ear);
  useEffect(() => {
    if (isAndroidApp && v.camera && cur?.kind === "earpiece") {
      const to = bt ?? headset ?? speaker;
      if (to) setRoute(to.id);
    }
  }, [v.camera, cur?.kind, bt?.id, headset?.id, speaker?.id]);
  const theirCams = video.tiles.filter((t) => t.participant.identity !== getRoom()?.localParticipant.identity && t.source === Track.Source.Camera && t.participant.getTrackPublication(t.source) && !t.participant.getTrackPublication(t.source)!.isMuted).map((t) => t.participant.identity);
  const prevCams = useRef<string[]>([]);
  useEffect(() => {
    const fresh = theirCams.filter((id) => !prevCams.current.includes(id));
    prevCams.current = theirCams;
    if (!fresh.length) return;
    sounds.videoOn();
    const who = users[fresh[0]]?.display_name ?? "Someone";
    toast(cur?.kind === "earpiece" ? `${who} turned on their camera. Tap Speaker to see them.` : `${who} turned on their camera.`);
  }, [theirCams.join(",")]);
  const back = () => {
    showCallScreen(false);
    if (ch && !guestOf) selectChannel(homeOf(ch), ch.id);
  };
  // the phone's ear sensor may blank the screen only while this screen is up
  useEffect(() => {
    androidSend("call-screen", { on: true });
    return () => androidSend("call-screen", { on: false });
  }, []);
  // video: full screen, controls fade after a few seconds; tap the video to bring them back
  const [controls, setControls] = useState(true);
  const [poke, setPoke] = useState(0);
  useEffect(() => {
    if (!video.any || !controls || adding || routesOpen) return;
    const t = setTimeout(() => setControls(false), 4000);
    return () => clearTimeout(t);
  }, [video.any, controls, poke, adding, routesOpen]);
  return (
    <div
      className={"call-screen dial" + (video.any ? " video" : "") + (video.any && !controls ? " bare" : "")}
      role="dialog"
      aria-label="Call"
      onPointerDown={() => controls && setPoke((n) => n + 1)}
    >
      {video.any && <CallStage tiles={video.tiles} onTapMain={() => setControls((c) => !c)} />}
      <button className="dial-back" title={guestOf ? "Minimize the call" : "Back to the chat (the call keeps going)"} onClick={back}>
        <Icon name="chevron" size={20} /> {guestOf ? "Minimize" : "Chat"}
      </button>
      <div className="call-card">
        {!video.any && <div className={"dial-faces" + (outgoing && !inCall.length ? " call-pulse-wrap" : "")}>
          {shown.slice(0, 4).map((id) => (
            <span key={id} className={"dial-face" + (v.speaking.includes(id) ? " speaking" : "")}>
              <Avatar user={users[id] ?? ch?.recipients?.find((r) => r.id === id)} size={shown.length > 1 ? 84 : 120} />
            </span>
          ))}
        </div>}
        <div className="call-name">{title}</div>
        <div className="muted dial-status">{status}</div>
        <div className="dial-grid">
          <button className={"dial-btn" + (v.muted ? " on" : "")} onClick={toggleMute} disabled={!v.canSpeak}>
            <Icon name={v.muted ? "micOff" : "mic"} size={26} />
            <span>{v.muted ? "Unmute" : "Mute"}</span>
          </button>
          {isAndroidApp && speaker && (
            // Speaker: on or off, lit when on (off = Bluetooth / headset / the phone at your ear)
            <button className={"dial-btn" + (cur?.kind === "speaker" ? " on" : "")} onClick={() => setRoute(cur?.kind === "speaker" ? (offSpeaker?.id ?? speaker.id) : speaker.id)} title={v.camera && !offSpeaker ? "With your camera on, sound stays on the speaker" : undefined}>
              <Icon name="speaker" size={26} />
              <span>Speaker</span>
            </button>
          )}
          {isAndroidApp && bt && (
            <button className={"dial-btn" + (cur?.kind === "bluetooth" ? " on" : "")} onClick={() => setRoute(cur?.kind === "bluetooth" ? ((v.camera ? speaker?.id : ear?.id) ?? speaker?.id ?? bt.id) : bt.id)}>
              <Icon name="bluetooth" size={26} />
              <span className="ellipsis">{bt.name || "Bluetooth"}</span>
            </button>
          )}
          {!isAndroidApp && canPickRoute() && routes.routes.length > 1 && (
            <div className="dial-route">
              <button className={"dial-btn" + (routesOpen ? " on" : "")} onClick={() => setRoutesOpen(!routesOpen)}>
                <Icon name="headphones" size={26} />
                <span>Output</span>
              </button>
              {routesOpen && (
                <div className="dial-sheet-back" onClick={() => setRoutesOpen(false)}>
                  <div className="dial-sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="dial-sheet-title">Sound comes out of</div>
                    {routes.routes.map((r) => (
                      <button key={r.id} className={"dial-menu-item" + (r.id === routes.current ? " on" : "")} onClick={() => { setRoute(r.id); setRoutesOpen(false); }}>
                        <Icon name={routeIcon(r.kind)} size={22} /> <span className="ellipsis">{routeLabel(r)}</span>
                        {r.id === routes.current && <Icon name="check" size={20} />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <button className={"dial-btn" + (v.camera ? " on" : "")} onClick={toggleCamera} disabled={!v.canVideo || !v.channelId}>
            <Icon name={v.camera ? "video" : "videoOff"} size={26} />
            <span>Video</span>
          </button>
          {isPhoneUA && v.camera && (
            <button className="dial-btn" onClick={() => flipCamera()}>
              <Icon name="flip" size={26} />
              <span>Flip</span>
            </button>
          )}
          {(v.screen || canShareScreen()) && (
            <button
              className={"dial-btn" + (v.screen ? " on" : "")}
              disabled={!v.canVideo || v.status !== "connected"}
              onClick={() => (v.screen ? stopScreenShare() : window.llambleNative ? openModal({ kind: "screenPicker" }) : startScreenShare("", true, defaultShareQuality()))}
            >
              <Icon name="screen" size={26} />
              <span>{v.screen ? "Stop sharing" : "Share"}</span>
            </button>
          )}
          <button className={"dial-btn" + (adding ? " on" : "")} onClick={() => setAdding(!adding)} disabled={!v.channelId || v.status !== "connected"}>
            <Icon name="userPlus" size={26} />
            <span>Add</span>
          </button>
        </div>
        {ch?.kind === "party" && ch.unsaved && v.status === "connected" && (
          <button className="btn small dial-save" onClick={() => setSaving(true)}>
            <Icon name="users" size={16} /> Keep this party
          </button>
        )}
        {saving && ch && (
          <div className="dial-sheet-back" onClick={() => setSaving(false)}>
            <div className="dial-sheet" onClick={(e) => e.stopPropagation()}>
              <KeepParty channel={ch} during onDone={() => setSaving(false)} />
            </div>
          </div>
        )}
        {adding && cid && (
          <div className="dial-sheet-back" onClick={() => setAdding(false)}>
            <div className="dial-sheet tall" onClick={(e) => e.stopPropagation()}>
              <AddPeople cid={cid} exclude={[...inCall, ...ringing]} onDone={() => setAdding(false)} />
            </div>
          </div>
        )}
        <button className="dial-hang" onClick={hangUp} aria-label="Hang up" title="Hang up">
          <Icon name="phone-off" size={30} />
        </button>
      </div>
    </div>
  );
}

/** Pick friends to add to the call. */
function AddPeople({ cid, exclude, onDone }: { cid: string; exclude: string[]; onDone: () => void }) {
  const friends = useStore((s) => s.friends);
  const presences = useStore((s) => s.presences);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string[]>([]);
  const list = Object.values(friends)
    .filter((f) => f.state === "friend" && !exclude.includes(f.user.id) && !f.user.is_bot)
    .filter((f) => !q || (f.user.display_name + " " + f.user.username).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number((presences[b.user.id] ?? "offline") !== "offline") - Number((presences[a.user.id] ?? "offline") !== "offline") || a.user.display_name.localeCompare(b.user.display_name));
  return (
    <div className="dial-add">
      <div className="dial-sheet-title">Add people: everyone on this call plus who you pick become a new party, with its own chat. Tap people, then Call.</div>
      {Object.keys(friends).length > 8 && <input placeholder="Search friends" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="dial-add-list">
        {list.length === 0 && <div className="muted small">{Object.keys(friends).length ? "No one else to add." : "Add friends first, then you can bring them into calls."}</div>}
        {list.map((f) => {
          const on = pick.includes(f.user.id);
          return (
            <button key={f.user.id} className={"dial-add-row" + (on ? " on" : "")} onClick={() => setPick(on ? pick.filter((x) => x !== f.user.id) : [...pick, f.user.id])}>
              <Avatar user={f.user} size={40} status />
              <span className="ellipsis">{f.user.display_name}</span>
              <span className="grow" />
              {on && <Icon name="check" size={18} />}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn small" onClick={onDone}>
          Cancel
        </button>
        <button className="btn small primary" disabled={!pick.length} onClick={() => { addToCall(cid, pick); onDone(); }}>
          Call {pick.length ? pick.length : ""}
        </button>
      </div>
    </div>
  );
}

/** Everyone's camera and screen tiles in the call; `any` when someone's actually sending video. */
function useVideoTiles(): { any: boolean; tiles: TileSpec[] } {
  useVoice((s) => s.version);
  const tiles: TileSpec[] = [];
  let any = false;
  for (const p of participants()) {
    const screen = p.getTrackPublication(Track.Source.ScreenShare);
    if (screen && !screen.isMuted) {
      any = true;
      tiles.push({ key: p.identity + ":screen", participant: p, source: Track.Source.ScreenShare });
    }
    const cam = p.getTrackPublication(Track.Source.Camera);
    if (cam && !cam.isMuted) any = true;
    tiles.push({ key: p.identity + ":cam", participant: p, source: Track.Source.Camera });
  }
  return { any, tiles };
}

/**
 * Video calls: one video fills the whole screen. With several (cameras, screen shares) there are
 * two ways to pick what's big, switched at the top:
 * - Auto: a screen share is big, switching to whoever's talking (camera on) while they talk;
 *   with no share it follows the talker.
 * - Locked: stays on one. Tapping a small window locks onto it.
 * Everything else floats in small windows that stay where you drag them.
 */
function CallStage({ tiles, onTapMain }: { tiles: TileSpec[]; onTapMain: () => void }) {
  const me = getRoom()?.localParticipant.identity;
  const speaking = useVoice((s) => s.speaking);
  const [locked, setLocked] = useState<string | null>(null);
  const [talker, setTalker] = useState<string | null>(null);
  const hasVideo = (t: TileSpec) => {
    const pub = t.participant.getTrackPublication(t.source);
    return !!pub && !pub.isMuted;
  };
  const others = tiles.filter((t) => t.participant.identity !== me);
  const mine = tiles.filter((t) => t.participant.identity === me);
  const share = others.find((t) => t.source === Track.Source.ScreenShare && hasVideo(t));
  const camOf = (id: string | null) => (id ? others.find((t) => t.participant.identity === id && t.source === Track.Source.Camera && hasVideo(t)) : undefined);
  // who's talking: switch to them after 1.5 s of talking (instantly if nobody's shown yet),
  // back after 3 s of quiet, so short "mm-hm"s don't flick the screen around
  const now = speaking.find((id) => id !== me && camOf(id)) ?? null;
  useEffect(() => {
    if (now === talker) return;
    const t = setTimeout(() => setTalker(now), now ? (talker ? 1500 : 0) : 3000);
    return () => clearTimeout(t);
  }, [now, talker]);
  const sources = tiles.filter(hasVideo);
  const lock = locked && sources.some((t) => t.key === locked) ? locked : null;
  const auto = camOf(talker) ?? share ?? others.find(hasVideo) ?? others[0] ?? mine[0];
  const main = tiles.find((t) => t.key === lock) ?? auto;
  const floating = tiles.filter((t) => t !== main && (hasVideo(t) || (t.source === Track.Source.Camera && t.participant.identity !== me)));
  const name = (t: TileSpec) => (t.participant.identity === me ? "You" : useStore.getState().users[t.participant.identity]?.display_name ?? "Someone") + (t.source === Track.Source.ScreenShare ? "'s screen" : "");
  return (
    <div className="dial-stage">
      {main && (
        <div className="dial-main">
          <Tile spec={main} guildId={null} big bare onClick={onTapMain} />
        </div>
      )}
      {sources.length > 1 && main && (
        <div className="dial-mode">
          <div className="dial-seg">
            <button className={!lock ? "on" : ""} onClick={() => setLocked(null)}>
              Auto
            </button>
            <button className={lock ? "on" : ""} onClick={() => setLocked(main.key)}>
              🔒 Locked
            </button>
          </div>
          <div className="dial-showing ellipsis">{lock ? `Locked on ${name(main)}` : `Showing ${name(main)}`}</div>
        </div>
      )}
      {floating.map((t) => (
        <Floating key={t.key} id={t.key} self={t.participant.identity === me} onTap={() => setLocked(t.key)}>
          <Tile spec={t} guildId={null} bare onClick={() => {}} />
        </Floating>
      ))}
    </div>
  );
}

// where each small window was dragged to (kept while the call lasts)
const floatPos = new Map<string, { x: number; y: number }>();
let floatNext = 0;

/** A small video window you can drag anywhere; a tap (no drag) taps it. Stays where you put it. */
function Floating({ id, self, onTap, children }: { id: string; self: boolean; onTap: () => void; children: React.ReactNode }) {
  const W = 110, H = 150;
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const saved = floatPos.get(id);
    if (saved) return saved;
    const p = self ? { x: window.innerWidth - W - 12, y: window.innerHeight - H - 250 } : { x: 12, y: 90 + (floatNext++ % 4) * (H + 10) };
    floatPos.set(id, p);
    return p;
  });
  const drag = useRef<{ dx: number; dy: number; moved: boolean; id: number } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const clamp = (x: number, y: number) => ({ x: Math.max(4, Math.min(window.innerWidth - W - 4, x)), y: Math.max(34, Math.min(window.innerHeight - H - 4, y)) });
  return (
    <div
      ref={el}
      className="dial-float"
      style={{ left: pos.x, top: pos.y, width: W, height: H }}
      onPointerDown={(e) => {
        e.stopPropagation();
        drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: false, id: e.pointerId };
        el.current?.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const nx = e.clientX - d.dx, ny = e.clientY - d.dy;
        if (!d.moved && Math.hypot(nx - pos.x, ny - pos.y) < 8) return;
        d.moved = true;
        const p = clamp(nx, ny);
        floatPos.set(id, p);
        setPos(p);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) onTap();
      }}
      onPointerCancel={() => (drag.current = null)}
    >
      {children}
    </div>
  );
}

/** "3:12" since the call started, ticking. */
export function CallTimer() {
  const since = useCalls((s) => s.since);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{since ? clock(Date.now() - since) : ""}</>;
}

/** While you're elsewhere in the app during a call: a green pill to get back to it. */
/** While you're in a call and not looking at the call screen: a strip right under the title
 *  bar, on every screen, that takes space in the page (it never covers what's under it).
 *  Tap it to go back to the call. */
export function CallStrip() {
  const incoming = useCalls((s) => s.incoming);
  const outgoing = useCalls((s) => s.outgoing);
  const view = useCalls((s) => s.view);
  const guestOf = useCalls((s) => s.guestOf);
  const cid = useVoice((s) => s.channelId);
  const status = useVoice((s) => s.status);
  const me = useStore((s) => s.me?.id);
  const ch = useStore((s) => (cid ? s.channels[cid] : undefined));
  const channels = useStore((s) => s.channels);
  const isCall = !!cid && (ch?.kind === "dm" || ch?.kind === "party" || guestOf === cid);
  // calling someone (still ringing) or in a call, with the call screen put away
  const show = (isCall || !!outgoing) && !view && !incoming;
  useEffect(() => {
    document.documentElement.style.setProperty("--callbar", show ? "40px" : "0px");
    return () => document.documentElement.style.setProperty("--callbar", "0px");
  }, [show]);
  if (!show) return null;
  const c = outgoing ? channels[outgoing.channel_id] : ch;
  const who = c?.kind === "party" ? c.name : c?.recipients?.find((r) => r.id !== me)?.display_name ?? "a call";
  const label = outgoing ? `Calling ${who}…` : status === "connected" ? `In a call with ${who}` : `Connecting to ${who}…`;
  return (
    <div className="call-strip">
      <button className="call-strip-main" onClick={() => showCallScreen()} title="Back to the call screen">
        <Icon name="phone" size={16} />
        <span className="ellipsis">{label}</span>
        {!outgoing && (
          <b>
            <CallTimer />
          </b>
        )}
        <span className="call-strip-go">Return to call</span>
      </button>
      <button className="call-strip-end" onClick={() => hangUp()} title={outgoing ? "Cancel the call" : "Hang up"} aria-label="Hang up">
        <Icon name="phone-off" size={16} />
      </button>
    </div>
  );
}

/** Keep the people in this call as a party: its own chat, and one tap calls them all. */
/** A call's party (made by adding someone) that nobody has kept yet: keep it, with its name
 *  (already filled in with everyone's names), or delete it. Asked when its call ends; during
 *  the call from "Keep this party". Writing anything in its chat keeps it by itself. */
function KeepParty({ channel, during, onDone }: { channel: Channel; during?: boolean; onDone: () => void }) {
  const me = useStore((s) => s.me?.id);
  const [name, setName] = useState(channel.name);
  const [busy, setBusy] = useState(false);
  const keep = async () => {
    setBusy(true);
    try {
      const p = await api(`/api/parties/${channel.id}/keep`, { method: "POST", body: { name: name.trim() || channel.name } });
      toast(`Kept as a party: ${p.name}. Call everyone again from Talk → Parties.`);
      onDone();
    } catch (e: any) {
      toast(e.message, "error");
      setBusy(false);
    }
  };
  const drop = async () => {
    setBusy(true);
    try {
      await api(`/api/parties/${channel.id}/members/${me}`, { method: "DELETE" });
      onDone();
    } catch (e: any) {
      toast(e.message, "error");
      setBusy(false);
    }
  };
  return (
    <div className="dial-add">
      <div className="dial-sheet-title">
        {during ? "Keep this party?" : "The call's over. Keep it as a party?"} It has its own chat, and one tap calls everyone again.
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Party name" maxLength={60} />
      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
        {during ? (
          <button className="btn small" onClick={onDone}>
            Not now
          </button>
        ) : (
          <button className="btn small danger" disabled={busy} onClick={drop}>
            Delete it
          </button>
        )}
        <button className="btn small primary" disabled={busy} onClick={keep}>
          Keep party
        </button>
      </div>
    </div>
  );
}

/** Asked when a call's party (not kept yet) ends. */
function KeepPartyPrompt() {
  const id = useCalls((s) => s.keepParty);
  const ch = useStore((s) => (id ? s.channels[id] : undefined));
  if (!id || !ch || !ch.unsaved) return null;
  const done = () => useCalls.setState({ keepParty: null });
  return (
    <div className="dial-sheet-back" onClick={done}>
      <div className="dial-sheet" onClick={(e) => e.stopPropagation()}>
        <KeepParty channel={ch} onDone={done} />
      </div>
    </div>
  );
}

/** Nobody answered: leave a voicemail (everyone you rang gets it), urgent if need be. */
function NoAnswer() {
  const na = useCalls((s) => s.noAnswer);
  const ms = useCalls((s) => s.missedSome);
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me?.id);
  const [recording, setRecording] = useState<VmTarget[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ch = na ? channels[na.channel_id] : ms ? channels[ms.channel_id] : undefined;
  // like a phone: nobody picked up, so it goes straight to their voicemail (greeting said out
  // loud, then the tone); "Don't send" backs out
  useEffect(() => {
    if (na && ch && !recording) setRecording([{ channelId: ch.id, name: ch.kind === "party" ? `Everyone in ${ch.name}` : nameOfIn(ch) }]);
  }, [na?.channel_id]);
  if (!(na || ms) || !ch) return null;
  const close = () => (setRecording(null), useCalls.setState({ noAnswer: null, missedSome: null }));
  function nameOfIn(c: typeof ch) {
    const other = c?.recipients?.find((r) => r.id !== me);
    return (other && (users[other.id]?.display_name ?? other.display_name)) || "Someone";
  }
  const nameOf = (id: string) => users[id]?.display_name ?? ch.recipients?.find((r) => r.id === id)?.display_name ?? "Someone";
  // nobody answered: one voicemail into that chat. Some didn't: one to each of them privately.
  const missing = ms ? ms.users : null;
  const title = missing
    ? `${missing.map(nameOf).join(", ")} never answered`
    : na!.reason === "declined"
      ? `${ch.kind === "party" ? ch.name : nameOf(ch.recipients!.find((r) => r.id !== me)!.id)} can't talk right now`
      : `${ch.kind === "party" ? "Nobody in " + ch.name : nameOf(ch.recipients!.find((r) => r.id !== me)!.id)} answered`.replace(/ answered$/, ch.kind === "party" ? " answered" : " didn't answer");
  const start = async () => {
    if (!missing) {
      setRecording([{ channelId: ch.id, name: ch.kind === "party" ? `Everyone in ${ch.name}` : nameOf(ch.recipients!.find((r) => r.id !== me)!.id) }]);
      return;
    }
    setBusy(true);
    try {
      const t: VmTarget[] = [];
      for (const id of missing) {
        const dm = await api("/api/users/@me/channels", { body: { recipient_id: id } });
        t.push({ channelId: dm.id, name: nameOf(id) });
      }
      setRecording(t);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dial-sheet-back" onClick={() => !recording && close()}>
      <div className="dial-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="noanswer-title">{title}</div>
        {recording ? (
          <VoicemailRecorder targets={recording} about={missing && ch.kind === "party" ? `from the ${ch.name} call` : undefined} canUrgent onDone={close} />
        ) : (
          <div className="noanswer-actions">
            <button className="btn primary" disabled={busy} onClick={start}>
              <Icon name="mic" size={18} /> {missing ? `Leave ${missing.length === 1 ? nameOf(missing[0]) : "them"} a voicemail` : ch.kind === "party" ? "Leave everyone a voicemail" : "Leave a voicemail"}
            </button>
            {!missing && (
              <button className="btn" onClick={() => (close(), startCall(ch.id))}>
                <Icon name="phone" size={18} /> Call again
              </button>
            )}
            <button className="btn" onClick={close}>
              {missing ? "No thanks" : "Close"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

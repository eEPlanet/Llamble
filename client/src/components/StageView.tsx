// A show space ("stage"; see server api/stage.rs and ../stage.ts). Chat on the side, open by
// default. Off air: the next scheduled shows (Interested), and for the crew Go backstage /
// Go live / Schedule. Live: the stage drawn the way the director chose (main shot + faces,
// one person or screen, or everyone), the people on stage as round faces (a green ring on
// whoever talks), the audience below, and the controls for who you are: the audience raise a
// hand; people on stage get their mic, camera and screen; the host directs and runs hands.
import { useEffect, useRef, useState } from "react";
import { Track, type Participant } from "livekit-client";
import { Compositor, type Show, type ShowState } from "../show";
import { api } from "../api";
import { memberName, useStore } from "../store";
import type { Channel } from "../types";
import { openMenu, openModal, toast } from "../ui";
import { canShareScreen, defaultShareQuality, joinVoice, leaveVoice, participants, startScreenShare, stopScreenShare, toggleCamera, toggleMute, useVoice } from "../voice";
import { loadStage, useStages, type Stage } from "../stage";
import { ChatView } from "./ChatView";
import { Avatar, Icon } from "./common";
import { RoomChatButton } from "./VoiceView";
import { useIsPhone } from "../phone";

const post = (cid: string, path: string, body?: any) => api(`/api/channels/${cid}/stage/${path}`, { body: body || {} }).catch((e) => toast(e.message, "error"));

export function StageView({ channel }: { channel: Channel }) {
  const phone = useIsPhone();
  const [chat, setChat] = useState(!phone);
  const stage = useStages((s) => s.stages[channel.id]);
  const tick = useStages((s) => s.stages[channel.id]?.events.map((e) => e.interested).join(",") + "|" + s.stages[channel.id]?.roles.length);
  useEffect(() => {
    loadStage(channel.id).catch(() => {});
  }, [channel.id, tick]);
  return (
    <div className={"room-split stage-split" + (chat ? " chat-open" : "")}>
      <div className="stage-view">
        <StageHeader channel={channel} stage={stage} chat={chat} onChat={() => setChat(!chat)} />
        {stage ? <StageBody channel={channel} stage={stage} /> : <p className="muted" style={{ padding: 20 }}>Loading…</p>}
      </div>
      {chat && (
        <div className="room-chat">
          <ChatView key={channel.id} channel={channel} />
        </div>
      )}
    </div>
  );
}

function since(ms: number | null) {
  if (!ms) return "";
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function StageHeader({ channel, stage, chat, onChat }: { channel: Channel; stage?: Stage; chat: boolean; onChat: () => void }) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const follow = () =>
    api(`/api/channels/${channel.id}/follow`, { method: stage?.following ? "DELETE" : "PUT" })
      .then(() => loadStage(channel.id))
      .then(() => toast(stage?.following ? "Unfollowed" : "Following: you'll hear about new shows and when it goes live"))
      .catch((e) => toast(e.message, "error"));
  return (
    <header className="chat-header">
      <span className="chat-head-emoji">🎙️</span>
      <span className="chat-title ellipsis">{stage?.live ? stage.title : channel.name}</span>
      {stage?.live ? (
        <span className="stage-live" title={"Live for " + since(stage.live_since)}>
          LIVE
        </span>
      ) : (
        <span className="muted small">Off air</span>
      )}
      {stage?.live && <span className="muted small">{stage.in_room} watching</span>}
      <div className="grow" />
      {stage && (
        <button className={"btn small" + (stage.following ? " primary" : "")} onClick={follow} title="Hear about new shows and when this goes live">
          🔔 {stage.following ? "Following" : "Follow"}
        </button>
      )}
      <RoomChatButton channel={channel} open={chat} onClick={onChat} />
    </header>
  );
}

function StageBody({ channel, stage }: { channel: Channel; stage: Stage }) {
  const v = useVoice();
  const inRoom = v.channelId === channel.id && v.status === "connected";
  const me = useStore((s) => s.me)!;
  const myRole = stage.roles.find((r) => r.user_id === me.id)?.role;
  const crew = !!stage.can_run || !!myRole;
  if (!inRoom)
    return (
      <div className="stage-offair">
        {stage.live ? (
          <>
            <div className="stage-big-live">LIVE</div>
            <h2>{stage.title}</h2>
            <p className="muted">Live for {since(stage.live_since)} · {stage.in_room} watching</p>
            <button className="btn green" disabled={v.status === "connecting"} onClick={() => joinVoice(channel.id)}>
              {v.status === "connecting" ? "Connecting…" : "▶ Watch the show"}
            </button>
          </>
        ) : (
          <>
            <Icon name="speaker" size={44} />
            <h2>{channel.name}</h2>
            <p className="muted">{stage.events.length ? "Starting soon. Mark Interested to get a reminder." : "Off air."}</p>
            {crew && (
              <button className="btn" onClick={() => joinVoice(channel.id)}>
                Go backstage
              </button>
            )}
          </>
        )}
        {v.error && <p className="form-error">{v.error}</p>}
        <Schedule channel={channel} stage={stage} />
      </div>
    );
  return <LiveStage channel={channel} stage={stage} />;
}

/** Upcoming shows: Interested for everyone; schedule and cancel for whoever runs it. */
function Schedule({ channel, stage }: { channel: Channel; stage: Stage }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [when, setWhen] = useState("");
  const mine = new Set(stage.my_interested || []);
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const at = new Date(when).getTime();
    if (!title.trim() || !at) return toast("Give it a title and a time", "error");
    api(`/api/channels/${channel.id}/stage/events`, { body: { title, description: desc, starts_at: at } })
      .then(() => (setOpen(false), setTitle(""), setDesc(""), setWhen(""), loadStage(channel.id)))
      .catch((err) => toast(err.message, "error"));
  };
  const interest = (id: string, on: boolean) =>
    api(`/api/stage-events/${id}/interested`, { method: on ? "PUT" : "DELETE" })
      .then(() => loadStage(channel.id))
      .then(() => on && toast("We'll remind you a day before and 15 minutes before"))
      .catch((e) => toast(e.message, "error"));
  if (!stage.events.length && !stage.can_run) return null;
  return (
    <div className="stage-schedule">
      <div className="stage-sched-head">
        <b>Coming up</b>
        {stage.can_run && (
          <button className="btn small" onClick={() => setOpen(!open)}>
            + Schedule a show
          </button>
        )}
      </div>
      {open && (
        <form className="stage-sched-form" onSubmit={add}>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoFocus />
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          <textarea placeholder="What's it about? (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} maxLength={2000} />
          <div className="row-end">
            <button type="button" className="btn link" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn primary">Schedule</button>
          </div>
        </form>
      )}
      {!stage.events.length && <p className="muted small">Nothing scheduled.</p>}
      {stage.events.map((e) => (
        <div key={e.id} className="stage-event">
          <div className="grow">
            <b>{e.title}</b>
            <div className="muted small">
              {new Date(e.starts_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {e.interested} interested
            </div>
            {e.description && <div className="small">{e.description}</div>}
          </div>
          <button className={"btn small" + (mine.has(e.id) ? " primary" : "")} onClick={() => interest(e.id, !mine.has(e.id))}>
            ✋ {mine.has(e.id) ? "Interested" : "I'm interested"}
          </button>
          {stage.can_run && (
            <button className="btn link small danger-text" onClick={() => api(`/api/stage-events/${e.id}`, { method: "DELETE" }).then(() => loadStage(channel.id))}>
              Cancel
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** The people on stage as the director's scene engine sees them: a "show" whose people are
 * everyone on stage (cameras and screens), with the director's settings. */
function stageShow(stage: Stage, onStage: string[]): Show {
  const all = { voice: true, camera: true, screen: true };
  return {
    id: "stage:" + stage.channel_id,
    channel_id: stage.channel_id,
    title: stage.title,
    initiator_id: "",
    recorder_id: "",
    director_id: "",
    recorder_ok: true,
    director_ok: true,
    status: "recording",
    state: (stage.director || {}) as ShowState,
    started_at: stage.live_since,
    ended_at: null,
    size: 0,
    people: onStage.map((u) => ({ user_id: u, wanted: all, consent: all })),
    video_url: null,
  } as Show;
}

/** Who's on stage: hosts and guests, plus anyone sending something (server staff). */
function onStageIds(stage: Stage): string[] {
  return participants()
    .filter((p) => {
      const r = stage.roles.find((x) => x.user_id === p.identity)?.role;
      return r === "host" || r === "guest" || p.trackPublications.size > 0;
    })
    .map((p) => p.identity);
}

/** The stage, painted by the same scene engine as the recording director's preview: the main
 * shot, pop-up windows or everyone's faces or a grid, lower third, title bar, full-screen card. */
function StageCanvas({ stage, className }: { stage: Stage; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(stage);
  latest.current = stage;
  const phone = useIsPhone();
  useEffect(() => {
    const comp = new Compositor(() => stageShow(latest.current, onStageIds(latest.current)), phone ? 960 : 1280, phone ? 540 : 720);
    comp.canvas.className = "stage-canvas";
    box.current?.appendChild(comp.canvas);
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return; // about 30 frames a second
      last = t;
      comp.draw();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      comp.canvas.remove();
      comp.destroy();
    };
  }, [phone]);
  return <div ref={box} className={"stage-canvas-box " + (className || "")} />;
}

function LiveStage({ channel, stage }: { channel: Channel; stage: Stage }) {
  const v = useVoice();
  useVoice((s) => s.version);
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const [title, setTitle] = useState("");
  const [panel, setPanel] = useState<"hands" | null>(null);
  const [directing, setDirecting] = useState(false);
  const roleOf = (uid: string) => stage.roles.find((r) => r.user_id === uid);
  const ps = participants();
  const onIds = onStageIds(stage);
  const onStage = ps.filter((p) => onIds.includes(p.identity));
  const audience = ps.filter((p) => !onIds.includes(p.identity));
  const mine = roleOf(me.id);
  const iAmOn = onIds.includes(me.id);
  const handUp = stage.hands.some((h) => h.user_id === me.id);
  const name = (uid: string) => memberName(channel.guild_id, users[uid]) || "Someone";

  const faceMenu = (e: React.MouseEvent, uid: string) => {
    e.preventDefault();
    const r = roleOf(uid);
    const onNow = onIds.includes(uid);
    const items: any[] = [];
    if (stage.can_run && onNow) {
      items.push({ label: "Put their camera on the main shot", onClick: () => post(channel.id, "director", { focus: uid, hold: true }) });
      if (ps.find((p) => p.identity === uid)?.getTrackPublication(Track.Source.ScreenShare)) items.push({ label: "Put their screen on the main shot", onClick: () => post(channel.id, "director", { focus: "screen:" + uid, hold: true }) });
    }
    if (stage.can_manage && uid !== me.id && r && (r.role === "guest" || r.role === "host")) {
      items.push({ label: r.muted ? "Unmute" : "Mute", onClick: () => post(channel.id, "mute", { user_id: uid, muted: !r.muted }) });
    }
    if (stage.can_manage && r?.role === "guest") items.push({ label: "Send back to the audience", danger: true, onClick: () => post(channel.id, "back", { user_id: uid }) });
    if (stage.can_manage && !onNow && uid !== me.id) items.push({ label: "Bring up on stage", onClick: () => post(channel.id, "bring", { user_id: uid }) });
    if (stage.can_run && uid !== me.id) {
      items.push({ separator: true, label: "" });
      if (r?.role !== "host") items.push({ label: "Make a host", onClick: () => post(channel.id, "role", { user_id: uid, role: "host" }) });
      if (r?.role !== "moderator") items.push({ label: "Make a moderator", onClick: () => post(channel.id, "role", { user_id: uid, role: "moderator" }) });
      if (r && r.role !== "guest") items.push({ label: "Take away their show role", onClick: () => post(channel.id, "role", { user_id: uid, role: "none" }) });
    }
    items.push({ separator: true, label: "" }, { label: "Profile", onClick: () => openModal({ kind: "profile", userId: uid, guildId: channel.guild_id }) });
    openMenu(e, items);
  };

  const face = (p: Participant) => {
    const r = roleOf(p.identity);
    const talking = v.speaking.includes(p.identity);
    return (
      <div key={p.identity} className={"stage-face" + (talking ? " talking" : "")} onClick={(e) => faceMenu(e, p.identity)} onContextMenu={(e) => faceMenu(e, p.identity)} title={name(p.identity)}>
        <Avatar user={users[p.identity]} size={52} />
        <span className="stage-face-name ellipsis">{name(p.identity)}</span>
        {r?.role === "host" && <span className="stage-tag">Host</span>}
        {r?.muted && <span className="stage-muted">🔇</span>}
      </div>
    );
  };

  const share = () => {
    if (v.screen) return stopScreenShare();
    if (window.llambleNative) openModal({ kind: "screenPicker" });
    else startScreenShare("", true, defaultShareQuality()).catch((e) => toast(e.message || "Couldn't share your screen", "error"));
  };

  return (
    <div className="stage-live-body">
      {!stage.live && (
        <div className="stage-backstage">
          <b>Backstage.</b> <span className="muted">The audience can't see or hear you until you go live.</span>
          {stage.can_run && (
            <span className="stage-golive">
              <input placeholder={stage.events[0]?.title || "Show title"} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              <button className="btn green small" onClick={() => post(channel.id, "live", { title })}>
                Go live
              </button>
            </span>
          )}
        </div>
      )}
      <div className="stage-main">{onStage.length ? <StageCanvas stage={stage} /> : <div className="stage-empty muted">Nobody's on stage yet.</div>}</div>
      <div className="stage-faces">{onStage.map(face)}</div>
      {audience.length > 0 && (
        <div className="stage-audience">
          <span className="muted small">Audience</span>
          {audience.slice(0, 40).map((p) => (
            <span key={p.identity} className={"stage-aud" + (stage.hands.some((h) => h.user_id === p.identity) ? " hand" : "")} title={name(p.identity)} onClick={(e) => faceMenu(e, p.identity)} onContextMenu={(e) => faceMenu(e, p.identity)}>
              <Avatar user={users[p.identity]} size={28} />
            </span>
          ))}
          {audience.length > 40 && <span className="muted small">+{audience.length - 40}</span>}
        </div>
      )}

      {panel === "hands" && stage.can_manage && (
        <div className="stage-panel">
          <div className="stage-panel-head">
            <b>Raised hands</b>
            <span className="grow" />
            <button className="btn small" onClick={() => post(channel.id, "hands", { open: !stage.hands_open })}>
              {stage.hands_open ? "Turn hands off" : "Turn hands on"}
            </button>
            {stage.hands.length > 0 && (
              <button className="btn small" onClick={() => post(channel.id, "hands", { lower_all: true })}>
                Lower all
              </button>
            )}
          </div>
          {!stage.hands.length && <p className="muted small">{stage.hands_open ? "No hands up." : "Hands are off."}</p>}
          {stage.hands.map((h, i) => (
            <div key={h.user_id} className="stage-hand-row">
              <span className="muted small">{i + 1}.</span>
              <Avatar user={users[h.user_id]} size={24} />
              <span className="grow">{name(h.user_id)}</span>
              <button className="btn green small" onClick={() => post(channel.id, "bring", { user_id: h.user_id })}>
                Bring up
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="stage-controls">
        {iAmOn ? (
          <>
            <button className={"icon-btn round" + (v.muted || !v.canSpeak ? " off" : "")} title={v.canSpeak ? (v.muted ? "Unmute" : "Mute") : "You're muted by the host"} onClick={() => v.canSpeak && toggleMute()}>
              <Icon name="mic" size={20} />
            </button>
            {v.canVideo && (
              <button className={"icon-btn round" + (v.camera ? " on" : "")} title="Camera" onClick={() => toggleCamera()}>
                <Icon name="video" size={20} />
              </button>
            )}
            {v.canVideo && (v.screen || canShareScreen()) && (
              <button className={"icon-btn round" + (v.screen ? " on" : "")} title={v.screen ? "Stop sharing" : "Share your screen"} onClick={share}>
                <Icon name="screen" size={20} />
              </button>
            )}
            {mine?.role === "guest" && (
              <button className="btn small" onClick={() => post(channel.id, "back", { user_id: me.id })}>
                Step down
              </button>
            )}
          </>
        ) : stage.live ? (
          <button className={"btn small" + (handUp ? " primary" : "")} disabled={!stage.hands_open && !handUp} onClick={() => post(channel.id, "hand", { up: !handUp })} title={stage.hands_open ? "" : "Hands are off right now"}>
            ✋ {handUp ? "Lower hand" : "Raise hand"}
          </button>
        ) : null}
        <span className="grow" />
        {stage.can_manage && (
          <button className={"btn small" + (panel === "hands" ? " primary" : "")} onClick={() => setPanel(panel === "hands" ? null : "hands")}>
            ✋ Hands{stage.hands.length ? ` (${stage.hands.length})` : ""}
          </button>
        )}
        {stage.can_run && (
          <button className="btn small" onClick={() => setDirecting(true)}>
            🎬 Director
          </button>
        )}
        {stage.can_run && stage.live && (
          <button className="btn small danger" onClick={() => post(channel.id, "end")}>
            End show
          </button>
        )}
        <button className="btn small" onClick={() => leaveVoice()}>
          Leave
        </button>
      </div>
      {directing && stage.can_run && <StageDirector channel={channel} stage={stage} onClose={() => setDirecting(false)} />}
    </div>
  );
}

/** The director for a show: the same controls as the recording director, and its preview is
 * exactly what the audience sees. */
function StageDirector({ channel, stage, onClose }: { channel: Channel; stage: Stage; onClose: () => void }) {
  useVoice((s) => s.version);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const st = (stage.director || {}) as ShowState;
  const [lt, setLt] = useState({ text: st.lower_third?.text || "", sub: st.lower_third?.sub || "" });
  const [title, setTitle] = useState(st.title || "");
  const [card, setCard] = useState(st.card || "");
  const [handTo, setHandTo] = useState("");
  const name = (uid: string) => memberName(channel.guild_id, users[uid]) || "Someone";
  const set = (x: Record<string, unknown>) => post(channel.id, "director", x);
  const ps = participants();
  const onIds = onStageIds(stage);
  const shots: { key: string; label: string }[] = [];
  for (const u of onIds) {
    const p = ps.find((x) => x.identity === u);
    shots.push({ key: u, label: name(u) });
    if (p?.getTrackPublication(Track.Source.ScreenShare)) shots.push({ key: "screen:" + u, label: name(u) + "'s screen" });
  }
  const chip = (on: boolean, label: string, onClick: () => void, tip?: string) => (
    <button className={"camfx-chip" + (on ? " on" : "")} onClick={onClick} title={tip}>
      {label}
    </button>
  );
  const layout = !st.layout || st.layout === "speaker" ? "auto" : st.layout;
  const pip = st.pip ?? "talker";
  const others = ps.filter((p) => p.identity !== me.id);
  return (
    <div className="director-full">
      <div className="director-head">
        <b>🎬 Director</b>
        <span className="muted small">
          {stage.live ? "Live: " + stage.title : "Backstage"} · what you see here is what the audience sees
        </span>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="director-body">
        <div className="director-stage">
          <StageCanvas stage={stage} className="director-preview-box" />
          <div className="camfx-title">Main shot {st.hold ? "(your pick)" : st.follow_talk ? "(follows whoever talks)" : "(stays put)"}</div>
          <div className="camfx-row">
            {chip(!st.hold, "Automatic", () => set({ hold: false, focus: null }), "Keeps the current shot; starts on a shared screen if there is one")}
            {shots.map((s) => chip(!!st.hold && st.focus === s.key, s.label, () => set({ hold: true, focus: s.key })))}
            {!shots.length && <span className="muted small">Nobody's on stage yet.</span>}
          </div>
          <label className="check" title="The main shot jumps to whoever is talking: their shared screen if they share one, otherwise their camera">
            <input type="checkbox" checked={!!st.follow_talk} onChange={(e) => set({ follow_talk: e.target.checked, ...(e.target.checked ? { hold: false } : {}) })} /> Switch the main shot to whoever talks
          </label>
        </div>
        <div className="director-side">
          <div className="camfx-title">Layout</div>
          <div className="camfx-row">
            {chip(layout === "auto", "Main + pop-ups", () => set({ layout: "auto" }), "The main shot full screen, with small windows for people as they talk")}
            {chip(layout === "screen", "Main + all faces", () => set({ layout: "screen" }), "The main shot with everyone's camera down the side")}
            {chip(layout === "grid", "Grid", () => set({ layout: "grid" }), "Every camera and screen side by side")}
          </div>
          {layout === "auto" && (
            <>
              <div className="camfx-title">Pop-up windows</div>
              <div className="camfx-row">
                {chip(pip === "talker", "Latest talker", () => set({ pip: "talker" }), "One window that shows whoever spoke last")}
                {chip(pip === "talkers", "Everyone talking", () => set({ pip: "talkers" }), "A window for each person while they talk, up to four")}
                {chip(pip === "off", "Off", () => set({ pip: "off" }))}
              </div>
              {pip !== "off" && (
                <>
                  <div className="camfx-row">
                    {(["tl", "tr", "bl", "br"] as const).map((c) => chip((st.pip_pos ?? "br") === c, { tl: "↖ Top left", tr: "↗ Top right", bl: "↙ Bottom left", br: "↘ Bottom right" }[c], () => set({ pip_pos: c })))}
                  </div>
                  <div className="camfx-row">
                    {(["s", "m", "l"] as const).map((z) => chip((st.pip_size ?? "m") === z, { s: "Small", m: "Medium", l: "Large" }[z], () => set({ pip_size: z })))}
                  </div>
                </>
              )}
            </>
          )}
          <div className="camfx-title">Lower third</div>
          <div className="row gap">
            <input placeholder="Name / headline" value={lt.text} onChange={(e) => setLt({ ...lt, text: e.target.value })} />
            <input placeholder="Second line" value={lt.sub} onChange={(e) => setLt({ ...lt, sub: e.target.value })} />
          </div>
          <div className="row gap">
            <button className="btn small primary" onClick={() => set({ lower_third: lt.text ? lt : null })}>
              Show
            </button>
            <button className="btn small" onClick={() => set({ lower_third: null })}>
              Clear
            </button>
          </div>
          <div className="camfx-title">Title bar</div>
          <div className="row gap">
            <input placeholder="Shown at the top" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="btn small primary" onClick={() => set({ title: title || null })}>
              Show
            </button>
            <button className="btn small" onClick={() => set({ title: null })}>
              Clear
            </button>
          </div>
          <div className="camfx-title">Full-screen card</div>
          <div className="row gap">
            <input placeholder="e.g. Be right back" value={card} onChange={(e) => setCard(e.target.value)} />
            <button className="btn small primary" onClick={() => set({ card: card || null })}>
              Show
            </button>
            <button className="btn small" onClick={() => set({ card: null })}>
              Clear
            </button>
          </div>
          <div className="camfx-title">Share directing</div>
          <div className="row gap">
            <select value={handTo} onChange={(e) => setHandTo(e.target.value)}>
              <option value="">Pick someone…</option>
              {others.map((p) => (
                <option key={p.identity} value={p.identity}>
                  {name(p.identity)}
                </option>
              ))}
            </select>
            <button className="btn small" disabled={!handTo} onClick={() => post(channel.id, "role", { user_id: handTo, role: "host" }).then(() => toast(name(handTo) + " can direct too (they're a host now)"))}>
              Make a host
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** For the sidebar: is this show live? */
export function useStageLive(cid: string) {
  return useStages((s) => !!s.live[cid]);
}

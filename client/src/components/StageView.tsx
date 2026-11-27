// A show space ("stage"; see server api/stage.rs and ../stage.ts). Chat on the side, open by
// default. Off air: the next scheduled shows (Interested), and for the crew Go backstage /
// Go live / Schedule. Live: the stage drawn the way the director chose (main shot + faces,
// one person or screen, or everyone), the people on stage as round faces (a green ring on
// whoever talks), the audience below, and the controls for who you are: the audience raise a
// hand; people on stage get their mic, camera and screen; the host directs and runs hands.
import { useEffect, useState } from "react";
import { Track, type Participant } from "livekit-client";
import { api } from "../api";
import { memberName, useStore } from "../store";
import type { Channel } from "../types";
import { openMenu, toast } from "../ui";
import { joinVoice, leaveVoice, participants, setWatching, stopScreenShare, toggleCamera, toggleMute, useVoice } from "../voice";
import { loadStage, useStages, type Stage } from "../stage";
import { ChatView } from "./ChatView";
import { Avatar, Icon } from "./common";
import { RoomChatButton, ScreenPicker, Tile } from "./VoiceView";
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

function LiveStage({ channel, stage }: { channel: Channel; stage: Stage }) {
  const v = useVoice();
  useVoice((s) => s.version);
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const [picker, setPicker] = useState(false);
  const [title, setTitle] = useState("");
  const [panel, setPanel] = useState<"director" | "hands" | null>(null);
  const roleOf = (uid: string) => stage.roles.find((r) => r.user_id === uid);
  const ps = participants();
  // who's on stage: hosts and guests, plus anyone sending something (server staff)
  const onStage = ps.filter((p) => {
    const r = roleOf(p.identity)?.role;
    return r === "host" || r === "guest" || p.trackPublications.size > 0;
  });
  const audience = ps.filter((p) => !onStage.includes(p));
  const mine = roleOf(me.id);
  const iAmOn = onStage.some((p) => p.identity === me.id);
  const handUp = stage.hands.some((h) => h.user_id === me.id);
  // screens on stage are part of the show: always watched
  useEffect(() => {
    for (const p of onStage) if (p.identity !== me.id) setWatching(p.identity, "screen", true);
  }, [onStage.map((p) => p.identity).join(",")]);

  const d = stage.director || {};
  const name = (uid: string) => memberName(channel.guild_id, users[uid]) || "Someone";
  // the main shot: the director's pick, or whoever's talking (if following talk), or the first host
  const talker = onStage.find((p) => v.speaking.includes(p.identity));
  const pick = (focus: string | null | undefined): { p: Participant; src: Track.Source } | null => {
    if (!focus) return null;
    const screen = focus.startsWith("screen:");
    const uid = screen ? focus.slice(7) : focus;
    const p = onStage.find((x) => x.identity === uid);
    if (!p) return null;
    const hasScreen = !!p.getTrackPublication(Track.Source.ScreenShare);
    return { p, src: screen || hasScreen ? Track.Source.ScreenShare : Track.Source.Camera };
  };
  const main =
    pick(d.layout === "spotlight" || !d.follow_talk ? d.focus : null) ||
    (d.follow_talk && talker ? pick(talker.identity) : null) ||
    pick(d.focus) ||
    (onStage[0] ? pick(onStage[0].identity) : null);

  const faceMenu = (e: React.MouseEvent, uid: string) => {
    e.preventDefault();
    const r = roleOf(uid);
    const items: any[] = [];
    if (stage.can_run) {
      items.push({ label: "Put on the main shot", onClick: () => post(channel.id, "director", { ...d, layout: d.layout === "grid" ? "auto" : d.layout || "auto", focus: uid }) });
      items.push({ label: "Their screen on the main shot", onClick: () => post(channel.id, "director", { ...d, layout: "spotlight", focus: "screen:" + uid }) });
    }
    if (stage.can_manage && uid !== me.id && r && (r.role === "guest" || r.role === "host")) {
      items.push({ label: r.muted ? "Unmute" : "Mute", onClick: () => post(channel.id, "mute", { user_id: uid, muted: !r.muted }) });
    }
    if (stage.can_manage && r?.role === "guest") items.push({ label: "Send back to the audience", danger: true, onClick: () => post(channel.id, "back", { user_id: uid }) });
    if (stage.can_manage && !r && uid !== me.id) items.push({ label: "Bring up on stage", onClick: () => post(channel.id, "bring", { user_id: uid }) });
    if (stage.can_run && uid !== me.id) {
      items.push({ separator: true, label: "" });
      if (r?.role !== "host") items.push({ label: "Make a host", onClick: () => post(channel.id, "role", { user_id: uid, role: "host" }) });
      if (r?.role !== "moderator") items.push({ label: "Make a moderator", onClick: () => post(channel.id, "role", { user_id: uid, role: "moderator" }) });
      if (r && r.role !== "guest") items.push({ label: "Take away their show role", onClick: () => post(channel.id, "role", { user_id: uid, role: "none" }) });
    }
    if (items.length) openMenu(e, items);
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
      <div className={"stage-main" + (d.layout === "grid" ? " grid" : "")}>
        {d.layout === "grid" ? (
          onStage.map((p) => <Tile key={p.identity} spec={{ key: p.identity, participant: p, source: Track.Source.Camera }} guildId={channel.guild_id} onClick={() => {}} />)
        ) : main ? (
          <Tile key={main.p.identity + main.src} spec={{ key: main.p.identity, participant: main.p, source: main.src }} guildId={channel.guild_id} big bare onClick={() => {}} />
        ) : (
          <div className="stage-empty muted">Nobody's on stage yet.</div>
        )}
      </div>
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
      {panel === "director" && stage.can_run && (
        <div className="stage-panel">
          <div className="stage-panel-head">
            <b>Director</b>
            <span className="muted small">What the audience sees. Tap a face to put them on the main shot.</span>
          </div>
          <div className="stage-layouts">
            {(
              [
                ["auto", "Main shot + faces"],
                ["spotlight", "Spotlight"],
                ["grid", "Everyone"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={"btn small" + ((d.layout || "auto") === k ? " primary" : "")} onClick={() => post(channel.id, "director", { ...d, layout: k })}>
                {l}
              </button>
            ))}
            <label className="radio-row">
              <input type="checkbox" checked={!!d.follow_talk} onChange={(e) => post(channel.id, "director", { ...d, follow_talk: e.target.checked })} /> Switch to whoever talks
            </label>
          </div>
        </div>
      )}

      <div className="stage-controls">
        {iAmOn ? (
          <>
            <button className={"icon-btn round" + (v.muted || !v.canSpeak ? " off" : "")} title={v.canSpeak ? (v.muted ? "Unmute" : "Mute") : "You're muted by the host"} onClick={() => v.canSpeak && toggleMute()}>
              <Icon name="mic" size={20} />
            </button>
            {v.canVideo && (
              <>
                <button className={"icon-btn round" + (v.camera ? " on" : "")} title="Camera" onClick={() => toggleCamera()}>
                  <Icon name="video" size={20} />
                </button>
                <button className={"icon-btn round" + (v.screen ? " on" : "")} title="Share your screen" onClick={() => (v.screen ? stopScreenShare() : setPicker(true))}>
                  <Icon name="screen" size={20} />
                </button>
              </>
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
          <button className={"btn small" + (panel === "director" ? " primary" : "")} onClick={() => setPanel(panel === "director" ? null : "director")}>
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
      {picker && <ScreenPicker onClose={() => setPicker(false)} />}
    </div>
  );
}

/** For the sidebar: is this show live? */
export function useStageLive(cid: string) {
  return useStages((s) => !!s.live[cid]);
}

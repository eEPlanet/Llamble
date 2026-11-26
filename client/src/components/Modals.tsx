import { bannerCss, useProfile } from "./Profile";
import { useShallow } from "zustand/react/shallow";
import { KidChats } from "./Family";
import { RecoveryCodeNotice } from "./Recovery";
import { PartyModal, NewDmModal } from "./Friends";
import { ShareModal } from "./Share";
import { useEffect, useState, useMemo } from "react";
import { api, media, session } from "../api";
import { can, memberName, roleColor, selectChannel, useStore } from "../store";
import { P } from "../types";
import { closeModal, copy, toast, useUI, type ModalSpec } from "../ui";
import { Avatar, BotTag, Icon } from "./common";
import { ScreenPicker } from "./VoiceView";
import { DiscoverModal } from "./Discover";
import { ServerSettings, UserSettings } from "./Settings";
import { useBlocked, REASONS } from "../safety";
import { SafetyLinks } from "./Safety";

export function Modals() {
  const modals = useUI((s) => s.modals);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useUI.getState().modals.length && !useUI.getState().menu) closeModal();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <>
      {modals.map((m, i) => (
        <div key={i} className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
          <ModalBody m={m} />
        </div>
      ))}
    </>
  );
}

function ModalBody({ m }: { m: ModalSpec }) {
  switch (m.kind) {
    case "createGuild":
      return <CreateGuild />;
    case "joinInvite":
      return <JoinInvite code={m.code} />;
    case "createChannel":
      return <CreateChannel guildId={m.guildId} parentId={m.parentId ?? null} kind={m.channelKind} />;
    case "editChannel":
      return <EditChannel channelId={m.channelId} />;
    case "invite":
      return <InviteModal guildId={m.guildId} />;
    case "confirm":
      return <Confirm {...m} />;
    case "profile":
      return <Profile userId={m.userId} guildId={m.guildId} />;
    case "screenPicker":
      return (
        <div className="modal wide">
          <h2>{m.mode === "record" ? "Record your screen or a game" : "Share your screen"}</h2>
          {m.mode === "record" && <p className="muted small">Recorded on your graphics card to an MP4 on this PC (Videos\Llamble). Nothing is sent anywhere; it shows up in My Media → Recordings.</p>}
          <ScreenPicker onClose={closeModal} mode={m.mode} />
        </div>
      );
    case "saveGif":
      return <SaveGif fileId={m.fileId} url={m.url} preview={m.preview} />;
    case "serverSettings":
      return <ServerSettings guildId={m.guildId} tab={m.tab} />;
    case "userSettings":
      return <UserSettings tab={m.tab} />;
    case "prompt":
      return <Prompt {...m} />;
    case "kidChats":
      return <KidChats kidId={m.kidId} name={m.name} />;
    case "recoveryCode":
      return <RecoveryCodeNotice code={m.code} />;
    case "share":
      return <ShareModal msg={m.msg} />;
    case "party":
      return <PartyModal partyId={m.partyId} with={m.with} />;
    case "newDm":
      return <NewDmModal />;
    case "llambleInvite":
      return <LlambleInvite />;
    case "discover":
      return <DiscoverModal guildId={m.guildId} />;
    case "report":
      return <ReportModal userId={m.userId} messageId={m.messageId} />;
  }
}

function useSubmit<T>(fn: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await fn();
      closeModal();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function CreateGuild() {
  const me = useStore((s) => s.me);
  const [name, setName] = useState(`${me?.display_name}'s server`);
  const { busy, error, run } = useSubmit(async () => {
    const g = await api("/api/guilds", { body: { name } });
    selectChannel(g.guild.id, null);
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>Create a server</h2>
      <p className="muted">A server is where your people, chats and voice rooms live.</p>
      <label>
        Server name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !name.trim()}>
          Create
        </button>
      </div>
    </form>
  );
}

function JoinInvite({ code: initial }: { code?: string }) {
  const [code, setCode] = useState((initial || "").split("@")[0]);
  const [preview, setPreview] = useState<any>(null);
  useEffect(() => {
    const c = /invite\/([^@/?#\s]+)/.exec(code)?.[1] || code.trim();
    if (c.length < 6) return setPreview(null);
    const t = setTimeout(() => api(`/api/invites/${encodeURIComponent(c)}`).then(setPreview).catch(() => setPreview(false)), 300);
    return () => clearTimeout(t);
  }, [code]);
  const { busy, error, run } = useSubmit(async () => {
    const c = /invite\/([^@/?#\s]+)/.exec(code)?.[1] || code.trim();
    const r = await api(`/api/invites/${encodeURIComponent(c)}`, { method: "POST" });
    if (r.pending) {
      toast("A parent needs to OK this server first. They've been asked.");
      closeModal();
      return;
    }
    if (r.guild_id) selectChannel(r.guild_id, null);
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>Join a server</h2>
      <label>
        Invite code or link
        <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="Xk3pQ9aB2z" />
      </label>
      {preview?.guild && (
        <div className="invite-preview">
          <b>{preview.guild.name}</b> · {preview.guild.member_count} members
        </div>
      )}
      {preview === false && <div className="form-error">Invalid or expired invite.</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !preview}>
          Join Server
        </button>
      </div>
    </form>
  );
}

function CreateChannel({ guildId, parentId, kind: initialKind }: { guildId: string; parentId: string | null; kind?: "text" | "voice" | "category" }) {
  const [kind, setKind] = useState<"text" | "voice" | "watch" | "category">(initialKind || "text");
  const watchOn = useStore((s) => s.config.watch?.on ?? false);
  const [name, setName] = useState("");
  // it lands under its type (Chat, Voice & Video, Watch), or in the group it was added from
  const group = useStore((s) => (parentId ? s.channels[parentId] : undefined));
  const pickKind = (k: typeof kind) => setKind(k);
  const { busy, error, run } = useSubmit(async () => {
    const ch = await api(`/api/guilds/${guildId}/channels`, { body: { name, kind, parent_id: kind === "category" ? null : parentId } });
    if (ch.kind === "text") selectChannel(guildId, ch.id);
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>{kind === "category" ? "Make a Group" : group ? `Add a Space to ${group.name}` : "Add a Space"}</h2>
      {kind === "category" && <p className="muted small">A group holds any spaces you move into it (drag them, or right-click → Move to…). Spaces outside groups stay under their type.</p>}
      {kind !== "category" && (
        <div className="kind-pick">
          {((watchOn ? ["text", "voice", "watch"] : ["text", "voice"]) as ("text" | "voice" | "watch")[]).map((k) => (
            <label key={k} className={"kind-opt" + (kind === k ? " on" : "")}>
              <input type="radio" checked={kind === k} onChange={() => pickKind(k)} />
              <span className="kind-emoji">{k === "watch" ? "🍿" : k === "voice" ? "🔊" : "💬"}</span>
              <div>
                <b>{k === "text" ? "Chat" : k === "voice" ? "Voice & Video" : "Watch Party"}</b>
                <div className="muted small">{k === "text" ? "Messages, images, GIFs, files" : k === "voice" ? "Talk, video, and screen share" : "Watch together: a shared player and queue, with voice and chat"}</div>
              </div>
            </label>
          ))}
        </div>
      )}
      <label>
        Name
        <input value={name} onChange={(e) => setName(kind === "text" ? e.target.value.toLowerCase().replace(/\s+/g, "-") : e.target.value)} autoFocus maxLength={100} placeholder={kind === "text" ? "new-chat" : kind === "voice" ? "Lounge" : kind === "watch" ? "Movie Night" : "Gaming"} />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !name.trim()}>
          Create
        </button>
      </div>
    </form>
  );
}

function EditChannel({ channelId }: { channelId: string }) {
  const ch = useStore((s) => s.channels[channelId]);
  const [name, setName] = useState(ch?.name || "");
  const [topic, setTopic] = useState(ch?.topic || "");
  const [position, setPosition] = useState(ch?.position ?? 0);
  const [retention, setRetention] = useState<number>(ch?.retention_days ?? 0);
  const { busy, error, run } = useSubmit(() => api(`/api/channels/${channelId}`, { method: "PATCH", body: { name, topic, position, retention_days: retention } }));
  if (!ch) return null;
  return (
    <form className="modal" onSubmit={run}>
      <h2>{ch.kind === "category" ? "Rename Group" : "Edit Space"}</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {ch.kind === "text" && (
        <label>
          Topic
          <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} maxLength={1024} />
        </label>
      )}
      {ch.kind === "text" && (
        <label>
          Auto-delete messages
          <select value={retention} onChange={(e) => setRetention(Number(e.target.value))}>
            <option value={0}>Never (keep everything)</option>
            <option value={1}>After 1 day</option>
            <option value={7}>After 7 days</option>
            <option value={30}>After 30 days</option>
            <option value={90}>After 90 days</option>
            <option value={365}>After 1 year</option>
          </select>
        </label>
      )}
      <label>
        Position <span className="muted small">(lower shows first)</span>
        <input type="number" value={position} onChange={(e) => setPosition(Number(e.target.value))} />
      </label>
      {ch.kind !== "category" && ch.guild_id && (can(ch.guild_id, P.LOCK_SPACES) || can(ch.guild_id, P.MANAGE_CHANNELS)) && (
        <label className="perm-row">
          <span className="grow">
            <b>Locked</b>
            <div className="muted small">Only staff can go in (to clean up, say). People already in a voice or Watch Party room stay. Takes effect right away.</div>
          </span>
          <input
            type="checkbox"
            checked={!!ch.locked}
            onChange={(e) => api(`/api/channels/${ch.id}/lock`, { body: { locked: e.target.checked } }).catch((err) => toast(err.message, "error"))}
          />
        </label>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

export function serverAddress() {
  const d = useStore.getState().config.public_domain;
  return d ? `https://${d}` : session.server;
}

/** A normal web link: opens the sign-up page in any browser; also pasteable into the desktop app. */
export function inviteLink(code: string) {
  return `${serverAddress().replace(/\/+$/, "")}/invite/${code}`;
}

function InviteModal({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const [expires, setExpires] = useState(7 * 86400);
  const [maxUses, setMaxUses] = useState(0);
  const [friend, setFriend] = useState(true);
  const [inv, setInv] = useState<any>(null);
  const [error, setError] = useState("");
  const make = async () => {
    try {
      setInv(await api(`/api/guilds/${guildId}/invites`, { body: { expires_in: expires, max_uses: maxUses, add_friend: friend } }));
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    make();
  }, [expires, maxUses, friend]);
  return (
    <div className="modal">
      <h2>Invite people to {guild?.name}</h2>
      <AddAsFriends on={friend} set={setFriend} />
      <InviteSearch guildId={guildId} addFriend={friend} />
      <SendToParty guildId={guildId} />
      <div className="sidebar-sep" />
      <p className="muted small">Not on Llamble yet? Send this link. It opens a sign-up page in any browser (phone, Chromebook, laptop). People with the desktop app can paste it into Register instead.</p>
      {inv && (
        <>
          <label>Invite link</label>
          <div className="copy-row">
            <input readOnly value={inviteLink(inv.code)} onFocus={(e) => e.target.select()} />
            <button className="btn primary" onClick={() => copy(inviteLink(inv.code), "Invite link copied")}>
              Copy
            </button>
          </div>
          <div className="muted small">
            Code <b>{inv.code}</b> · server <b>{serverAddress()}</b>
            {!useStore.getState().config.public_domain && " · this home address only works on your network until Remote Access is on"}
          </div>
        </>
      )}
      <div className="row gap">
        <label className="grow">
          Expire after
          <select value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            <option value={1800}>30 minutes</option>
            <option value={86400}>1 day</option>
            <option value={7 * 86400}>7 days</option>
            <option value={30 * 86400}>30 days</option>
            <option value={0}>Never</option>
          </select>
        </label>
        <label className="grow">
          Max uses
          <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            <option value={0}>No limit</option>
            <option value={1}>1 use</option>
            <option value={5}>5 uses</option>
            <option value={10}>10 uses</option>
            <option value={50}>50 uses</option>
          </select>
        </label>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button className="btn primary" onClick={closeModal}>
          Done
        </button>
      </div>
    </div>
  );
}

function Prompt(m: Extract<ModalSpec, { kind: "prompt" }>) {
  const [v, setV] = useState(m.initial || "");
  const { busy, error, run } = useSubmit(async () => {
    await m.onSubmit(v);
    closeModal();
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>{m.title}</h2>
      <label>
        {m.label}
        <input type={m.password ? "password" : "text"} value={v} onChange={(e) => setV(e.target.value)} placeholder={m.placeholder} autoFocus />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !v.trim()}>
          {m.confirmLabel || "OK"}
        </button>
      </div>
    </form>
  );
}

function Confirm(m: Extract<ModalSpec, { kind: "confirm" }>) {
  const { busy, error, run } = useSubmit(async () => {
    await m.onConfirm();
  });
  return (
    <div className="modal">
      <h2>{m.title}</h2>
      <p>{m.body}</p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className={"btn " + (m.danger ? "red" : "primary")} disabled={busy} onClick={() => run()} autoFocus>
          {m.confirmLabel || "Confirm"}
        </button>
      </div>
    </div>
  );
}

function Profile({ userId, guildId }: { userId: string; guildId: string | null }) {
  const user = useStore((s) => s.users[userId]);
  const member = useStore((s) => (guildId ? s.members[guildId]?.[userId] : undefined));
  const roles = useStore((s) => (guildId ? s.roles[guildId] : undefined)) || [];
  const me = useStore((s) => s.me)!;
  const presence = useStore((s) => s.presences[userId]);
  const game = useStore((s) => s.games[userId]);
  const manageRoles = guildId ? can(guildId, P.MANAGE_ROLES) : false;
  const prof = useProfile(user && !user.is_bot ? userId : null);
  if (!user) return null;
  const toggleRole = (rid: string, has: boolean) =>
    api(`/api/guilds/${guildId}/members/${userId}/roles/${rid}`, { method: has ? "DELETE" : "PUT" }).catch((e) => toast(e.message, "error"));
  const call = async () => {
    try {
      const dm = await api("/api/users/@me/channels", { body: { recipient_id: userId } });
      closeModal();
      selectChannel("@me", dm.id);
      const { startCall } = await import("../calls");
      startCall(dm.id);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const message = async () => {
    try {
      const dm = user.is_bot ? await api("/api/bot/dm", { method: "POST" }) : await api("/api/users/@me/channels", { body: { recipient_id: userId } });
      closeModal();
      selectChannel("@me", dm.id);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div className="modal profile">
      <div className="profile-banner" style={{ background: prof?.banner ? bannerCss(prof.banner) : roleColor(guildId, userId) || bannerCss("") }} />
      <div className="profile-avatar">
        <Avatar user={user} size={88} status />
      </div>
      <div className="profile-body">
        <h2>
          {memberName(guildId, user)} {user.is_bot && <BotTag />}
        </h2>
        <div className="muted">@{user.username}{user.is_admin ? " · server admin" : ""}</div>
        <div className="muted small">{user.is_bot ? "AI assistant (llama.cpp)" : presence && presence !== "offline" ? presence : "offline"}</div>
        {prof?.bio && <div className="profile-bio">{prof.bio}</div>}
        {game && presence && presence !== "offline" && (
          <div className="playing" style={{ marginTop: 6 }}>
            🎮 Playing <b>{game}</b>
          </div>
        )}
        {member && (
          <>
            <div className="profile-section">Member since</div>
            <div>{new Date(member.joined_at).toLocaleDateString()}</div>
            <div className="profile-section">Roles</div>
            <div className="role-chips">
              {roles
                .filter((r) => r.id !== guildId && (member.roles.includes(r.id) || manageRoles))
                .map((r) => {
                  const has = member.roles.includes(r.id);
                  return (
                    <button key={r.id} className={"role-chip" + (has ? " has" : "")} disabled={!manageRoles} onClick={() => toggleRole(r.id, has)}>
                      <span className="role-dot" style={{ background: r.color ? "#" + r.color.toString(16).padStart(6, "0") : "#99aab5" }} />
                      {r.name}
                      {manageRoles && <span className="muted">{has ? " ✕" : " +"}</span>}
                    </button>
                  );
                })}
              {!member.roles.length && !manageRoles && <span className="muted small">No roles</span>}
            </div>
          </>
        )}
        {userId !== me.id && (
          <div className="profile-actions">
            <button className="btn primary wide" onClick={message}>
              <Icon name="chat" size={18} /> Message
            </button>
            {!user.is_bot && (
              <button className="btn green wide" onClick={call}>
                <Icon name="phone" size={18} /> Call
              </button>
            )}
          </div>
        )}
        {userId !== me.id && !user.is_bot && <SafetyLinks userId={userId} name={user.display_name} before={closeModal} />}
      </div>
    </div>
  );
}

/** Report a message or a person to the people who run this Llamble. */
function ReportModal({ userId, messageId }: { userId: string; messageId?: string }) {
  const user = useStore((s) => s.users[userId]);
  const blocked = useBlocked(userId);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = user?.display_name || "this person";
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/reports", { body: messageId ? { message_id: messageId, reason, note } : { user_id: userId, reason, note } });
      if (alsoBlock && !blocked) {
        await api(`/api/blocks/${userId}`, { method: "PUT" });
        useStore.setState((s) => ({ blocked: s.blocked.includes(userId) ? s.blocked : [...s.blocked, userId] }));
      }
      setDone(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <div className="modal">
        <h2>Thanks for telling us</h2>
        <p className="muted">
          Your report went to the people who run this Llamble{messageId ? ", and the server's owner" : ""}, with a copy of {messageId ? "the message" : "who it's about"}. They can remove the message or the person. {name} isn't told who reported them.
        </p>
        <div className="modal-foot">
          <button className="btn primary" onClick={closeModal}>
            Done
          </button>
        </div>
      </div>
    );
  return (
    <form className="modal" onSubmit={send}>
      <h2>{messageId ? "Report message" : `Report ${name}`}</h2>
      <p className="muted small">Goes to the people who run this Llamble{messageId ? " and this server's owner" : ""}. {name} isn't told who reported them.</p>
      <div className="report-reasons">
        {REASONS.map(([k, label]) => (
          <label key={k} className="radio-row">
            <input type="radio" name="reason" checked={reason === k} onChange={() => setReason(k)} /> {label}
          </label>
        ))}
      </div>
      <label>
        Anything else? <span className="muted small">(optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} />
      </label>
      {!blocked && (
        <label className="radio-row">
          <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} /> Also block {name}
        </label>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn danger" disabled={busy || !reason}>
          {busy ? "Sending…" : "Report"}
        </button>
      </div>
    </form>
  );
}

function SaveGif({ fileId, url: initialUrl, preview }: { fileId?: string; url?: string; preview?: string }) {
  const [url, setUrl] = useState(initialUrl || "");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const { busy, error, run } = useSubmit(async () => {
    const r = await api("/api/gifs", { body: fileId ? { file_id: fileId, title, tags } : { url, title, tags } });
    toast(r.existing ? "Already in the library — added to your favorites" : "Saved to the GIF library");
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>Save GIF to library</h2>
      <p className="muted small">The GIF is stored on your server so everyone can search it. Nothing is fetched from GIF sites when people use it.</p>
      {preview && (preview.includes(".mp4") || preview.includes("video") ? <video className="gif-preview" src={media(preview)} autoPlay loop muted /> : <img className="gif-preview" src={media(preview)} alt="" />)}
      {!fileId && (
        <label>
          GIF link (Tenor/Giphy page or direct .gif/.mp4)
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoFocus />
        </label>
      )}
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!!fileId} placeholder="victory dance" />
      </label>
      <label>
        Tags <span className="muted small">(comma or space separated)</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="happy, dance, win" />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || (!fileId && !url)}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** Invite a whole party: posts the invite in the party's chat. */
/** Search people on this instance and send each an invite card in your DM with them. */
/** The "Add as friends" box on invites (checked by default). */
function AddAsFriends({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  if (useStore.getState().me?.is_kid) return null;
  return (
    <label className="check-row">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>
        Add as friends <span className="muted small">· whoever joins from this invite becomes your friend</span>
      </span>
    </label>
  );
}

/** A one-time link to join this Llamble (no server). */
function LlambleInvite() {
  const [friend, setFriend] = useState(true);
  const [inv, setInv] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    api("/api/invites/llamble", { body: { add_friend: friend } })
      .then(setInv)
      .catch((e) => setError(e.message));
  }, [friend]);
  return (
    <div className="modal">
      <h2>Invite someone to Llamble</h2>
      <p className="muted small">A link that signs one person up for this Llamble. It doesn't add them to any server. It works once and runs out in 7 days.</p>
      <AddAsFriends on={friend} set={setFriend} />
      {inv && (
        <>
          <label>Invite link</label>
          <div className="copy-row">
            <input readOnly value={inviteLink(inv.code)} onFocus={(e) => e.target.select()} />
            <button className="btn primary" onClick={() => copy(inviteLink(inv.code), "Invite link copied")}>
              Copy
            </button>
          </div>
          <div className="muted small">
            Code <b>{inv.code}</b>
            {!useStore.getState().config.public_domain && " · this home address only works on your network until Remote Access is on"}
          </div>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button className="btn primary" onClick={closeModal}>
          Done
        </button>
      </div>
    </div>
  );
}

function InviteSearch({ guildId, addFriend }: { guildId: string; addFriend?: boolean }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<any[]>([]);
  const [scope, setScope] = useState("connections");
  const [sent, setSent] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/api/guilds/${guildId}/invite-search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => {
          setFound(r.people);
          setScope(r.scope);
        })
        .catch(() => setFound([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, guildId]);
  const invite = async (uid: string) => {
    setBusy(uid);
    try {
      const r = await api(`/api/guilds/${guildId}/invite-people`, { body: { user_ids: [uid], add_friend: !!addFriend } });
      if (r.sent.length) setSent((x) => [...x, uid]);
      else toast(r.skipped[0]?.why || "They can't be invited", "error");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="invite-search">
      <label>
        Find people on this Llamble
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or username" autoFocus />
      </label>
      <div className="muted small">{scope === "everyone" ? "Everyone on this Llamble." : "Your friends and people who share a server with you."} The invite goes to your chat with them.</div>
      <div className="invite-results">
        {found.map((u) => (
          <div key={u.id} className="invite-result">
            <Avatar user={u} size={32} />
            <span className="grow ellipsis">
              <b>{u.display_name}</b> <span className="muted small">@{u.username}</span>
              {u.your_kid && <span className="muted small"> · your kid</span>}
            </span>
            {u.member ? (
              <span className="muted small">Already in</span>
            ) : sent.includes(u.id) ? (
              <span className="muted small">Invited ✓</span>
            ) : (
              <button className="btn small primary" disabled={busy === u.id} onClick={() => invite(u.id)}>
                Invite
              </button>
            )}
          </div>
        ))}
        {!found.length && q.trim() && <div className="muted small">Nobody found.</div>}
      </div>
    </div>
  );
}

/** Invite a whole party: one card in the party's chat that shows who has joined. */
function SendToParty({ guildId }: { guildId: string }) {
  const channels = useStore((s) => s.channels);
  const parties = useMemo(() => Object.values(channels).filter((c) => c.kind === "party" && !(c as any).unsaved), [channels]);
  const [sent, setSent] = useState<string[]>([]);
  if (!parties.length) return null;
  return (
    <div className="row gap" style={{ flexWrap: "wrap", marginTop: 8 }}>
      <span className="muted small">Invite a party:</span>
      {parties.map((p) => (
        <button
          key={p.id}
          className="btn small"
          disabled={sent.includes(p.id)}
          onClick={() =>
            api(`/api/guilds/${guildId}/invite-party`, { body: { party_id: p.id } })
              .then(() => setSent((x) => [...x, p.id]))
              .catch((e) => toast(e.message, "error"))
          }
        >
          {sent.includes(p.id) ? `Sent to ${p.name}` : p.name}
        </button>
      ))}
    </div>
  );
}

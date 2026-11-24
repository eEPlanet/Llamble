// Open servers: the binoculars at the bottom of the server list. A searchable list of the
// servers on this Llamble that are listed (open / preview / request), a read-only look
// around before joining, and requests to join.
import { useEffect, useState } from "react";
import { api } from "../api";
import { selectChannel } from "../store";
import type { JoinMode, Message } from "../types";
import { closeModal, toast } from "../ui";
import { GuildIcon, Icon } from "./common";
import { MessageItem } from "./MessageItem";

export const JOIN_MODES: { id: JoinMode; label: string; help: string }[] = [
  { id: "open", label: "Open", help: "Listed under Open servers. Anyone can look around and join. Any member can invite." },
  { id: "preview", label: "Look around, then request", help: "Listed. Anyone can look around (read-only), then ask to join. Staff can also invite." },
  { id: "request", label: "Request only", help: "Listed with its name and description. People ask to join without looking around. Staff can also invite." },
  { id: "invite", label: "Invite only", help: "Not listed. Only staff can invite people." },
];

const SEEN_KEY = "llamble.openServersSeen";

/** When you last opened Open servers (for the dot on the binoculars). */
export function openServersSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) || 0);
  } catch {
    return 0;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {}
}

function ServerIcon({ g, size }: { g: { name: string; icon_file_id: string | null }; size: number }) {
  return (
    <span className="disc-icon" style={{ width: size, height: size, fontSize: size / 3 }}>
      <GuildIcon name={g.name} iconId={g.icon_file_id} size={size} />
    </span>
  );
}

type Server = {
  id: string;
  name: string;
  icon_file_id: string | null;
  description: string;
  join_mode: JoinMode;
  member_count: number;
  listed_at?: number | null;
  member?: boolean;
  request?: { status: "pending" | "declined"; again_at?: number } | null;
};

function modeTag(m: JoinMode) {
  return m === "open" ? "Open" : "Request to join";
}

export function DiscoverModal({ guildId }: { guildId?: string }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Server[] | null>(null);
  const [open, setOpen] = useState<string | null>(guildId || null);
  const load = () =>
    api(`/api/discover?q=${encodeURIComponent(q.trim())}`)
      .then((r) => setList(r.servers))
      .catch(() => setList([]));
  useEffect(() => {
    markSeen();
    window.dispatchEvent(new Event("llamble-open-servers-seen"));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [q]);
  if (open) return <Preview gid={open} back={() => (guildId ? closeModal() : (setOpen(null), load()))} />;
  return (
    <div className="modal wide discover">
      <h2>Open servers</h2>
      <p className="muted small">Servers on this Llamble that anyone can find. Some you can join right away; others take a request.</p>
      <label className="discover-search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or description" autoFocus />
      </label>
      <div className="discover-grid">
        {(list || []).map((g) => (
          <button key={g.id} className="discover-card" onClick={() => setOpen(g.id)}>
            <ServerIcon g={g} size={48} />
            <div className="discover-info">
              <div className="discover-name ellipsis">{g.name}</div>
              {g.description && <div className="muted small discover-desc">{g.description}</div>}
              <div className="muted small">
                {g.member_count} member{g.member_count === 1 ? "" : "s"} · {g.request?.status === "pending" ? "Request sent" : modeTag(g.join_mode)}
              </div>
            </div>
          </button>
        ))}
        {list && !list.length && <div className="muted small pad">{q.trim() ? "Nothing matches." : "No open servers right now."}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn primary" onClick={closeModal}>
          Done
        </button>
      </div>
    </div>
  );
}

function Preview({ gid, back }: { gid: string; back: () => void }) {
  const [data, setData] = useState<{ guild: Server; channels: any[] } | null>(null);
  const [err, setErr] = useState("");
  const [chat, setChat] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api(`/api/discover/${gid}`)
      .then((d) => {
        setData(d);
        setChat((c) => c || d.channels.find((x: any) => x.kind === "text")?.id || null);
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, [gid]);
  useEffect(() => {
    if (!chat) return setMsgs([]);
    api(`/api/discover/${gid}/channels/${chat}/messages`)
      .then((m) => setMsgs(m))
      .catch(() => setMsgs([]));
  }, [chat, gid]);
  if (err) {
    return (
      <div className="modal">
        <h2>Not available</h2>
        <p className="muted">This server isn't open to find right now.</p>
        <div className="modal-foot">
          <button className="btn" onClick={back}>
            Back
          </button>
        </div>
      </div>
    );
  }
  if (!data) return <div className="modal wide discover" />;
  const g = data.guild;
  const act = async (f: () => Promise<any>) => {
    setBusy(true);
    try {
      await f();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const join = () =>
    act(async () => {
      const r = await api(`/api/discover/${gid}/join`, { method: "POST" });
      closeModal();
      if (r.pending) toast("A parent needs to OK this server first. They've been asked.");
      else selectChannel(gid, null);
    });
  const request = () =>
    act(async () => {
      await api(`/api/discover/${gid}/request`, { body: { note } });
      setAsking(false);
      toast(`Request sent to ${g.name}'s staff`);
      load();
    });
  const cancel = () =>
    act(async () => {
      await api(`/api/discover/${gid}/request`, { method: "DELETE" });
      load();
    });
  const pending = g.request?.status === "pending";
  const declined = g.request?.status === "declined";
  const rooms = data.channels.filter((c) => c.kind !== "category");
  return (
    <div className="modal wide discover discover-preview">
      <div className="discover-bar">
        <button className="icon-btn" title="Back" onClick={back}>
          <Icon name="chevron-left" size={18} />
        </button>
        <ServerIcon g={g} size={36} />
        <div className="grow">
          <div className="discover-name">{g.name}</div>
          <div className="muted small">
            {g.member_count} member{g.member_count === 1 ? "" : "s"}
            {g.description ? ` · ${g.description}` : ""}
          </div>
        </div>
        {g.member ? (
          <button className="btn primary" onClick={() => (closeModal(), selectChannel(gid, null))}>
            Open
          </button>
        ) : g.join_mode === "open" ? (
          <button className="btn primary" disabled={busy} onClick={join}>
            Join this server
          </button>
        ) : pending ? (
          <>
            <span className="muted small">Request sent</span>
            <button className="btn small link" disabled={busy} onClick={cancel}>
              Take back
            </button>
          </>
        ) : declined ? (
          <span className="muted small">Declined. You can ask again {new Date(g.request!.again_at!).toLocaleDateString()}.</span>
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => setAsking(true)}>
            Request to join
          </button>
        )}
      </div>
      {asking && (
        <div className="discover-ask">
          <label>
            A note for the staff (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Who you are, who you know there" autoFocus />
          </label>
          <div className="row gap">
            <button className="btn link" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={request}>
              Send request
            </button>
          </div>
        </div>
      )}
      {g.join_mode === "request" ? (
        <p className="muted pad">This server takes requests. You can look around once you're in.</p>
      ) : (
        <div className="discover-look">
          <div className="discover-rooms">
            {rooms.map((c) =>
              c.kind === "text" ? (
                <button key={c.id} className={"discover-room" + (chat === c.id ? " on" : "")} onClick={() => setChat(c.id)}>
                  <span>💬</span> <span className="ellipsis">{c.name}</span>
                </button>
              ) : (
                <div key={c.id} className="discover-room static">
                  <span>{c.kind === "watch" ? "🍿" : "🔊"}</span> <span className="ellipsis grow">{c.name}</span>
                  {c.in_room > 0 && <span className="muted small">{c.in_room} here</span>}
                </div>
              ),
            )}
          </div>
          <div className="discover-msgs">
            <div className="muted small discover-ro">Looking around: read-only until you join</div>
            {[...msgs].reverse().map((m) => (
              <MessageItem key={m.id} msg={m} guildId={null} compact={false} readOnly />
            ))}
            {chat && !msgs.length && <div className="muted small pad">No messages yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

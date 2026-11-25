// The Notifications desk (Home), its section on the Home board, and the invite card that
// shows in chats.
import { useEffect, useState } from "react";
import { api } from "../api";
import { clearNotice, markRead, openCardChat, useNotices, type Notice } from "../notifications";
import { openFriend, openHome, selectChannel, useStore } from "../store";
import { openModal, toast, useUI } from "../ui";
import { Avatar, GuildIcon } from "./common";

function ago(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const nameOf = (u: any) => u?.display_name || u?.username || "Someone";

/** Open a chat at one message (the chat loads further back until it finds it). */
export function openMessage(home: string | undefined, channelId: string, messageId: string) {
  if (!home || !channelId) return;
  selectChannel(home, channelId);
  setTimeout(() => useUI.setState({ jumpTo: messageId }), 300);
}

/** What a notification says, and what tapping it does. */
function describe(n: Notice): { text: string; who?: any; guild?: any; open?: () => void } {
  const d = n.data || {};
  switch (n.kind) {
    case "server_invite":
      return {
        text: `${nameOf(d.from)} ${d.reminder ? "reminded you about" : "invited you to"} ${d.guild?.name || "a server"}${d.party ? " (in your party)" : ""}`,
        who: d.from,
        guild: d.guild,
        open: () => d.channel_id && openCardChat(d.channel_id, !!d.party),
      };
    case "invite_accepted":
      return d.guild
        ? { text: `${nameOf(d.by)} joined ${d.guild.name || "your server"} from your invite`, who: d.by, open: () => d.guild?.id && selectChannel(d.guild.id, null) }
        : { text: `${nameOf(d.by)} joined Llamble from your invite`, who: d.by, open: () => openFriend(d.by?.id || null) };
    case "join_request":
      return { text: `${nameOf(d.from)} asked to join ${d.guild?.name || "your server"}${d.note ? `: “${d.note}”` : ""}`, who: d.from, open: () => d.guild?.id && openModal({ kind: "serverSettings", guildId: d.guild.id, tab: "requests" }) };
    case "join_approved":
      return {
        text: d.pending_parent ? `${d.guild?.name || "A server"} said yes. A parent needs to OK it too.` : `You're in: ${d.guild?.name || "a server"} approved your request`,
        guild: d.guild,
        open: () => !d.pending_parent && d.guild?.id && selectChannel(d.guild.id, null),
      };
    case "join_declined":
      return { text: `${d.guild?.name || "A server"} declined your request to join`, guild: d.guild };
    case "friend_request":
      return { text: `${nameOf(d.from)} wants to be friends`, who: d.from, open: () => openFriend(d.from?.id || null) };
    case "friend_accepted":
      return { text: `${nameOf(d.by)} accepted your friend request`, who: d.by, open: () => openFriend(d.by?.id || null) };
    case "party_added":
      return { text: `${nameOf(d.by)} added you to the party ${d.party?.name || ""}`.trim(), who: d.by, open: () => d.party?.id && selectChannel("@parties", d.party.id) };
    case "party_removed":
      return { text: `${nameOf(d.by)} removed you from the party ${d.party?.name || ""}`.trim(), who: d.by };
    case "mention": {
      const where = d.kind === "party" ? `the party ${d.channel_name || ""}`.trim() : `#${d.channel_name || "chat"}${d.guild?.name ? ` in ${d.guild.name}` : ""}`;
      return {
        text: `${nameOf(d.from)} ${d.reply ? "replied to you" : "mentioned you"} in ${where}${d.preview ? `: “${d.preview}”` : ""}`,
        who: d.from,
        open: () => openMessage(d.kind === "party" ? "@parties" : d.guild?.id, d.channel_id, d.message_id),
      };
    }
    case "server_removed":
      return { text: `You were ${d.banned ? "banned from" : "removed from"} ${d.guild?.name || "a server"}`, guild: d.guild };
    default:
      return { text: "Something new" };
  }
}

function NoticeRow({ n, compact }: { n: Notice; compact?: boolean }) {
  const users = useStore((s) => s.users);
  const desc = describe(n);
  const [busy, setBusy] = useState(false);
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
  const open = () => {
    if (!n.read_at) markRead([n.id]);
    desc.open?.();
  };
  const d = n.data || {};
  return (
    <div className={"notice" + (n.read_at ? "" : " unread") + (compact ? " compact" : "")}>
      <button className="notice-main" onClick={open} disabled={!desc.open}>
        <span className="notice-pic">
          {desc.who ? <Avatar user={users[desc.who.id] || desc.who} size={compact ? 32 : 40} /> : desc.guild ? <GuildIcon name={desc.guild.name || "?"} iconId={desc.guild.icon_file_id || null} size={compact ? 32 : 40} /> : "🔔"}
        </span>
        <span className="notice-text">
          <span>{desc.text}</span>
          <span className="muted small">{ago(n.created_at)}</span>
        </span>
      </button>
      {!compact && (
        <span className="notice-actions">
          {n.kind === "server_invite" && (
            <>
              <button
                className="btn small primary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const r = await api(`/api/invite-cards/${d.card_id}/join`, { method: "POST" });
                    toast(`You joined ${d.guild?.name || "the server"}`);
                    selectChannel(r.guild_id, null);
                  })
                }
              >
                Join
              </button>
              <button className="btn small" disabled={busy} onClick={() => act(() => api(`/api/invite-cards/${d.card_id}/decline`, { method: "POST" }))}>
                No thanks
              </button>
            </>
          )}
          {n.kind === "join_request" && (
            <>
              <button className="btn small primary" disabled={busy} onClick={() => act(() => api(`/api/guilds/${d.guild.id}/join-requests/${d.from.id}/approve`, { method: "POST" }))}>
                Approve
              </button>
              <button className="btn small" disabled={busy} onClick={() => act(() => api(`/api/guilds/${d.guild.id}/join-requests/${d.from.id}/decline`, { method: "POST" }))}>
                Decline
              </button>
            </>
          )}
          {n.kind === "friend_request" && (
            <>
              <button className="btn small primary" disabled={busy} onClick={() => act(() => api(`/api/friends/${d.from.id}`, { method: "PUT" }))}>
                Accept
              </button>
              <button className="btn small" disabled={busy} onClick={() => act(() => api(`/api/friends/${d.from.id}`, { method: "DELETE" }))}>
                Decline
              </button>
            </>
          )}
          <button className="btn small link" title="Clear" onClick={() => clearNotice(n.id)}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

/** Home → Desks → Notifications. */
export function NotificationsDesk() {
  const list = useNotices((s) => s.list);
  const loaded = useNotices((s) => s.loaded);
  const unread = list.filter((n) => !n.read_at).length;
  return (
    <div className="desk-page in-board">
      <header className="desk-head">
        <h1>🔔 Notifications</h1>
        <div className="row gap">
          <button className="btn small" disabled={!unread} onClick={() => markRead()}>
            Mark all read
          </button>
          <button className="btn small" disabled={!list.some((n) => n.read_at)} onClick={() => clearNotice("all")}>
            Clear read
          </button>
        </div>
      </header>
      <p className="muted small">Invites, friend requests, @mentions and replies, and other things for you. Chats and voicemail stay in Talk.</p>
      <div className="notice-list">
        {list.map((n) => (
          <NoticeRow key={n.id} n={n} />
        ))}
        {loaded && !list.length && <div className="desk-empty">Nothing here right now.</div>}
      </div>
    </div>
  );
}

/** A small box on the Home board, next to Right now: the newest few. "See all" opens the list. */
export function NotificationsSection() {
  const list = useNotices((s) => s.list);
  const unread = list.filter((n) => !n.read_at);
  // nothing new: the box goes away and Right now takes the full width
  if (!unread.length) return null;
  return (
    <section className="hb-index hb-notices" data-hb-section="notifications">
      <div className="hb-notices-inner">
      <div className="hb-notices-head">
        <h2 className="hb-index-title">Notifications</h2>
        {unread.length > 0 && <span className="hb-count">{unread.length} new</span>}
        <button className="btn small link" onClick={() => openHome("notifications")}>
          See all
        </button>
      </div>
      <div className="notice-list">
        {unread.slice(0, 4).map((n) => (
          <NoticeRow key={n.id} n={n} compact />
        ))}
      </div>
      </div>
    </section>
  );
}

/** The invite card in a chat: the server, who's been invited and who's in, and Join. */
export function InviteCard({ cardId, guild: fallback }: { cardId: string; guild?: any }) {
  const rev = useNotices((s) => s.cardRev[cardId] || 0);
  const [card, setCard] = useState<any>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const users = useStore((s) => s.users);
  useEffect(() => {
    api(`/api/invite-cards/${cardId}`)
      .then(setCard)
      .catch(() => setGone(true));
  }, [cardId, rev]);
  const g = card?.guild || fallback || {};
  const act = async (path: string, done?: (r: any) => void) => {
    setBusy(true);
    try {
      const r = await api(`/api/invite-cards/${cardId}/${path}`, { method: "POST" });
      if (r?.card) setCard(r.card);
      else if (r?.id) setCard(r);
      done?.(r);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const people: any[] = card?.people || [];
  const joined = people.filter((p) => p.joined);
  const me = card?.me;
  return (
    <div className="invite-card">
      <div className="invite-card-top">
        <GuildIcon name={g.name || "?"} iconId={g.icon_file_id || null} size={48} />
        <div className="invite-card-info">
          <div className="muted small">{card?.party ? "Invite for the party" : "Server invite"}</div>
          <div className="invite-card-name">{g.name || "A server"}</div>
          {card && <div className="muted small">{card.guild.member_count} member{card.guild.member_count === 1 ? "" : "s"}</div>}
        </div>
        <div className="invite-card-act">
          {gone ? (
            <span className="muted small">No longer available</span>
          ) : me?.joined ? (
            <button className="btn small" onClick={() => selectChannel(g.id, null)}>
              Joined ✓ Open
            </button>
          ) : me ? (
            <>
              <button className="btn primary" disabled={busy} onClick={() => act("join", (r) => selectChannel(r.guild_id, null))}>
                Join
              </button>
              {!me.declined && (
                <button className="btn small link" disabled={busy} onClick={() => act("decline")}>
                  No thanks
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>
      {card?.party && people.length > 0 && (
        <div className="invite-card-progress">
          <div className="small">
            <b>
              {joined.length} of {people.length}
            </b>{" "}
            joined
          </div>
          <div className="invite-card-people">
            {people.map((p) => (
              <div key={p.user.id} className={"invite-person" + (p.joined ? " in" : "")} title={nameOf(p.user)}>
                <Avatar user={users[p.user.id] || p.user} size={28} />
                <span className="small ellipsis">{nameOf(users[p.user.id] || p.user)}</span>
                <span className="muted small">{p.joined ? "✓ joined" : p.declined ? "no thanks" : p.seen ? "seen" : "not yet"}</span>
                {card.is_inviter && !p.joined && !p.declined && (
                  <button className="btn small link" disabled={busy || p.reminded} onClick={() => act(`remind/${p.user.id}`)}>
                    {p.reminded ? "Reminded" : "Remind"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {card && !card.party && card.is_inviter && people[0] && (
        <div className="muted small invite-card-status">
          {people[0].joined ? `✓ ${nameOf(people[0].user)} joined` : people[0].declined ? `${nameOf(people[0].user)} said no thanks` : people[0].seen ? "Seen" : "Sent"}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { listeningIn, useListen } from "../listen";
import { useShows } from "../show";
import { api } from "../api";
import { sendGateway } from "../gateway";
import { refreshVoicemailCount, useVoicemailCount, VoicemailInbox } from "./VoiceMessage";
import { useCalls } from "../calls";
import { useUnreadNotices } from "../notifications";
import { can, canInvite, channelSort, currentChannelId, homeOf, isMessages, isUnread, memberName, notesForMe, openGuildView, openHome, openLibrary, openMessages, openMyProfile, selectChannel, useStore, type MsgTab } from "../store";
import { P, type Channel } from "../types";
import { copy, openMenu, openModal, toggleCollapsed, toast, useUI } from "../ui";
import { canShareScreen, joinVoice, leaveVoice, stopScreenShare, toggleCamera, toggleDeafen, toggleMute, setUserMuted, setUserVolume, userMuted, useVoice } from "../voice";
import { HearButton } from "./HearButton";
import { Avatar, BotTag, Icon } from "./common";
import { markGuildRead } from "./Shell";
import { FriendsSidebar, PartiesSidebar } from "./Friends";
import { useShallow } from "zustand/react/shallow";
import { BOARD_NAME } from "../names";
import { logout } from "../App";

export function Sidebar() {
  const gid = useStore((s) => s.selectedGuild);
  return (
    <aside className="sidebar">
      {gid === "@home" ? <HomeSidebar /> : isMessages(gid) ? <MessagesSidebar tab={gid as MsgTab} /> : gid === "@friends" ? <FriendsSidebar /> : <ChannelList guildId={gid} />}
      <VoicePanel />
      <UserPanel />
    </aside>
  );
}

function GuildHeader({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const me = useStore((s) => s.me);
  if (!guild) return null;
  const items = [
    { label: "Invite People", onClick: () => openModal({ kind: "invite", guildId }), disabled: !canInvite(guildId) },
    { label: "Server Settings", onClick: () => openModal({ kind: "serverSettings", guildId }), disabled: !can(guildId, P.MANAGE_GUILD) && !can(guildId, P.MANAGE_ROLES) && !can(guildId, P.BAN) },
    { label: "AI Bot", onClick: () => openModal({ kind: "serverSettings", guildId, tab: "bot" }), disabled: !can(guildId, P.MANAGE_GUILD) },
    { separator: true, label: "" },
    { label: "Add a Space", onClick: () => openModal({ kind: "createChannel", guildId }), disabled: !can(guildId, P.MANAGE_CHANNELS) },
    { label: "Make a Group", onClick: () => openModal({ kind: "createChannel", guildId, channelKind: "category" }), disabled: !can(guildId, P.MANAGE_CHANNELS) },
    { label: "Mark As Read", onClick: () => markGuildRead(guildId) },
    { separator: true, label: "" },
    {
      label: "Leave Server",
      danger: true,
      disabled: guild.owner_id === me?.id,
      onClick: () =>
        openModal({
          kind: "confirm",
          title: `Leave '${guild.name}'`,
          body: "You won't be able to rejoin unless you are re-invited.",
          danger: true,
          confirmLabel: "Leave Server",
          onConfirm: () => api(`/api/guilds/${guildId}/members/@me`, { method: "DELETE" }),
        }),
    },
  ];
  return (
    <button className="sidebar-header" onClick={(e) => openMenu({ clientX: e.currentTarget.getBoundingClientRect().left + 8, clientY: e.currentTarget.getBoundingClientRect().bottom + 4 }, items)}>
      <span className="ellipsis">{guild.name}</span>
      <Icon name="chevron" size={18} />
    </button>
  );
}

/** Each kind of space has a full-color mark: 💬 chat, 🔊 voice & video, 🍿 watch party. */
export function spaceEmoji(kind: string): string {
  return kind === "voice" ? "🔊" : kind === "watch" ? "🍿" : "💬";
}

/** The type headings spaces sort under by themselves (unless they're in a group). */
const TYPE_GROUPS: { kind: Channel["kind"]; label: string }[] = [
  { kind: "text", label: "Chat" },
  { kind: "voice", label: "Voice & Video" },
  { kind: "watch", label: "Watch" },
];

/** What's being dragged in the space list (a space, or a group to reorder). */
let dragging: { id: string; group: boolean } | null = null;

async function moveTo(spaceId: string, groupId: string | null) {
  try {
    await api(`/api/channels/${spaceId}`, { method: "PATCH", body: { parent_id: groupId } });
  } catch (e: any) {
    toast(e.message, "error");
  }
}

/** Put a group just before another one (drag a group's heading onto another's). */
async function reorderGroup(guildId: string, id: string, before: string) {
  const s = useStore.getState();
  const groups = Object.values(s.channels)
    .filter((c) => c.guild_id === guildId && c.kind === "category" && c.id !== id)
    .sort((a, b) => a.position - b.position);
  const at = groups.findIndex((g) => g.id === before);
  const moved = s.channels[id];
  if (!moved) return;
  groups.splice(at < 0 ? groups.length : at, 0, moved);
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].position !== i) await api(`/api/channels/${groups[i].id}`, { method: "PATCH", body: { position: i } }).catch(() => {});
  }
}

function ChannelList({ guildId }: { guildId: string }) {
  const channels = useStore((s) => s.channels);
  const sort = channelSort(useStore.getState());
  const list = Object.values(channels).filter((c) => c.guild_id === guildId).sort(sort);
  const groups = list.filter((c) => c.kind === "category").sort((a, b) => a.position - b.position);
  const loose = list.filter((c) => c.kind !== "category" && (!c.parent_id || !channels[c.parent_id]));
  const collapsed = useUI((s) => s.collapsed);
  const manage = can(guildId, P.MANAGE_CHANNELS);
  const [over, setOver] = useState<string | null>(null);
  const voiceIn = useVoice((v) => v.channelId);
  const openChat = useStore((s) => currentChannelId(s));

  // drop targets: a type heading = out of any group; a group = into it (or before it, for a group)
  const dropProps = (target: string, groupId: string | null) =>
    manage
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!dragging || (dragging.group && !groupId)) return;
            e.preventDefault();
            setOver(target);
          },
          onDragLeave: () => setOver((o) => (o === target ? null : o)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setOver(null);
            const d = dragging;
            dragging = null;
            if (!d) return;
            if (d.group) groupId && d.id !== groupId && reorderGroup(guildId, d.id, groupId);
            else if ((channels[d.id]?.parent_id || null) !== groupId) moveTo(d.id, groupId);
          },
        }
      : {};

  const section = (key: string, label: string, kids: Channel[], group: Channel | null) => {
    // a group with a space you're in (a room you've joined, or the chat you have open, where
    // your name shows) can't be collapsed: no arrow, and it stays open
    const pinned = kids.some((c) => c.id === voiceIn || c.id === openChat);
    const isCollapsed = !pinned && collapsed[key];
    // collapsed hides everything under it; the heading shows a dot if something's new in there
    const newInside = isCollapsed && kids.some((c) => isUnread(c));
    return (
      <div key={key} className={"category" + (over === key ? " drop-over" : "")} {...dropProps(key, group?.id ?? null)}>
        <div
          className={"category-head" + (group ? " custom" : "")}
          draggable={!!group && manage}
          onDragStart={() => group && (dragging = { id: group.id, group: true })}
          onDragEnd={() => (dragging = null)}
          onClick={() => !pinned && toggleCollapsed(key)}
          onContextMenu={(e) =>
            manage &&
            group &&
            openMenu(e, [
              { label: "Add a Space here", onClick: () => openModal({ kind: "createChannel", guildId, parentId: group.id }) },
              { label: "Rename Group", onClick: () => openModal({ kind: "editChannel", channelId: group.id }) },
              {
                label: "Delete Group",
                danger: true,
                onClick: () =>
                  openModal({
                    kind: "confirm",
                    title: `Delete the group '${group.name}'?`,
                    body: "Its spaces aren't deleted: they go back under their type (Chat, Voice & Video, Watch).",
                    confirmLabel: "Delete Group",
                    onConfirm: () => api(`/api/channels/${group.id}`, { method: "DELETE" }),
                  }),
              },
            ])
          }
        >
          {pinned ? <span className="cat-arrow-space" /> : <Icon name="chevron" size={12} className={isCollapsed ? "rot" : ""} />}
          <span>{label}</span>
          {newInside && <span className="cat-new" title="Something new in here" />}
          {manage && group && (
            <button
              className="icon-btn tiny"
              title="Add a Space here"
              onClick={(e) => {
                e.stopPropagation();
                openModal({ kind: "createChannel", guildId, parentId: group.id });
              }}
            >
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>
        {!isCollapsed &&
          kids.map((c) => (
            <ChannelRow key={c.id} ch={c} />
          ))}
      </div>
    );
  };

  const spacesMenu = (e: React.MouseEvent) =>
    openMenu({ clientX: e.currentTarget.getBoundingClientRect().left, clientY: e.currentTarget.getBoundingClientRect().bottom + 4 }, [
      { label: "Add a Space", onClick: () => openModal({ kind: "createChannel", guildId }) },
      { label: "Make a Group", onClick: () => openModal({ kind: "createChannel", guildId, channelKind: "category" }) },
    ]);

  return (
    <>
      <GuildHeader guildId={guildId} />
      <div className="channel-scroll">
        <BoardRows guildId={guildId} />
        <div className="spaces-head">
          <span>Spaces</span>
          {manage && (
            <button className="icon-btn tiny" title="Add a Space or make a group" onClick={spacesMenu}>
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>
        {TYPE_GROUPS.map((t) => {
          const kids = loose.filter((c) => c.kind === t.kind).sort((a, b) => a.position - b.position);
          return kids.length ? section(guildId + ":type:" + t.kind, t.label, kids, null) : null;
        })}
        {/* anything of a kind without its own heading */}
        {loose.filter((c) => !TYPE_GROUPS.some((t) => t.kind === c.kind)).map((c) => (
          <ChannelRow key={c.id} ch={c} />
        ))}
        {groups.map((g) =>
          section(
            g.id,
            g.name,
            list.filter((c) => c.parent_id === g.id).sort((a, b) => a.position - b.position),
            g,
          ),
        )}
      </div>
    </>
  );
}

/** Space → Move to…: a group, out of any group, or a new group. */
export function moveToMenu(e: React.MouseEvent, ch: Channel) {
  const s = useStore.getState();
  const groups = Object.values(s.channels)
    .filter((c) => c.guild_id === ch.guild_id && c.kind === "category")
    .sort((a, b) => a.position - b.position);
  openMenu(e, [
    ...groups.map((g) => ({ label: (ch.parent_id === g.id ? "✓ " : "") + g.name, onClick: () => moveTo(ch.id, g.id), disabled: ch.parent_id === g.id })),
    { label: "No group (under " + (TYPE_GROUPS.find((t) => t.kind === ch.kind)?.label || "its type") + ")", onClick: () => moveTo(ch.id, null), disabled: !ch.parent_id },
    { separator: true, label: "" },
    {
      label: "New group…",
      onClick: () =>
        openModal({
          kind: "prompt",
          title: "New group",
          label: "Group name",
          placeholder: "Gaming",
          confirmLabel: "Make it and move",
          onSubmit: (name: string) =>
            api(`/api/channels/${ch.id}`, { method: "PATCH", body: { new_category: name } })
              .then(() => {})
              .catch((er: any) => toast(er.message, "error")),
        }),
    },
  ]);
}

/** The server's board, at the top of its channel list. */
function BoardRows({ guildId }: { guildId: string }) {
  const open = useStore((s) => s.selectedGuild === guildId && !!s.guildView[guildId]);
  const filter = useStore((s) => s.boardFilter[guildId] ?? "all");
  const unread = useStore((s) => notesForMe(s).filter((n) => n.guild_id === guildId && !n.read).length);
  return (
    <div className="board-rows">
      <div className={"channel" + (open && filter === "all" ? " active" : "")} onClick={() => openGuildView(guildId)}>
        <span className="channel-emoji">📌</span>
        <span className="ellipsis">{BOARD_NAME}</span>
      </div>
      <div className={"channel sub" + (open && filter === "notes" ? " active" : "") + (unread ? " unread" : "")} onClick={() => openGuildView(guildId, "notes")}>
        <span className="ellipsis">Notes</span>
        {unread > 0 && <span className="badge inline">{unread}</span>}
      </div>
      <div className={"channel sub" + (open && filter === "highlights" ? " active" : "")} onClick={() => openGuildView(guildId, "highlights")}>
        <span className="ellipsis">Highlights</span>
      </div>
      <div className={"channel sub" + (open && filter === "news" ? " active" : "")} onClick={() => openGuildView(guildId, "news")}>
        <span className="ellipsis">News</span>
      </div>
      <div className="channel sub soon" title="Game nights and shows, with RSVPs and reminders (coming soon)">
        <span className="ellipsis">Events</span>
        <span className="soon-tag">soon</span>
      </div>
    </div>
  );
}

function ChannelRow({ ch }: { ch: Channel }) {
  const active = useStore((s) => currentChannelId(s) === ch.id);
  const unread = useStore((s) => ch.kind === "text" && isUnread(ch, s));
  const mentions = useStore((s) => s.mentions[ch.id] || 0);
  const manage = can(ch.guild_id, P.MANAGE_CHANNELS);
  const voiceStates = useStore((s) => s.voiceStates);
  const room = ch.kind === "voice" || ch.kind === "watch";
  const inThis = useVoice((v) => v.channelId === ch.id);
  const friends = useStore((s) => s.friends);
  const me = useStore((s) => s.me?.id);
  const readers = useStore((s) => (ch.kind === "text" ? s.viewers[ch.id] : undefined));
  // who's here: in a room, everyone on the call; in a chat, everyone reading it
  const allHere = room ? Object.values(voiceStates).filter((v) => v.channel_id === ch.id) : (readers || []).map((u) => ({ user_id: u }) as any);
  const isFriend = (u: string) => friends[u]?.state === "friend";
  // in it yourself (the chat is open / you joined the room): everyone, friends first.
  // Otherwise: your friends by name, and a count for everyone else.
  const inside = room ? inThis : active;
  const sorted = [...allHere].sort((a, b) => Number(isFriend(b.user_id)) - Number(isFriend(a.user_id)));
  const voiceUsers = inside ? sorted : sorted.filter((v) => isFriend(v.user_id) || v.user_id === me);
  const others = allHere.length - voiceUsers.length;
  const speaking = useVoice((v) => v.speaking);
  const users = useStore((s) => s.users);

  const onClick = () => {
    selectChannel(ch.guild_id!, ch.id);
    // rooms (voice and Watch Party): clicking one goes in
    if ((ch.kind === "voice" || ch.kind === "watch") && !inThis) joinVoice(ch.id).catch((e: any) => toast(e.message, "error"));
  };
  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: "Mark As Read", onClick: () => ch.last_message_id && api(`/api/channels/${ch.id}/ack`, { body: { message_id: ch.last_message_id } }), disabled: ch.kind !== "text" },
      { label: "Edit Space", onClick: () => openModal({ kind: "editChannel", channelId: ch.id }), disabled: !manage },
      ...(manage ? [{ label: "Move to…", onClick: () => setTimeout(() => moveToMenu(e, ch), 0) }] : []),
      {
        label: ch.locked ? "🔓 Unlock Space" : "🔒 Lock Space",
        onClick: () => api(`/api/channels/${ch.id}/lock`, { body: { locked: !ch.locked } }).catch((e) => toast(e.message, "error")),
        disabled: !manage && !can(ch.guild_id, P.LOCK_SPACES),
      },
      {
        label: "Delete Space",
        danger: true,
        disabled: !manage,
        onClick: () =>
          openModal({
            kind: "confirm",
            title: "Delete Space",
            body: `Are you sure you want to delete ${ch.kind === "text" ? "#" : ""}${ch.name}? This can't be undone.`,
            danger: true,
            confirmLabel: "Delete Space",
            onConfirm: () => api(`/api/channels/${ch.id}`, { method: "DELETE" }),
          }),
      },
      { separator: true, label: "" },
      { label: "Copy Space ID", onClick: () => copy(ch.id, "ID copied") },
    ]);

  return (
    <>
      <div
        className={"channel" + (active ? " active" : "") + (unread ? " unread" : "")}
        data-cid={ch.id}
        onClick={onClick}
        onContextMenu={menu}
        draggable={manage}
        onDragStart={() => (dragging = { id: ch.id, group: false })}
        onDragEnd={() => (dragging = null)}
        title={ch.kind === "text" ? "Chat space" : ch.kind === "voice" ? "Voice & Video space" : ch.kind === "watch" ? "Watch Party space" : undefined}
      >
        {unread && !active && <span className="unread-pip" />}
        <span className="channel-icon channel-emoji-icon">{spaceEmoji(ch.kind)}</span>
        <span className="ellipsis">{ch.name}</span>
        {ch.locked && <span title="Locked: only staff can go in">🔒</span>}
        {ch.kind === "voice" && <RecBadge channelId={ch.id} />}
        {mentions > 0 && <span className="badge inline">{mentions}</span>}
        {manage && (
          <button
            className="icon-btn tiny hover-only"
            title="Edit Space"
            onClick={(e) => {
              e.stopPropagation();
              openModal({ kind: "editChannel", channelId: ch.id });
            }}
          >
            <Icon name="gear" size={14} />
          </button>
        )}
      </div>
      {voiceUsers.length > 0 && (
        <div className="voice-users">
          {voiceUsers.map((v) => (
            <div key={v.user_id} className="voice-user" onContextMenu={(e) => userMenu(e, v.user_id, ch.guild_id)}>
              <Avatar user={users[v.user_id]} size={22} speaking={inThis && speaking.includes(v.user_id)} />
              <span className="ellipsis">{memberName(ch.guild_id, users[v.user_id])}</span>
              {v.screen && <span className="live-tag">LIVE</span>}
              {v.video && <Icon name="video" size={14} />}
              {v.muted && <Icon name="micOff" size={14} className="red" />}
              {v.deafened && <Icon name="deaf" size={14} className="red" />}
              {v.friends_only && (
                <span title="Friends only: only their friends hear them" className="vu-mark">
                  <Icon name="usersHeart" size={14} className="green" />
                </span>
              )}
              {v.user_id !== me && userMuted(v.user_id) && (
                <span title="Muted by you" className="vu-mark">
                  <Icon name="speakerOff" size={14} className="red" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {others > 0 && (
        <div className="here-tag muted small" title={room ? "In this room" : "Reading this chat now"}>
          {voiceUsers.length ? `+${others} other${others > 1 ? "s" : ""}` : `${others} here`}
        </div>
      )}
    </>
  );
}

export function userMenu(e: React.MouseEvent, userId: string, guildId: string | null) {
  const s = useStore.getState();
  const me = s.me!;
  const user = s.users[userId];
  const items: any[] = [
    { label: "Profile", onClick: () => openModal({ kind: "profile", userId, guildId }) },
  ];
  if (userId !== me.id) {
    items.push({
      label: "Message",
      onClick: async () => {
        try {
          const dm = user?.is_bot ? await api("/api/bot/dm", { method: "POST" }) : await api("/api/users/@me/channels", { body: { recipient_id: userId } });
          selectChannel("@me", dm.id);
        } catch (err: any) {
          toast(err.message, "error");
        }
      },
    });
  }
  if (userId !== me.id && !user?.is_bot) {
    const f = s.friends[userId]?.state;
    if (!f)
      items.push({
        label: "Add friend",
        onClick: () =>
          api("/api/friends", { body: { user_id: userId } })
            .then((r) => toast(r.state === "friend" ? "You're friends now" : "Friend request sent"))
            .catch((err) => toast(err.message, "error")),
      });
    else if (f === "incoming")
      items.push({ label: "Accept friend request", onClick: () => api(`/api/friends/${userId}`, { method: "PUT" }).catch((err) => toast(err.message, "error")) });
    else if (f === "outgoing") items.push({ label: "Friend request sent", onClick: () => {} });
  }
  const inVoice = useVoice.getState().channelId && s.voiceStates[userId]?.channel_id === useVoice.getState().channelId;
  if (inVoice && userId !== me.id) {
    const vol = Math.min(1, Number(localStorage.getItem("llamble.vol." + userId) || "1"));
    items.push({
      label: "",
      render: () => <VolumeSlider userId={userId} initial={vol} />,
    });
  }
  if (guildId && userId !== me.id) {
    const g = s.guilds[guildId];
    items.push({ separator: true, label: "" });
    if (can(guildId, P.MANAGE_ROLES)) items.push({ label: "Roles…", onClick: () => openModal({ kind: "profile", userId, guildId }) });
    if (can(guildId, P.KICK) && g.owner_id !== userId)
      items.push({
        label: `Kick ${user?.display_name}`,
        danger: true,
        onClick: () =>
          openModal({ kind: "confirm", title: `Kick ${user?.display_name}`, body: "They can rejoin with a new invite.", danger: true, confirmLabel: "Kick", onConfirm: () => api(`/api/guilds/${guildId}/members/${userId}`, { method: "DELETE" }) }),
      });
    if (can(guildId, P.BAN) && g.owner_id !== userId)
      items.push({
        label: `Ban ${user?.display_name}`,
        danger: true,
        onClick: () =>
          openModal({ kind: "confirm", title: `Ban ${user?.display_name}`, body: "They will be removed and can't rejoin.", danger: true, confirmLabel: "Ban", onConfirm: () => api(`/api/guilds/${guildId}/bans/${userId}`, { method: "PUT", body: {} }) }),
      });
  }
  if (guildId && can(guildId, P.MANAGE_GUILD) && userId !== useStore.getState().me?.id)
    items.push({
      label: `Delete all of ${user?.display_name}'s messages`,
      danger: true,
      onClick: () =>
        openModal({
          kind: "confirm",
          title: `Delete everything ${user?.display_name} wrote here?`,
          body: "Removes all their messages in every space of this server. This can't be undone.",
          danger: true,
          confirmLabel: "Delete all",
          onConfirm: () => api(`/api/guilds/${guildId}/members/${userId}/messages`, { method: "DELETE" }).then((r) => toast(`Deleted ${r.deleted} messages`)),
        }),
    });
  items.push({ separator: true, label: "" }, { label: "Copy User ID", onClick: () => copy(userId, "ID copied") });
  openMenu(e, items);
}

/** Their volume just for me, and a Mute button beside it (both remembered on this device). */
function VolumeSlider({ userId, initial }: { userId: string; initial: number }) {
  const [vol, setVol] = useState(initial);
  const [muted, setMuted] = useState(userMuted(userId));
  return (
    <div className="ctx-volume" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="ctx-volume-head">
        <span>User Volume</span>
        <span className="muted">{muted ? "Muted" : `${Math.round(vol * 100)}%`}</span>
      </div>
      <div className="ctx-volume-row">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={vol}
          disabled={muted}
          aria-label="User volume"
          onChange={(e) => {
            const n = Number(e.target.value);
            setVol(n);
            setUserVolume(userId, n);
          }}
        />
        <button
          className={"btn small" + (muted ? " red" : "")}
          onClick={() => {
            setUserMuted(userId, !muted);
            setMuted(!muted);
          }}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
      </div>
    </div>
  );
}

/** Sidebar while Home is open: nothing in the list area, just the bottom panel. */
/** Home's left column: the board and its parts, then things coming to Home. */
function HomeSidebar() {
  const page = useStore((s) => s.homePage);
  const filter = useStore((s) => (s.homePage === "board" ? s.boardFilter["@home"] ?? "all" : null));
  const unread = useStore((s) => notesForMe(s).filter((n) => !n.read).length);
  const notices = useUnreadNotices();
  const soon = (emoji: string, label: string, what: string) => (
    <div className="channel soon" title={what + " (coming soon)"}>
      <span className="channel-emoji">{emoji}</span>
      <span className="ellipsis">{label}</span>
      <span className="soon-tag">soon</span>
    </div>
  );
  return (
    <>
      <div className="sidebar-header static">Home</div>
      <div className="channel-scroll">
        <div className="board-rows">
          <div className={"channel" + (filter === "all" ? " active" : "")} onClick={() => openHome("all")}>
            <span className="channel-emoji">📌</span>
            <span className="ellipsis">{BOARD_NAME}</span>
          </div>
          <div className={"channel sub" + (filter === "notes" ? " active" : "") + (unread ? " unread" : "")} onClick={() => openHome("notes")}>
            <span className="ellipsis">Notes</span>
            {unread > 0 && <span className="badge inline">{unread}</span>}
          </div>
          <div className={"channel sub" + (filter === "highlights" ? " active" : "")} onClick={() => openHome("highlights")}>
            <span className="ellipsis">Highlights</span>
          </div>
          <div className={"channel sub" + (filter === "news" ? " active" : "")} onClick={() => openHome("news")}>
            <span className="ellipsis">News</span>
          </div>
          <div className={"channel sub" + (filter === "notifications" ? " active" : "") + (notices ? " unread" : "")} onClick={() => openHome("notifications")} title="Invites, friend requests and other things for you">
            <span className="ellipsis">Notifications</span>
            {notices > 0 && <span className="badge inline">{notices}</span>}
          </div>
          <div className="channel sub soon" title="Game nights and shows, with RSVPs and reminders (coming soon)">
            <span className="ellipsis">Events</span>
            <span className="soon-tag">soon</span>
          </div>
        </div>
        <div className="sidebar-sep" />
        <div className={"channel" + (page === "profile" ? " active" : "")} onClick={() => openMyProfile()} title="How others see you: picture, name, about me, banner">
          <span className="channel-emoji">🪪</span>
          <span className="ellipsis">My profile</span>
        </div>
        <div className={"channel" + (page === "library" ? " active" : "")} onClick={() => openLibrary()} title="Your recordings (your files and post history come later)">
          <span className="channel-emoji">📚</span>
          <span className="ellipsis">My Media</span>
        </div>
        {soon("🎮", "Games", "Your games, who's playing, start one with friends")}
        {soon("🧩", "Apps", "Soundboard packs, GIF packs, board themes, bots")}
        {soon("🛍️", "Store", "The Llamble store")}
        <div className="sidebar-sep" />
        {soon("🛟", "Help Desk", "Report a problem or ask for help")}
      </div>
    </>
  );
}

/** Talk: Direct | Parties | Voicemail, one list at a time. Every row has its call button. */
function MessagesSidebar({ tab }: { tab: MsgTab }) {
  const dms = useStore((s) => Object.values(s.channels).filter((c) => c.kind === "dm" && isUnread(c, s)).length);
  const parties = useStore((s) => Object.values(s.channels).filter((c) => c.kind === "party" && isUnread(c, s)).length);
  const vm = useVoicemailCount((s) => s.n);
  const tabs: [MsgTab, string, number][] = [
    ["@me", "Direct", dms],
    ["@parties", "Parties", parties],
    ["@voicemail", "Voicemail", vm],
  ];
  return (
    <>
      <div className="sidebar-header static">
        <span className="grow">Talk</span>
        {tab === "@me" && (
          <button className="icon-btn small" title="New message" aria-label="New message" onClick={() => openModal({ kind: "newDm" })}>
            <Icon name="plus" size={16} />
          </button>
        )}
        {tab === "@parties" && (
          <button className="icon-btn small" title="New party" aria-label="New party" onClick={() => openModal({ kind: "party" })}>
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>
      <div className="msg-tabs" role="tablist">
        {tabs.map(([t, label, n]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={"msg-tab" + (tab === t ? " on" : "")} onClick={() => openMessages(t)}>
            {label}
            {n > 0 && <span className="badge inline">{n}</span>}
          </button>
        ))}
      </div>
      {tab === "@me" ? <DmList /> : tab === "@parties" ? <PartiesSidebar bare /> : <VoicemailInbox />}
    </>
  );
}


function DmList() {
  const channels = useStore((s) => s.channels);
  const me = useStore((s) => s.me);
  const bot = useStore((s) => s.config.bot);
  const selected = useStore((s) => currentChannelId(s));
  const dms = Object.values(channels)
    .filter((c) => c.kind === "dm")
    .sort((a, b) => (b.last_message_id || b.id).localeCompare(a.last_message_id || a.id));
  const hasBotDm = dms.some((d) => d.recipients?.some((r) => r.is_bot));
  return (
    <>
      <div className="channel-scroll">
        {bot && !hasBotDm && (
          <div
            className="dm-row"
            onClick={async () => {
              const dm = await api("/api/bot/dm", { method: "POST" });
              selectChannel("@me", dm.id);
            }}
          >
            <div className="avatar-fallback round bot-av">
              <Icon name="bot" size={18} />
            </div>
            <span>Chat with {bot.name}</span>
          </div>
        )}
        {dms.map((dm) => {
          const other = dm.recipients?.find((r) => r.id !== me?.id) || dm.recipients?.[0];
          return <DmRow key={dm.id} ch={dm} active={selected === dm.id} other={other} />;
        })}
        {dms.length === 0 && <p className="muted small pad">No conversations yet. Press + to message someone.</p>}
      </div>
    </>
  );
}

/** The call button on a Talk row: one tap calls (or returns to the call you're in with them). */
export function RowCall({ channelId, name }: { channelId: string; name: string }) {
  const inThis = useVoice((v) => v.channelId === channelId);
  return (
    <button
      className={"row-call" + (inThis ? " live" : "")}
      title={inThis ? "Back to the call" : `Call ${name}`}
      aria-label={inThis ? "Back to the call" : `Call ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        import("../calls").then((c) => (inThis ? c.showCallScreen() : c.startCall(channelId)));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!inThis) openMenu(e, [{ label: "Call", onClick: () => import("../calls").then((c) => c.startCall(channelId)) }, { label: "Urgent call", danger: true, onClick: () => import("../calls").then((c) => c.urgentCall({ channelId, name })) }]);
      }}
    >
      <Icon name="phone" size={16} />
    </button>
  );
}

function DmRow({ ch, active, other }: { ch: Channel; active: boolean; other: any }) {
  const unread = useStore((s) => isUnread(ch, s));
  const mentions = useStore((s) => s.mentions[ch.id] || 0);
  const user = useStore((s) => (other ? s.users[other.id] || other : undefined));
  return (
    <div className={"dm-row" + (active ? " active" : "") + (unread ? " unread" : "")} data-cid={ch.id} onClick={() => selectChannel("@me", ch.id)} onContextMenu={(e) => user && userMenu(e, user.id, null)}>
      <Avatar user={user} size={32} status />
      <span className="ellipsis">{user?.display_name ?? "Unknown"}</span>
      {user?.is_bot && <BotTag />}
      {mentions > 0 && <span className="badge inline">{mentions}</span>}
      {!user?.is_bot && <RowCall channelId={ch.id} name={user?.display_name ?? "them"} />}
    </div>
  );
}

function VoicePanel() {
  const v = useVoice();
  const channel = useStore((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const guild = useStore((s) => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined));
  const recipient = useStore((s) => (channel?.kind === "dm" ? channel.recipients?.find((r) => r.id !== s.me?.id) : undefined));
  const ringing = useCalls((c) => !!c.outgoing && c.outgoing.channel_id === v.channelId);
  if (v.status === "idle" && !v.error) return null;
  if (v.status === "idle" && v.error) {
    return (
      <div className="voice-panel error">
        <span>{v.error}</span>
        <button className="icon-btn" onClick={() => useVoice.setState({ error: null })}>
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }
  const label = ringing ? "Calling…" : v.status === "connected" ? "Voice Connected" : v.status === "reconnecting" ? "Reconnecting…" : "Connecting…";
  return (
    <div className="voice-panel">
      <div className="voice-panel-top">
        <div className="voice-status" onClick={() => (channel?.kind === "dm" || channel?.kind === "party" || !channel ? import("../calls").then((m) => m.showCallScreen()) : selectChannel(homeOf(channel), channel.id))}>
          <div className={"voice-label " + v.status}>
            <Icon name={channel?.kind === "dm" || channel?.kind === "party" || !channel ? "phone" : "speaker"} size={14} /> {channel?.kind === "dm" || channel?.kind === "party" || !channel ? label.replace("Voice Connected", "In a call") : label}
          </div>
          <div className="muted small ellipsis">{!channel ? "Added to a call" : channel.kind === "dm" ? `Call with ${recipient?.display_name ?? ""}` : channel.kind === "party" ? `Party · ${channel.name}` : `${channel.name} / ${guild?.name ?? ""}`}</div>
        </div>
        <button className="icon-btn" title="Disconnect" onClick={() => leaveVoice()}>
          <Icon name="phoneOff" size={20} />
        </button>
      </div>
      {v.error && <div className="voice-error small">{v.error}</div>}
      <ListeningLine channelId={v.channelId} />
      {channel?.kind === "watch" ? null : (
      <div className="voice-panel-btns">
        <button className={"vbtn" + (v.camera ? " on" : "")} disabled={!v.canVideo} onClick={toggleCamera} title="Camera">
          <Icon name={v.camera ? "video" : "videoOff"} size={18} /> Video
        </button>
        <button
          className={"vbtn" + (v.screen ? " on" : "")}
          disabled={!v.canVideo || (!v.screen && !canShareScreen())}
          onClick={() => (v.screen ? stopScreenShare() : window.llambleNative ? openModal({ kind: "screenPicker" }) : import("../voice").then((m) => m.startScreenShare("", true, m.defaultShareQuality())))}
          title={canShareScreen() ? "Share your screen" : "This device can't share its screen"}
        >
          <Icon name="screen" size={18} /> {v.screen ? "Stop" : "Screen"}
        </button>
      </div>
      )}
    </div>
  );
}

const STATUS_LABEL = { online: "🟢 Online", idle: "🌙 Idle", dnd: "⛔ Do Not Disturb", invisible: "⚪ Invisible" } as const;

function UserPanel() {
  const me = useStore((s) => s.me);
  const my = useStore((s) => s.myStatus);
  const v = useVoice();
  const setMine = (next: Partial<typeof my>) => {
    const m = { ...useStore.getState().myStatus, ...next };
    localStorage.setItem("llamble.status", m.status);
    sendGateway("presence", next);
    useStore.setState((s) => ({ myStatus: m, presences: { ...s.presences, [me!.id]: m.status === "invisible" ? "offline" : m.status } }));
  };
  const statusMenu = (e: React.MouseEvent) =>
    openMenu(
      e,
      (["online", "idle", "dnd", "invisible"] as const)
        .map((st) => ({
          label: (my.status === st ? "✓ " : "") + STATUS_LABEL[st] + (st === "invisible" ? " (look offline)" : ""),
          onClick: () => setMine({ status: st }),
        }))
        .concat([
          { separator: true, label: "" } as any,
          { label: (my.hide_activity ? "✓ " : "") + "🙈 Hide what I'm doing", onClick: () => setMine({ hide_activity: !my.hide_activity }) },
          { separator: true, label: "" } as any,
          { label: "Log Out", onClick: logout, danger: true } as any,
        ]),
    );
  if (!me) return null;
  return (
    <div className="user-panel">
      <div className="user-panel-me" onClick={statusMenu}>
        <Avatar user={me} size={32} status />
        <div className="user-panel-names">
          <div className="ellipsis bold">{me.display_name}</div>
          <div className="ellipsis muted small" title="Tap to change your status">
            {STATUS_LABEL[my.status]}
            {my.hide_activity ? " · hidden" : ""} ▾
          </div>
        </div>
      </div>
      <button className={"icon-btn" + (v.muted ? " red" : "")} title={v.muted ? "Unmute (Ctrl+Shift+M)" : "Mute (Ctrl+Shift+M)"} onClick={toggleMute}>
        <Icon name={v.muted ? "micOff" : "mic"} size={18} />
      </button>
      {v.channelId && <HearButton />}
      <button className={"icon-btn" + (v.deafened ? " red" : "")} title={v.deafened ? "Undeafen (Ctrl+Shift+D)" : "Deafen (Ctrl+Shift+D)"} onClick={toggleDeafen}>
        <Icon name={v.deafened ? "deaf" : "headphones"} size={18} />
      </button>
      <button className="icon-btn" title="User Settings" onClick={() => openModal({ kind: "userSettings" })}>
        <Icon name="gear" size={18} />
      </button>
    </div>
  );
}

function RecBadge({ channelId }: { channelId: string }) {
  const st = useShows((s) => s.status[channelId]);
  return st === "recording" ? <span className="rec-badge" title="This call is being recorded">REC</span> : null;
}

/** Always visible while in a call where Llamble listens (even from a text channel). */
function ListeningLine({ channelId }: { channelId: string | null }) {
  useStore((s) => s.config);
  const heard = useListen((s) => s.heard);
  const bot = useStore((s) => s.config.bot?.name || "Llamble");
  if (!listeningIn(channelId)) return null;
  return (
    <div className="listen-side small" title={heard ? `Last heard from you: "${heard.text}"` : `Say "Hey ${bot}"`}>
      👂 {bot} is listening
    </div>
  );
}

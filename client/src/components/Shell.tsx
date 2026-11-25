import { RecordingBar } from "./RecordingBar";
import { refreshVoicemailCount, UrgentAlert, useVoicemailCount, VoicemailPage } from "./VoiceMessage";
import { CallScreens, CallStrip } from "./Calls";
import { useEffect, useState } from "react";
import { api, media as mediaSrc } from "../api";
import { usePeopleName } from "../store";
import { openServersSeen } from "./Discover";
import { can, canInvite, currentChannelId, homeOf, isMessages, isUnread, onEvent, openFriend, openGuildView, openHome, openMessages, selectChannel, showMobileNav, useStore } from "../store";
import { isPhone, useIsPhone, wireSwipe } from "../phone";
import { boardHasNew, useAnyBoardNew, useBoardHasNew } from "../boardnew";
import { Board, useUnreadNotes } from "./Home";
import { InvisibleGate, LockedSpace, WatchView } from "./Watch";
import { useUnreadNotices } from "../notifications";
import { P } from "../types";
import { copy, openMenu, openModal, toast, useUI } from "../ui";
import { useVoice } from "../voice";
import { ChatView } from "./ChatView";
import { ContextMenu, GuildIcon, Icon, Toasts } from "./common";
import { MemberList } from "./MemberList";
import { PopoutOverlay } from "./Overlay";
import { Popouts } from "./Popouts";
import { ShowPrompts } from "./Show";
import { Modals } from "./Modals";
import { notifyResetRequest } from "./Recovery";
import { Sidebar } from "./Sidebar";
import { VoiceView } from "./VoiceView";
import { PracticeVoice, PracticeWatch, TutorialGuide } from "./Tutorial";
import { isPracticeRoom } from "../tutorial";
import { Library } from "./Library";
import { MyProfile } from "./Profile";
import { FriendProfile, PartiesEmpty, PartyMembers, PartyView } from "./Friends";
import { androidSend, isAndroidApp, useAndroidUpdate } from "../android";

export function Shell() {
  const ready = useStore((s) => s.ready);
  const conn = useStore((s) => s.conn);
  const channelId = useStore((s) => currentChannelId(s));
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  // a locked space: only staff can open it (people already in its room stay)
  const inItsRoom = useVoice((v) => !!channel && v.channelId === channel.id);
  const invisibleGate = useStore((s) => s.myStatus.status === "invisible") && channel?.kind === "text" && !!channel.guild_id;
  const lockedOut = !!channel?.locked && !!channel.guild_id && !inItsRoom && !can(channel.guild_id, P.LOCK_SPACES) && !can(channel.guild_id, P.MANAGE_CHANNELS);
  const memberListOpen = useStore((s) => s.memberListOpen);
  const selectedGuild = useStore((s) => s.selectedGuild);
  const guildsForBack = useStore((s) => s.guilds);
  const peopleNameForBack = usePeopleName();
  const homePage = useStore((s) => s.homePage);
  const mobileMain = useStore((s) => s.mobileMain);
  const mobile = useIsPhone();
  // phones: the member list slides over the chat when asked for, so it starts closed
  useEffect(() => {
    if (mobile) useStore.setState({ memberListOpen: false });
  }, [mobile]);
  // phones: swipe right for the menu (servers and channels), left to go back to the page
  useEffect(() => {
    if (!mobile) return;
    return wireSwipe(
      () => {
        const ui = useUI.getState();
        if (ui.menu || ui.modals.length || !useStore.getState().mobileMain) return;
        // the people list slid over a chat closes first
        if (useStore.getState().memberListOpen) return useStore.setState({ memberListOpen: false });
        showMobileNav(true);
      },
      () => {
        const ui = useUI.getState();
        if (ui.menu || ui.modals.length || useStore.getState().mobileMain) return;
        showMobileNav(false);
      },
    );
  }, [mobile]);
  const guildView = useStore((s) => s.guildView[s.selectedGuild]);
  const [update, setUpdate] = useState<string | null>(null);
  // family & account notices
  useEffect(
    () =>
      onEvent((t, d) => {
        const me = useStore.getState().me;
        if (t === "KID_REQUEST") {
          const what = d.kind === "dm" ? `wants to chat with ${d.target?.display_name}` : `wants to join ${d.target?.name}`;
          toast(`${d.kid?.display_name} ${what}. Open Settings → Family to answer.`);
        }
        if (t === "KID_REQUEST_DONE" && d.kid?.id === me?.id) {
          const what = d.kind === "dm" ? `chat with ${d.target?.display_name}` : `join ${d.target?.name}`;
          toast(d.status === "approved" ? `A parent said yes: you can ${what} now!` : `A parent said no to: ${what}.`);
        }
        if (t === "RESET_REQUEST") notifyResetRequest(d);
      }),
    [],
  );
  useEffect(() => window.llambleNative?.onUpdateReady((v) => setUpdate(v ?? "")), []);

  if (!ready) {
    return (
      <div className="loading-screen">
        <div className="titlebar-drag" />
        <div className="spinner" />
        <div className="muted">{conn === "closed" ? "Reconnecting to server…" : "Connecting…"}</div>
      </div>
    );
  }

  // phones: the top-left button goes back to the list this page came from, and says which
  const backLabel =
    selectedGuild === "@home" ? "Home" : isMessages(selectedGuild) ? "Talk" : selectedGuild === "@friends" ? peopleNameForBack : guildsForBack[selectedGuild]?.name ?? "Back";
  return (
    <div className={"shell" + (mobile ? (mobileMain ? " m-main" : " m-nav") : "")}>
      <div className="titlebar">
        {mobile && mobileMain && (
          <button className="m-menu" aria-label={`Back to ${backLabel}`} onClick={() => showMobileNav(true)}>
            <Icon name="chevron-left" size={20} /> <span className="m-menu-label">{backLabel}</span>
          </button>
        )}
        <span className="titlebar-name">Llamble</span>
        {conn !== "open" && <span className="conn-warn">Reconnecting…</span>}
        {update !== null ? (
          <button className="update-pill" onClick={() => window.llambleNative?.installUpdate()} title="Restart to update">
            Update {update} ready — restart
          </button>
        ) : (
          <VersionNotice />
        )}
      </div>
      <CallStrip />
      <div className="layout">
        {/* phones: picking something in the list opens it full screen */}
        <div
          className="nav-pane"
          onClickCapture={(e) => {
            const row = (e.target as Element).closest(".channel, .dm-row");
            if (mobile && row && !row.querySelector(".soon-tag")) setTimeout(() => showMobileNav(false), 0);
          }}
        >
          <GuildBar />
          <Sidebar />
        </div>
        <main className="main">
          {selectedGuild === "@home" ? (
            homePage === "library" ? (
              <Library />
            ) : homePage === "profile" ? (
              <MyProfile />
            ) : homePage === "voicemail" ? (
              <VoicemailPage />

            ) : (
              <Board key="@home" scope="@home" />
            )
          ) : guildView ? (
            <Board key={selectedGuild} scope={selectedGuild} />
          ) : channel ? (
            lockedOut ? (
              <LockedSpace channel={channel} />
            ) : invisibleGate ? (
              <InvisibleGate channel={channel} />
            ) : isPracticeRoom(channel.id) ? (
              channel.kind === "watch" ? <PracticeWatch channel={channel} /> : <PracticeVoice channel={channel} />
            ) : channel.kind === "voice" ? (
              <VoiceView channel={channel} />
            ) : channel.kind === "watch" ? (
              <WatchView key={channel.id} channel={channel} />
            ) : channel.kind === "party" ? (
              <PartyView channel={channel} />
            ) : (
              <ChatView key={channel.id} channel={channel} />
            )
          ) : selectedGuild === "@friends" ? (
            <FriendProfile />
          ) : selectedGuild === "@voicemail" ? (
            <VoicemailPage />
          ) : selectedGuild === "@parties" ? (
            <PartiesEmpty />
          ) : selectedGuild === "@me" ? (
            <EmptyMain home />
          ) : (
            <EmptyMain home={false} />
          )}
        </main>
        {channel?.kind === "party" && memberListOpen && <PartyMembers channel={channel} />}
        {mobile && channel && (channel.kind === "text" || channel.kind === "party") && memberListOpen && <div className="member-backdrop" onClick={() => useStore.setState({ memberListOpen: false })} />}
        {channel && channel.guild_id && channel.kind === "text" && memberListOpen && <MemberList guildId={channel.guild_id} />}
      </div>
      <CallScreens />
      <UrgentAlert />
      <Modals />
      <ContextMenu />
      <Toasts />
      <PopoutOverlay />
      <Popouts />
      <ShowPrompts />
      <RecordingBar />
      <Lightbox />
      <TutorialGuide />
    </div>
  );
}

function EmptyMain({ home }: { home: boolean }) {
  const bot = useStore((s) => s.config.bot);
  return (
    <div className="empty-main">
      <div className="empty-art">💬</div>
      <h2>{home ? "No conversation selected" : "No channels yet"}</h2>
      <p className="muted">{home ? "Pick a conversation from the list, or message a friend from Friends." : "Create a channel to get started."}</p>
      {home && bot && (
        <button
          className="btn primary"
          onClick={async () => {
            const dm = await api("/api/bot/dm", { method: "POST" });
            selectChannel("@me", dm.id);
          }}
        >
          <Icon name="bot" size={16} /> Chat with {bot.name}
        </button>
      )}
    </div>
  );
}

function GuildBar() {
  const order = useStore((s) => s.guildOrder);
  const guilds = useStore((s) => s.guilds);
  const selected = useStore((s) => s.selectedGuild);
  const me = useStore((s) => s.me);
  const cfg = useStore((s) => s.config);
  const unreadByGuild = useStore((s) => {
    const out: Record<string, { unread: boolean; mentions: number }> = {};
    for (const ch of Object.values(s.channels)) {
      const key = homeOf(ch);
      const o = (out[key] ||= { unread: false, mentions: 0 });
      if (ch.kind !== "category" && isUnread(ch, s)) o.unread = true;
      o.mentions += s.mentions[ch.id] || 0;
    }
    return JSON.stringify(out);
  });
  const unread = JSON.parse(unreadByGuild) as Record<string, { unread: boolean; mentions: number }>;
  // live people (the side line): who's in voice, and who's in a chat, per server (and Talk)
  const liveKey = useStore((s) => {
    const me = s.me?.id;
    const out: Record<string, { voice: boolean; chat: boolean }> = {};
    for (const v of Object.values(s.voiceStates)) {
      if (v.user_id === me) continue;
      const ch = s.channels[v.channel_id];
      if (!ch) continue;
      const key = ch.guild_id ?? "@talk";
      (out[key] ||= { voice: false, chat: false }).voice = true;
    }
    for (const [cid, users] of Object.entries(s.viewers)) {
      const g = s.channels[cid]?.guild_id;
      if (g && users.some((u) => u !== me)) (out[g] ||= { voice: false, chat: false }).chat = true;
    }
    return JSON.stringify(out);
  });
  const live = JSON.parse(liveKey) as Record<string, { voice: boolean; chat: boolean }>;
  /** The side line: short where others are live, long (and thicker) where you are; green
   *  means voice (a live connection to step into), white means chatting only. */
  const Lines = ({ k, here, myVoice }: { k: string; here: boolean; myVoice: boolean }) => {
    const l = live[k];
    return (
      <>
        {/* yours: long, against the edge; its color is your own connection */}
        <span className={"guild-pill" + (here ? " active" + (myVoice ? " voice" : "") : l ? " live" + (l.voice ? " voice" : "") : "")} />
        {/* others there while you are too: a short line just beside yours */}
        {here && l && <span className={"guild-pill others live" + (l.voice ? " voice" : "")} title={l.voice ? "Others are in voice here" : "Others are chatting here"} />}
      </>
    );
  };
  // conversations with anything unread (not just mentions), so new DMs are noticeable
  const unreadDms = useStore((s) => Object.values(s.channels).filter((c) => c.kind === "dm" && isUnread(c, s)).length);
  const unreadParties = useStore((s) => Object.values(s.channels).filter((c) => c.kind === "party" && isUnread(c, s)).length);
  const requests = useStore((s) => Object.values(s.friends).filter((f) => f.state === "incoming").length);
  const voiceTalk = useStore((s) => {
    const cid = useVoice.getState().channelId;
    const ch = cid ? s.channels[cid] : undefined;
    return !!ch && !ch.guild_id;
  });
  const voiceGuild = useStore((s) => {
    const cid = useVoice.getState().channelId;
    return cid ? s.channels[cid]?.guild_id : null;
  });
  useVoice((v) => v.channelId);

  const canCreate = cfg.guild_create === "all" || me?.is_admin;
  const unreadNotes = useUnreadNotes();
  const unreadNotices = useUnreadNotices();
  const homeCount = unreadNotes + unreadNotices;
  const vmCount = useVoicemailCount((v) => v.n);
  useEffect(() => refreshVoicemailCount(), []);
  const inMessages = isMessages(selected);
  const peopleName = usePeopleName();
  const msgCount = Math.max(unreadDms, unread["@me"]?.mentions || 0) + Math.max(unreadParties, unread["@parties"]?.mentions || 0) + vmCount;

  return (
    <nav className="guildbar">
      <div className="guild-wrap">
        <span className={"guild-pill" + (selected === "@home" ? " active" : "")} />
        <button
          className={"guild-logo" + (selected === "@home" ? " active" : "") + (unreadNotices ? " lit" : "")}
          title={unreadNotices ? `Home · ${unreadNotices} new notification${unreadNotices > 1 ? "s" : ""}` : "Home: notes for you, who's around, highlights"}
          onClick={() => openHome()}
        >
          <img src="./icon-192.png" alt="Llamble" draggable={false} />
          {homeCount ? <span className="badge">{homeCount}</span> : null}
          <HomeBoardDot />
        </button>
      </div>
      <div className="guild-sep" />
      <div className="guild-wrap">
        <Lines k="@talk" here={inMessages} myVoice={!!voiceTalk} />
        <button
          className={"guild-btn dms" + (inMessages ? " active" : "") + (msgCount ? " has-unread" : "")}
          data-tut="talk"
          onClick={() => openMessages()}
          title={msgCount ? `Talk · ${msgCount} new` : "Talk: calls and chats with people, parties and voicemail"}
        >
          <Icon name="talk" size={22} />
          {msgCount ? <span className="badge">{msgCount}</span> : null}
        </button>
      </div>
      <div className="guild-wrap">
        <span className={"guild-pill" + (selected === "@friends" ? " active" : "")} />
        <button
          className={"guild-btn dms" + (selected === "@friends" ? " active" : "")}
          data-tut="friends"
          onClick={() => openFriend(useStore.getState().selectedFriend)}
          title={requests ? `${peopleName} · ${requests} new request${requests > 1 ? "s" : ""}` : peopleName}
        >
          <Icon name="users" size={22} />
          {requests ? <span className="badge">{requests}</span> : null}
        </button>
      </div>
      <div className="guild-sep" />
      {order.map((id) => {
        const g = guilds[id];
        if (!g) return null;
        const u = unread[id];
        return (
          <div key={id} className="guild-wrap">
            <Lines k={id} here={selected === id || voiceGuild === id} myVoice={voiceGuild === id} />
            <button
              className={"guild-btn" + (selected === id ? " active" : "") + (g.icon_file_id ? " has-img" : "")}
              data-gid={id}
              title={g.name}
              onClick={() => {
                // phones: something new on its board opens the board; otherwise its channel list
                const fresh = boardHasNew(id);
                openGuildView(id);
                if (isPhone() && fresh) showMobileNav(false);
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "Invite People", onClick: () => openModal({ kind: "invite", guildId: id }), disabled: !canInvite(id) },
                  { label: "Mark As Read", onClick: () => markGuildRead(id) },
                  { separator: true, label: "" },
                  { label: "Server Settings", onClick: () => openModal({ kind: "serverSettings", guildId: id }), disabled: !can(id, P.MANAGE_GUILD) && !can(id, P.MANAGE_ROLES) },
                  { label: "Copy Server ID", onClick: () => copy(id, "ID copied") },
                ])
              }
            >
              <GuildIcon name={g.name} iconId={g.icon_file_id} />
              {u?.mentions ? <span className="badge">{u.mentions}</span> : <NewDot gid={id} unread={!!u?.unread} />}
            </button>
          </div>
        );
      })}
      {canCreate && (
        <button className="guild-btn add" title="Create a server" onClick={() => openModal({ kind: "createGuild" })}>
          <Icon name="plus" size={22} />
        </button>
      )}
      <button className="guild-btn add" title="Join with an invite" onClick={() => openModal({ kind: "joinInvite" })}>
        <Icon name="link" size={20} />
      </button>
      <OpenServersButton />
    </nav>
  );
}

/** The binoculars: Open servers on this Llamble, with a dot when a new one is listed. */
function OpenServersButton() {
  const [dot, setDot] = useState(false);
  useEffect(() => {
    const check = () =>
      api("/api/discover")
        .then((r) => setDot(r.servers.some((g: any) => (g.listed_at || 0) > openServersSeen())))
        .catch(() => {});
    check();
    const t = setInterval(check, 10 * 60 * 1000);
    const seen = () => setDot(false);
    window.addEventListener("llamble-open-servers-seen", seen);
    return () => {
      clearInterval(t);
      window.removeEventListener("llamble-open-servers-seen", seen);
    };
  }, []);
  return (
    <button className="guild-btn add discover-btn" title="Find servers to join" onClick={() => openModal({ kind: "discover" })}>
      <Icon name="binoculars" size={22} />
      {dot && <span className="discover-dot" />}
    </button>
  );
}

export function markGuildRead(guildId: string) {
  const s = useStore.getState();
  for (const ch of Object.values(s.channels)) {
    if (ch.guild_id === guildId && ch.last_message_id && isUnread(ch, s)) {
      api(`/api/channels/${ch.id}/ack`, { body: { message_id: ch.last_message_id } }).catch(() => {});
    }
  }
}

function Lightbox() {
  const lb = useUI((s) => s.lightbox);
  useEffect(() => {
    if (!lb) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") useUI.setState({ lightbox: null });
      if (e.key === "ArrowRight") useUI.setState({ lightbox: { ...lb, index: (lb.index + 1) % lb.items.length } });
      if (e.key === "ArrowLeft") useUI.setState({ lightbox: { ...lb, index: (lb.index - 1 + lb.items.length) % lb.items.length } });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [lb]);
  if (!lb) return null;
  const f = lb.items[lb.index];
  return (
    <div className="lightbox" onClick={() => useUI.setState({ lightbox: null })}>
      <img src={mediaSrc(f.url)} alt={f.filename} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{f.filename}</span>
        <a href={mediaSrc(f.url)} download={f.filename} className="btn small">
          <Icon name="download" size={14} /> Open original
        </a>
        {lb.items.length > 1 && (
          <span className="muted">
            {lb.index + 1} / {lb.items.length}
          </span>
        )}
      </div>
    </div>
  );
}


/** "1.2.10" > "1.2.9"; non-numeric parts count as 0 */
export function newer(a?: string, b?: string) {
  if (!a || !b) return false;
  const pa = a.split(".").map((x) => parseInt(x) || 0);
  const pb = b.split(".").map((x) => parseInt(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** The server announces its version; anyone on an older app (or an old cached web page) is told to update. */
function VersionNotice() {
  const config = useStore((s) => s.config);
  const isAdmin = useStore((s) => !!s.me?.is_admin);
  const [mine, setMine] = useState<string>(window.llambleNative ? "" : __APP_VERSION__);
  const [status, setStatus] = useState<{ state: string; percent?: number; message?: string } | null>(null);
  const [hidden, setHidden] = useState("");
  const androidUpdate = useAndroidUpdate();
  useEffect(() => {
    window.llambleNative?.version().then(setMine).catch(() => {});
    return window.llambleNative?.onUpdateStatus?.(setStatus);
  }, []);
  const server = config.version;
  if (!mine || !server || server === "0.0.0" || mine === "0.0.0" || hidden === server) return null;
  if (isAndroidApp) {
    // the phone app updates from its own downloads, not the server's: only when one exists
    return androidUpdate ? (
      <button className="update-pill" onClick={() => androidSend("check-update")}>
        Llamble {androidUpdate} is out — update
      </button>
    ) : null;
  }
  if (newer(server, mine)) {
    if (!window.llambleNative) {
      // web: the server already has the new page, the browser just has an old copy
      return (
        <button
          className="update-pill"
          onClick={async () => {
            try {
              const regs = await navigator.serviceWorker?.getRegistrations();
              await Promise.all((regs || []).map((r) => r.unregister()));
              const keys = await caches?.keys();
              await Promise.all((keys || []).map((k) => caches.delete(k)));
            } catch {}
            location.reload();
          }}
        >
          New version {server} — reload
        </button>
      );
    }
    if (status?.state === "error") {
      return (
        <a className="update-pill" href={config.client_download} target="_blank" rel="noreferrer" title={status.message}>
          Llamble {server} is out — download it
        </a>
      );
    }
    if (status?.state === "downloading" || status?.state === "checking") {
      return <span className="update-pill">Updating to {server}… {status.percent ? `${status.percent}%` : ""}</span>;
    }
    return (
      <button className="update-pill" onClick={() => window.llambleNative?.checkUpdate?.()}>
        Llamble {server} is out — update now
      </button>
    );
  }
  if (isAdmin && newer(mine, server)) {
    return (
      <button className="update-pill subtle" title="Click to hide" onClick={() => setHidden(server)}>
        Your server is on {server}; update the Llamble server to get {mine}
      </button>
    );
  }
  return null;
}

/** The "something new" dot on a server's icon: unread chat anywhere in it, or new on its board. */
function NewDot({ gid, unread }: { gid: string; unread: boolean }) {
  const board = useBoardHasNew(gid);
  return unread || board ? <span className="icon-new-dot" title={board && !unread ? "New on the board" : "Something new"} /> : null;
}

/** Something new on any server's board: Home gathers it all, so Home shows it too. */
function HomeBoardDot() {
  const on = useAnyBoardNew();
  return on ? <span className="icon-new-dot" title="New on your servers' boards" /> : null;
}

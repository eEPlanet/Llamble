// Forum spaces (see server api/forum.rs). Posts and replies are cards, always in time order.
// A reply to the post goes at the bottom; a reply to a reply branches under it (each branch
// level has its own color); a quote shows inside the reply with a jump link back, without
// branching. Likes never reorder anything: busy cards glow instead.
//
// Card colors come from CSS variables on .forum (--fc-a / --fc-b for the alternating reply
// cards, --fc-1..6 for the branch levels), so a card style pack can restyle them later.
import { useEffect, useMemo, useRef, useState } from "react";
import { openForumPost, useForumNav } from "../forumnav";
import { api, media, upload } from "../api";
import { can, useStore } from "../store";
import { P, type Channel, type FileObj, type Message } from "../types";
import { openMenu, toast, openModal } from "../ui";
import { Markdown } from "../markdown";
import { Attachments, EmbedView } from "./MessageItem";
import { Avatar, Icon, formatTime } from "./common";
import { useIsPhone } from "../phone";
import { block, report } from "../safety";

type ForumParts = { thread_id: string | null; title: string; tags: string[]; quotes: string[]; best_reply_id: string | null };
type FMsg = Message & { forum: ForumParts; likes: number; liked: boolean; reply_count?: number; last_activity?: number; following?: boolean };


const LIKE = "❤️";
export const BRANCH_SETS: Record<string, { label: string; colors: string[] }> = {
  // the default: Llamble's own colors (navy app, spit green, ring blue and purple, no orange)
  llamble: { label: "Llamble", colors: ["#a6d052", "#3f84eb", "#7b70d6", "#8cc3ff", "#c9e38f", "#a9a1ea"] },
  rainbow: { label: "Rainbow", colors: ["#1D9E75", "#7F77DD", "#D85A30", "#D4537E", "#BA7517", "#378ADD"] },
  calm: { label: "Calm", colors: ["#5DCAA5", "#85B7EB", "#AFA9EC", "#97C459", "#ED93B1", "#FAC775"] },
  mono: { label: "Mono", colors: ["#B4B2A9", "#888780", "#D3D1C7", "#5F5E5A", "#B4B2A9", "#888780"] },
  contrast: { label: "High contrast", colors: ["#00E5FF", "#FFD400", "#FF4FD8", "#7CFF4F", "#FF8A00", "#A97BFF"] },
};
const BASES = ["", "#1D9E75", "#378ADD", "#7F77DD", "#D85A30", "#D4537E", "#BA7517"];

type Style = { base: string; branch: string };
const parseStyle = (s?: string): Style => {
  try {
    const v = JSON.parse(s || "{}");
    return { base: v.base || "", branch: BRANCH_SETS[v.branch] ? v.branch : "llamble" };
  } catch {
    return { base: "", branch: "llamble" };
  }
};
const MINE = "llamble.forumStyle";
const myStyle = (): Style | null => {
  try {
    const v = JSON.parse(localStorage.getItem(MINE) || "null");
    return v ? parseStyle(JSON.stringify(v)) : null;
  } catch {
    return null;
  }
};

/** The CSS variables for a forum's colors (yours override the forum's). */
function styleVars(st: Style): React.CSSProperties {
  const v: Record<string, string> = {};
  if (st.base) {
    v["--fc-a"] = st.base + "1f";
    v["--fc-b"] = st.base + "33";
  }
  BRANCH_SETS[st.branch].colors.forEach((c, i) => (v[`--fc-${i + 1}`] = c));
  return v as React.CSSProperties;
}

const heat = (n: number) => (n >= 20 ? 3 : n >= 8 ? 2 : n >= 3 ? 1 : 0);
const when = (ms: number) => formatTime(ms);

export function ForumView({ channel }: { channel: Channel }) {
  const open = useForumNav((s) => s.open[channel.id] || null);
  const [, setMine] = useState(0);
  const st = myStyle() || parseStyle(channel.style);
  return (
    <div className="forum" style={styleVars(st)}>
      {open ? <Thread channel={channel} pid={open} /> : <PostList channel={channel} onColors={() => setMine((n) => n + 1)} />}
    </div>
  );
}

function PostList({ channel, onColors }: { channel: Channel; onColors: () => void }) {
  const tick = useStore((s) => s.forumTick[channel.id] || 0);
  const [filter, setFilter] = useState("all");
  const [tag, setTag] = useState("");
  const [data, setData] = useState<{ posts: FMsg[]; tags: string[] } | null>(null);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/api/channels/${channel.id}/forum?filter=${filter}&tag=${encodeURIComponent(tag)}`)
        .then(setData)
        .catch((e) => toast(e.message, "error"));
    }, 120);
    return () => clearTimeout(t);
  }, [channel.id, filter, tag, tick]);
  return (
    <div className="forum-scroll">
      <header className="chat-header">
        <span className="chat-head-emoji">🗂️</span>
        <span className="chat-title">{channel.name}</span>
        {channel.topic && <span className="chat-topic ellipsis">{channel.topic}</span>}
        <div className="grow" />
        <button className="icon-btn" title="Colors" onClick={(e) => colorsMenu(e, channel, onColors)}>
          🎨
        </button>
        <button className="btn small green" onClick={() => setWriting(true)}>
          New post
        </button>
      </header>
      <div className="forum-body">
        {writing && <NewPost channel={channel} onDone={(pid) => (setWriting(false), pid && openForumPost(channel.id, pid))} />}
        <div className="forum-filters">
          {[
            ["all", "All"],
            ["unanswered", "Unanswered"],
            ["solved", "Solved"],
            ["following", "Following"],
            ["media", "Pictures and videos"],
          ].map(([k, l]) => (
            <button key={k} className={"chip" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
          {!!data?.tags.length && <span className="forum-sep" />}
          {data?.tags.map((t) => (
            <button key={t} className={"chip tag" + (tag.toLowerCase() === t.toLowerCase() ? " on" : "")} onClick={() => setTag(tag.toLowerCase() === t.toLowerCase() ? "" : t)}>
              #{t}
            </button>
          ))}
        </div>
        {data === null ? (
          <p className="muted">Loading…</p>
        ) : !data.posts.length ? (
          <div className="forum-empty">
            <div className="empty-art">🗂️</div>
            <p className="muted">{filter === "all" && !tag ? "No posts yet. Start one with New post." : "Nothing here."}</p>
          </div>
        ) : (
          data.posts.map((p) => <PostCard key={p.id} p={p} onOpen={() => openForumPost(channel.id, p.id)} />)
        )}
      </div>
    </div>
  );
}

function PostCard({ p, onOpen }: { p: FMsg; onOpen: () => void }) {
  const author = useStore((s) => s.users[p.author.id] || p.author);
  const pics = p.attachments.filter((a) => (a.mime.startsWith("image/") && a.mime !== "image/svg+xml") || a.mime.startsWith("video/"));
  const first = pics[0];
  const h = heat(p.likes + (p.reply_count || 0));
  return (
    <div className={`forum-card post-card heat-${h}` + (first ? " has-media" : "")} onClick={onOpen}>
      <div className="fc-main">
        <div className="fc-head">
          <Avatar user={author} size={22} />
          <b>{author.display_name}</b>
          <span className="muted small">{when(p.created_at)}</span>
          {p.forum.best_reply_id && <span className="fc-badge solved">✓ Solved</span>}
        </div>
        <div className="fc-title">{p.forum.title}</div>
        {p.content && <div className="fc-preview muted">{p.content.slice(0, 200)}</div>}
        <div className="fc-foot">
          {p.forum.tags.map((t) => (
            <span key={t} className="fc-tag">
              #{t}
            </span>
          ))}
          <span className="grow" />
          <span title="Replies">
            <Icon name="chat" size={14} /> {p.reply_count || 0}
          </span>
          <span title="Likes" className={p.liked ? "liked" : ""}>
            ♥ {p.likes}
          </span>
          {p.following && <span title="You follow this post">🔔</span>}
        </div>
      </div>
      {first && (
        // a picture or video post: the first one big, with how many more
        <div className="fc-media">
          {first.mime.startsWith("video/") ? (
            <video src={media(first.url)} poster={first.thumb_url ? media(first.thumb_url) : undefined} controls preload="metadata" playsInline onClick={(e) => e.stopPropagation()} />
          ) : (
            <img src={media(first.thumb_url || first.url)} alt="" loading="lazy" />
          )}
          {pics.length > 1 && <span className="fc-more">+{pics.length - 1}</span>}
        </div>
      )}
    </div>
  );
}

function colorsMenu(e: React.MouseEvent, channel: Channel, changed: () => void) {
  const staff = !!channel.guild_id && can(channel.guild_id, P.MANAGE_CHANNELS);
  const mine = myStyle();
  const cur = mine || parseStyle(channel.style);
  const setMine = (st: Style | null) => (st ? localStorage.setItem(MINE, JSON.stringify(st)) : localStorage.removeItem(MINE), changed());
  const setForum = (st: Style) =>
    api(`/api/channels/${channel.id}`, { method: "PATCH", body: { style: st } })
      .then((ch) => useStore.setState((s) => ({ channels: { ...s.channels, [ch.id]: { ...s.channels[ch.id], ...ch } } })))
      .catch((err) => toast(err.message, "error"));
  const items: any[] = [{ label: "Branch colors (just for you)", disabled: true }];
  for (const [k, v] of Object.entries(BRANCH_SETS)) items.push({ label: (cur.branch === k ? "✓ " : "") + v.label, onClick: () => setMine({ ...cur, branch: k }) });
  items.push({ separator: true, label: "" }, { label: "Card color (just for you)", disabled: true });
  BASES.forEach((b, i) => items.push({ label: (cur.base === b ? "✓ " : "") + (b ? ["", "Green", "Blue", "Purple", "Coral", "Pink", "Amber"][i] : "Default"), onClick: () => setMine({ ...cur, base: b }) }));
  if (mine) items.push({ label: "Use this forum's colors", onClick: () => setMine(null) });
  if (staff) items.push({ separator: true, label: "" }, { label: "Make my colors this forum's default", onClick: () => setForum(cur) });
  openMenu(e, items);
}

function NewPost({ channel, onDone }: { channel: Channel; onDone: (pid?: string) => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return toast("Give your post a title", "error");
    setBusy(true);
    try {
      const attachments = [];
      for (const f of files) attachments.push({ id: (await upload(f, f.name)).id, spoiler: false });
      const m = await api(`/api/channels/${channel.id}/messages`, {
        body: { title, content: text, tags: tags.split(/[,\s]+/).filter(Boolean), attachments },
      });
      onDone(m.id);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="forum-card forum-new" onSubmit={send}>
      <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
      <textarea placeholder="What's on your mind? (optional for a picture or video post)" value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={4000} />
      <input placeholder="Tags (up to 5, separated by spaces)" value={tags} onChange={(e) => setTags(e.target.value)} />
      <Picked files={files} setFiles={setFiles} />
      <div className="forum-new-foot">
        <label className="btn small">
          📷 Pictures or video
          <input type="file" accept="image/*,video/*" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files || [])].slice(0, 10))} />
        </label>
        <label className="btn small">
          📎 Files
          <input type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files || [])].slice(0, 10))} />
        </label>
        <span className="grow" />
        <button type="button" className="btn link" onClick={() => onDone()}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  );
}

/** What's been picked to attach: pictures and videos as previews, other files by name. */
function Picked({ files, setFiles }: { files: File[]; setFiles: (f: File[]) => void }) {
  const urls = useMemo(() => files.map((f) => (f.type.startsWith("image/") || f.type.startsWith("video/") ? URL.createObjectURL(f) : "")), [files]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);
  if (!files.length) return null;
  return (
    <div className="fc-picked">
      {files.map((f, i) => (
        <div key={i} className="fc-pick" title={"Remove " + f.name} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
          {f.type.startsWith("image/") ? <img src={urls[i]} alt="" /> : f.type.startsWith("video/") ? <video src={urls[i]} muted /> : <span className="fc-tag">{f.name}</span>}
          <span className="fc-x">✕</span>
        </div>
      ))}
    </div>
  );
}

function Thread({ channel, pid }: { channel: Channel; pid: string }) {
  const tick = useStore((s) => s.forumTick[channel.id] || 0);
  const me = useStore((s) => s.me)!;
  const phone = useIsPhone();
  const focus = useForumNav((s) => s.focus[channel.id] || null);
  const flash = useForumNav((s) => s.flash);
  const [data, setData] = useState<{ post: FMsg; replies: FMsg[] } | null>(null);
  const [gone, setGone] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const bottom = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    api(`/api/channels/${channel.id}/forum/${pid}`)
      .then((d) => (setData(d), setGone(false)))
      .catch(() => setGone(true));
  }, [channel.id, pid, tick]);
  // jump to (and flash) a card
  useEffect(() => {
    if (!flash || !data) return;
    const el = document.getElementById("fr-" + flash);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
      useForumNav.setState({ flash: null });
    }
  }, [flash, data]);

  const byId = useMemo(() => {
    const m: Record<string, FMsg> = {};
    if (data) [data.post, ...data.replies].forEach((r) => (m[r.id] = r));
    return m;
  }, [data]);
  // the branches: children of each card, in time order
  const kids = useMemo(() => {
    const k: Record<string, FMsg[]> = {};
    for (const r of data?.replies || []) {
      const parent = r.reply_to?.id && r.reply_to.id !== pid && byId[r.reply_to.id] ? r.reply_to.id : pid;
      (k[parent] ||= []).push(r);
    }
    return k;
  }, [data, byId, pid]);
  // who quotes each card ("Quoted by 2")
  const quotedBy = useMemo(() => {
    const q: Record<string, string[]> = {};
    for (const r of data?.replies || []) for (const x of r.forum.quotes || []) (q[x] ||= []).push(r.id);
    return q;
  }, [data]);

  if (gone)
    return (
      <div className="forum-scroll">
        <div className="forum-body">
          <button className="btn link" onClick={() => openForumPost(channel.id, null)}>
            ← All posts
          </button>
          <p className="muted">This post was deleted.</p>
        </div>
      </div>
    );
  if (!data) return <div className="forum-scroll"><p className="muted" style={{ padding: 20 }}>Loading…</p></div>;
  const post = data.post;
  const staff = !!channel.guild_id && can(channel.guild_id, P.MANAGE_MESSAGES);
  const canPickBest = post.author.id === me.id || staff;
  const best = post.forum.best_reply_id ? byId[post.forum.best_reply_id] : null;
  const maxDepth = phone ? 3 : 6;

  const like = (m: FMsg) =>
    api(`/api/messages/${m.id}/reactions/${encodeURIComponent(LIKE)}`, { method: m.liked ? "DELETE" : "PUT" }).catch((e) => toast(e.message, "error"));
  const follow = () => api(`/api/forum/${pid}/follow`, { method: post.following ? "DELETE" : "PUT" }).then(() => setData({ ...data, post: { ...post, following: !post.following } }));
  const pickBest = (id: string | null) => api(`/api/forum/${pid}/best`, { method: "PUT", body: { reply_id: id } }).catch((e) => toast(e.message, "error"));
  const quote = (id: string) => (setQuotes((q) => (q.includes(id) ? q : [...q, id])), setTimeout(() => bottom.current?.focus(), 50));
  const jump = (id: string) => useForumNav.setState({ flash: id });

  const menu = (e: React.MouseEvent, m: FMsg) => {
    const mine = m.author.id === me.id;
    const items: any[] = [{ label: "Copy link", onClick: () => (navigator.clipboard.writeText(`llamble://forum/${channel.id}/${pid}/${m.id}`), toast("Link copied")) }];
    if (m.id !== pid && canPickBest) items.push(post.forum.best_reply_id === m.id ? { label: "Remove best answer", onClick: () => pickBest(null) } : { label: "Mark as best answer", onClick: () => pickBest(m.id) });
    if (mine || staff)
      items.push({
        label: m.id === pid ? "Delete post" : "Delete reply",
        danger: true,
        onClick: () =>
          openModal({
            kind: "confirm",
            title: m.id === pid ? "Delete this post?" : "Delete this reply?",
            body: m.id === pid ? "The post and all its replies are deleted for everyone." : "The reply is deleted for everyone. Replies under it stay.",
            danger: true,
            confirmLabel: "Delete",
            onConfirm: () =>
              api(`/api/messages/${m.id}`, { method: "DELETE" }).then(() => {
                if (m.id === pid) openForumPost(channel.id, null);
              }),
          }),
      });
    if (!mine && !m.author.is_bot)
      items.push(
        { separator: true, label: "" },
        { label: m.id === pid ? "Report post" : "Report reply", danger: true, onClick: () => report(m.author.id, m.id) },
        { label: `Block ${m.author.display_name}`, danger: true, onClick: () => block(m.author.id, m.author.display_name) },
      );
    openMenu(e, items);
  };

  const card = (m: FMsg, depth: number, shade: number) => {
    const isPost = m.id === pid;
    const children = kids[m.id] || [];
    const parent = !isPost && m.reply_to?.id && m.reply_to.id !== pid ? byId[m.reply_to.id] : null;
    const h = heat(m.likes + children.length);
    return (
      <div
        id={"fr-" + m.id}
        className={`forum-card reply-card heat-${h}${isPost ? " is-post" : ""}${depth ? " branch" : shade % 2 ? " shade-b" : " shade-a"}${post.forum.best_reply_id === m.id ? " is-best" : ""}`}
        style={depth ? ({ "--fc-rail": `var(--fc-${((depth - 1) % 6) + 1})` } as React.CSSProperties) : undefined}
      >
        <div className="fc-head">
          <span className="clickable" onClick={() => openModal({ kind: "profile", userId: m.author.id, guildId: channel.guild_id })}>
            <Avatar user={m.author} size={isPost ? 28 : 22} />
          </span>
          <b>{m.author.display_name}</b>
          <span className="muted small">
            {parent ? (
              <>
                replied to{" "}
                <span className="clickable" onClick={() => jump(parent.id)}>
                  {parent.author.display_name}
                </span>{" "}
                ·{" "}
              </>
            ) : null}
            {when(m.created_at)}
            {m.edited_at ? " (edited)" : ""}
          </span>
          {post.forum.best_reply_id === m.id && <span className="fc-badge solved">✓ Best answer</span>}
          <span className="grow" />
          <button className="icon-btn small" title="More" onClick={(e) => menu(e, m)}>
            ⋯
          </button>
        </div>
        {isPost && <div className="fc-title big">{m.forum.title}</div>}
        {!!m.forum.quotes?.length && (
          <div className="fc-quotes">
            {m.forum.quotes.map((q) => {
              const src = byId[q];
              return (
                <div key={q} className="fc-quote" onClick={() => jump(q)}>
                  <span className="muted small">{src ? src.author.display_name : "Deleted"}:</span> {src ? (src.content || "📎").slice(0, 160) : "(this was deleted)"} <span className="link small">↑ jump</span>
                </div>
              );
            })}
          </div>
        )}
        {m.content && (
          <div className="fc-text">
            <Markdown text={m.content} guildId={channel.guild_id} />
          </div>
        )}
        {m.attachments.length > 0 && <Attachments files={m.attachments as FileObj[]} />}
        {m.embeds?.map((e, i) => <EmbedView key={i} e={e} />)}
        {isPost && !!m.forum.tags.length && (
          <div className="fc-foot">
            {m.forum.tags.map((t) => (
              <span key={t} className="fc-tag">
                #{t}
              </span>
            ))}
          </div>
        )}
        <div className="fc-actions">
          <button className="btn link small" onClick={() => (isPost ? bottom.current?.focus() : setReplyTo(m.id))}>
            Reply
          </button>
          {!isPost && (
            <button className="btn link small" onClick={() => quote(m.id)}>
              Quote
            </button>
          )}
          <button className={"btn link small" + (m.liked ? " liked" : "")} onClick={() => like(m)}>
            ♥ {m.likes || ""}
          </button>
          {isPost && (
            <button className="btn link small" onClick={follow}>
              {post.following ? "🔔 Following" : "Follow"}
            </button>
          )}
          {!!quotedBy[m.id]?.length && (
            <button className="btn link small" onClick={() => jump(quotedBy[m.id][0])}>
              Quoted by {quotedBy[m.id].length}
            </button>
          )}
          {!isPost && children.length > 0 && (
            <button className="btn link small" onClick={() => setCollapsed((c) => ({ ...c, [m.id]: !c[m.id] }))}>
              {collapsed[m.id] ? `Show ${children.length} ${children.length === 1 ? "reply" : "replies"}` : "Hide replies"}
            </button>
          )}
        </div>
        {replyTo === m.id && !isPost && (
          <ReplyBox channel={channel} pid={pid} replyTo={m.id} quotes={[]} onDone={() => setReplyTo(null)} placeholder={`Reply to ${m.author.display_name}`} />
        )}
      </div>
    );
  };

  // a card and its branch (depth 0 = a reply to the post)
  const tree = (m: FMsg, depth: number, shade: number): React.ReactNode => {
    const children = kids[m.id] || [];
    return (
      <div key={m.id} className={depth ? "fc-branch" : ""} style={depth ? ({ "--fc-rail": `var(--fc-${((depth - 1) % 6) + 1})` } as React.CSSProperties) : undefined}>
        {card(m, depth, shade)}
        {!collapsed[m.id] &&
          children.length > 0 &&
          (depth + 1 > maxDepth ? (
            <button className="btn link small fc-continue" onClick={() => useForumNav.setState((s) => ({ focus: { ...s.focus, [channel.id]: m.id } }))}>
              Continue this branch →
            </button>
          ) : (
            children.map((c) => tree(c, depth + 1, 0))
          ))}
      </div>
    );
  };

  const focused = focus ? byId[focus] : null;
  return (
    <div className="forum-scroll">
      <header className="chat-header">
        <button className="icon-btn" title="All posts" onClick={() => (focused ? useForumNav.setState((s) => ({ focus: { ...s.focus, [channel.id]: null } })) : openForumPost(channel.id, null))}>
          ←
        </button>
        <span className="chat-title ellipsis">{focused ? "Branch" : post.forum.title}</span>
        <span className="muted small">{channel.name}</span>
      </header>
      <div className="forum-body">
        {focused ? (
          <>
            <button className="btn link small" onClick={() => useForumNav.setState((s) => ({ focus: { ...s.focus, [channel.id]: null } }))}>
              ← back to thread
            </button>
            {tree(focused, 1, 0)}
          </>
        ) : (
          <>
            {card(post, 0, 0)}
            {best && (
              <div className="fc-best" onClick={() => jump(best.id)}>
                <div className="small">
                  <b>✓ Best answer</b> · {best.author.display_name} <span className="link">see in thread</span>
                </div>
                <div className="fc-text">
                  <Markdown text={best.content.slice(0, 600)} guildId={channel.guild_id} />
                </div>
              </div>
            )}
            <div className="muted small fc-count">
              {data.replies.length} {data.replies.length === 1 ? "reply" : "replies"}
            </div>
            {(kids[pid] || []).map((r, i) => tree(r, 0, i))}
            <ReplyBox
              channel={channel}
              pid={pid}
              replyTo={null}
              quotes={quotes}
              setQuotes={setQuotes}
              byId={byId}
              taRef={bottom}
              onDone={() => setQuotes([])}
              placeholder="Reply to the post"
            />
          </>
        )}
      </div>
    </div>
  );
}

function ReplyBox({
  channel,
  pid,
  replyTo,
  quotes,
  setQuotes,
  byId,
  onDone,
  placeholder,
  taRef,
}: {
  channel: Channel;
  pid: string;
  replyTo: string | null;
  quotes: string[];
  setQuotes?: (q: string[]) => void;
  byId?: Record<string, FMsg>;
  onDone: () => void;
  placeholder: string;
  taRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() && !files.length) return;
    setBusy(true);
    try {
      const attachments = [];
      for (const f of files) attachments.push({ id: (await upload(f, f.name)).id, spoiler: false });
      await api(`/api/channels/${channel.id}/messages`, { body: { thread_id: pid, reply_to: replyTo, content: text, quotes, attachments } });
      setText("");
      setFiles([]);
      onDone();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={"forum-reply-box" + (replyTo ? " inline" : "")}>
      {!!quotes.length && (
        <div className="fc-quotes">
          {quotes.map((q) => (
            <div key={q} className="fc-quote">
              <span className="muted small">{byId?.[q]?.author.display_name || "Reply"}:</span> {(byId?.[q]?.content || "").slice(0, 120)}{" "}
              <span className="link small" onClick={() => setQuotes?.(quotes.filter((x) => x !== q))}>
                remove
              </span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={replyTo ? 2 : 3}
        maxLength={4000}
        autoFocus={!!replyTo}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
          if (e.key === "Escape" && replyTo) onDone();
        }}
      />
      <Picked files={files} setFiles={setFiles} />
      <div className="forum-new-foot">
        <label className="btn small" title="Add pictures, video or files">
          📎
          <input type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files || [])].slice(0, 10))} />
        </label>
        <span className="grow" />
        {replyTo && (
          <button type="button" className="btn link small" onClick={onDone}>
            Cancel
          </button>
        )}
        <button className="btn primary small" disabled={busy || (!text.trim() && !files.length)} onClick={send}>
          {busy ? "Sending…" : "Reply"}
        </button>
      </div>
    </div>
  );
}

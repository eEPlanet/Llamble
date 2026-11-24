// The tutorial: the real app, filled with a pretend world. While it runs, the app is cut off
// from the server (no gateway) and every request is answered here, so nothing anyone does in
// practice reaches real people or real servers. Reads that aren't part of the pretend world
// (settings pages) still come from the server, and anything that would change something there
// is refused with "Practice: nothing was changed".
//
// The tour follows what this person can actually do on this Llamble: the staff powers they hold
// in their real servers (as each server set them), whether they run the instance, kid accounts,
// and which parts are switched on here (voice, Watch, the AI bot).
import { create } from "zustand";
import { ApiError, apiHooks, api } from "./api";
import { connectGateway, disconnectGateway } from "./gateway";
import { guildPerms, handleEvent, isMessages, onEvent, currentChannelId, useStore } from "./store";
import type { Channel, FileObj, Friend, Member, Message, Note, Role, User } from "./types";
import { P, ALL_PERMS } from "./types";
import { useUI } from "./ui";
import { isPhone } from "./phone";
import { leaveVoice, useVoice, voiceHooks } from "./voice";

// ---------- ids ----------

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
let lastMs = 0;
/** time-sortable ids like the server's (the app reads message times from them) */
export function tid(ms = Date.now()): string {
  if (ms <= lastMs) ms = lastMs + 1;
  lastMs = ms;
  let t = "";
  let n = ms;
  for (let i = 0; i < 10; i++) {
    t = B32[n % 32] + t;
    n = Math.floor(n / 32);
  }
  let r = "";
  for (let i = 0; i < 16; i++) r += B32[Math.floor(Math.random() * 32)];
  return t + r;
}

// ---------- who's taking the tour ----------

export interface TourCtx {
  name: string;
  phone: boolean;
  kid: boolean;
  /** runs this Llamble (instance admin), and the top one (master) */
  admin: boolean;
  master: boolean;
  /** staff powers held in at least one real server (ALL when they own or admin one) */
  perms: number;
  /** the name of the staff role they hold ("Supervisor", "Moderator"…), if any */
  roleName: string | null;
  owner: boolean;
  voice: boolean;
  watch: boolean;
  bot: string | null;
  people: string;
}

const STAFF_BITS = P.MANAGE_MESSAGES | P.MANAGE_CHANNELS | P.MANAGE_ROLES | P.MANAGE_GUILD | P.KICK | P.BAN | P.LOCK_SPACES | P.POST_NEWS;
const DEFAULT_EVERYONE = P.VIEW | P.SEND | P.ATTACH | P.EMBED_LINKS | P.REACT | P.CREATE_INVITE | P.CONNECT | P.SPEAK | P.VIDEO | P.ADD_HIGHLIGHTS;

function readCtx(): TourCtx {
  const s = useStore.getState();
  const me = s.me!;
  let perms = 0;
  let owner = false;
  let roleName: string | null = null;
  let rolePos = -1;
  for (const gid of s.guildOrder) {
    const g = s.guilds[gid];
    if (!g) continue;
    if (g.owner_id === me.id) owner = true;
    perms |= guildPerms(gid, s);
    // the highest staff role they hold, by name, for "what a Supervisor here can do"
    const mine = s.members[gid]?.[me.id]?.roles || [];
    for (const r of s.roles[gid] || []) {
      if (mine.includes(r.id) && r.permissions & (STAFF_BITS | P.ADMINISTRATOR) && r.position > rolePos) {
        rolePos = r.position;
        roleName = r.name;
      }
    }
  }
  if (owner) roleName = "Owner";
  return {
    name: me.display_name || me.username,
    phone: isPhone(),
    kid: !!me.is_kid,
    admin: !!me.is_admin,
    master: me.instance_role === "master",
    perms: perms === ALL_PERMS ? ALL_PERMS : perms & STAFF_BITS,
    roleName,
    owner,
    voice: !!s.config.voice_enabled,
    watch: !!s.config.watch?.on,
    bot: s.config.bot?.name || null,
    people: s.config.people_name || "Friends",
  };
}

// ---------- the pretend world ----------

interface World {
  guildId: string;
  general: string;
  pictures: string;
  hangout: string;
  movies: string | null;
  mayaDm: string;
  botDm: string | null;
  users: Record<string, User>;
  maya: User;
  theo: User;
  priya: User;
  jordan: User;
  rex: User | null;
  bot: User | null;
  me: User;
  messages: Record<string, Message[]>;
  channels: Record<string, Channel>;
  members: Record<string, Member>;
  roles: Role[];
  friends: Record<string, Friend>;
  notes: Note[];
  rexMsg: string | null;
  mayaReplied: boolean;
  dmReplied: boolean;
  ids: Set<string>;
}

let W: World | null = null;

const person = (name: string, extra: Partial<User> = {}): User => ({
  id: tid(Date.now() - 5e9),
  username: name.toLowerCase(),
  display_name: name,
  avatar_file_id: null,
  is_admin: false,
  instance_role: "user",
  ...extra,
});

/** a little picture for the #pictures space, drawn here (no files needed) */
function lakePicture(): FileObj {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 400;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, 240);
  sky.addColorStop(0, "#f7b267");
  sky.addColorStop(1, "#f4845f");
  g.fillStyle = sky;
  g.fillRect(0, 0, 640, 400);
  g.fillStyle = "#ffe8a3";
  g.beginPath();
  g.arc(460, 200, 52, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#5c4d7d";
  g.beginPath();
  g.moveTo(0, 240);
  g.lineTo(120, 150);
  g.lineTo(220, 215);
  g.lineTo(330, 130);
  g.lineTo(480, 240);
  g.fill();
  const water = g.createLinearGradient(0, 240, 0, 400);
  water.addColorStop(0, "#3d5a80");
  water.addColorStop(1, "#293241");
  g.fillStyle = water;
  g.fillRect(0, 240, 640, 160);
  g.fillStyle = "rgba(255,232,163,.45)";
  for (const [x, y, w] of [[390, 262, 140], [415, 285, 90], [435, 306, 50]]) g.fillRect(x, y, w, 5);
  const url = c.toDataURL("image/png");
  return { id: tid(), filename: "sunset-at-the-lake.png", mime: "image/png", size: url.length, width: 640, height: 400, url, thumb_url: url };
}

function buildWorld(ctx: TourCtx): World {
  const s = useStore.getState();
  const me = { ...s.me! };
  const now = Date.now();
  const guildId = tid(now - 4e9);
  const ch = (name: string, kind: Channel["kind"], pos: number): Channel => ({
    id: tid(now - 4e9 + pos),
    guild_id: guildId,
    kind,
    name,
    topic: "",
    parent_id: null,
    position: pos,
    created_at: now - 4e9,
    last_message_id: null,
  });
  const general = ch("general", "text", 0);
  const pictures = ch("pictures", "text", 1);
  const hangout = ch("Hangout", "voice", 2);
  const movies = ctx.watch ? ch("Movie Night", "watch", 3) : null;
  const maya = person("Maya");
  const theo = person("Theo");
  const priya = person("Priya");
  const jordan = person("Jordan");
  const rex = ctx.perms & (P.MANAGE_MESSAGES | P.KICK | P.BAN) ? person("Rex") : null;
  const bot = s.config.bot ? ({ ...(s.users[s.config.bot.id] || person(s.config.bot.name)), id: s.config.bot.id, display_name: s.config.bot.name, is_bot: true } as User) : null;

  const roles: Role[] = [{ id: guildId, guild_id: guildId, name: "@everyone", color: 0, permissions: DEFAULT_EVERYONE, position: 0, hoist: false }];
  const myRoles: string[] = [];
  if (ctx.perms && !ctx.owner) {
    const rid = tid();
    roles.push({ id: rid, guild_id: guildId, name: ctx.roleName || "Staff", color: 0xe67e22, permissions: ctx.perms, position: 30, hoist: true });
    myRoles.push(rid);
  }
  const members: Record<string, Member> = {};
  for (const u of [me, maya, theo, priya, jordan, rex, bot]) if (u) members[u.id] = { guild_id: guildId, user: u, nickname: null, roles: u === me ? myRoles : [], joined_at: now - 3e9 };

  const msg = (c: Channel | { id: string }, author: User, content: string, ago: number, extra: Partial<Message> = {}): Message => ({
    id: tid(now - ago),
    channel_id: c.id,
    author,
    content,
    reply_to: null,
    attachments: [],
    embeds: [],
    reactions: [],
    edited_at: null,
    created_at: now - ago,
    ...extra,
  });
  const messages: Record<string, Message[]> = {};
  messages[general.id] = [
    msg(general, maya, "Hey everyone! 👋", 3600e3),
    msg(general, theo, "Who's up for a movie on Friday? 🍿", 3000e3, { reactions: [{ emoji: "👍", users: [maya.id, priya.id] }] }),
    msg(general, priya, "Count me in!", 2900e3),
  ];
  let rexMsg: string | null = null;
  if (rex) {
    const m = msg(general, rex, "CHEAP GAME COINS!!! click my link 🤑🤑🤑 buy-coins-now.example", 600e3);
    rexMsg = m.id;
    messages[general.id].push(m);
  }
  messages[pictures.id] = [msg(pictures, priya, "Sunset at the lake last night", 7200e3, { attachments: [lakePicture()] })];

  const dm = (other: User): Channel => ({ id: tid(now - 3e9), guild_id: null, kind: "dm", name: "", topic: "", parent_id: null, position: 0, created_at: now - 3e9, last_message_id: null, recipients: [me, other] });
  const mayaDmCh = dm(maya);
  messages[mayaDmCh.id] = [msg(mayaDmCh, maya, "Hi! This is a direct message: only you and I can see it.", 1800e3)];
  const botDmCh = bot ? dm(bot) : null;
  if (botDmCh && bot) messages[botDmCh.id] = [msg(botDmCh, bot, `Hi, I'm ${bot.display_name}, the AI helper on this Llamble. Ask me anything!`, 1700e3)];

  const channels: Record<string, Channel> = {};
  for (const c of [general, pictures, hangout, movies, mayaDmCh, botDmCh]) {
    if (!c) continue;
    const list = messages[c.id];
    channels[c.id] = { ...c, last_message_id: list?.length ? list[list.length - 1].id : null };
  }

  const friends: Record<string, Friend> = {
    [maya.id]: { user: maya, state: "friend", since: now - 9e9, favorite: true },
    [theo.id]: { user: theo, state: "friend", since: now - 9e9 },
    [jordan.id]: { user: jordan, state: "incoming", since: now - 3600e3 },
  };
  const notes: Note[] = [
    {
      id: tid(now - 5000e3),
      guild_id: guildId,
      author: maya,
      content: "Welcome to the board! Notes like this one stay up for everyone (or just the people you pick).",
      color: "yellow",
      audience: "everyone",
      to: [],
      expires_at: null,
      created_at: now - 5000e3,
      edited_at: null,
      read: false,
      dismissed: false,
      read_count: 0,
      target_count: 0,
    },
  ];
  const users: Record<string, User> = {};
  for (const u of [me, maya, theo, priya, jordan, rex, bot]) if (u) users[u.id] = u;
  const ids = new Set<string>([guildId, ...Object.keys(channels), ...Object.keys(users).filter((u) => u !== me.id && u !== bot?.id)]);
  for (const list of Object.values(messages)) for (const m of list) ids.add(m.id);
  return {
    guildId,
    general: general.id,
    pictures: pictures.id,
    hangout: hangout.id,
    movies: movies?.id ?? null,
    mayaDm: mayaDmCh.id,
    botDm: botDmCh?.id ?? null,
    users,
    maya,
    theo,
    priya,
    jordan,
    rex,
    bot,
    me,
    messages,
    channels,
    members,
    roles,
    friends,
    notes,
    rexMsg,
    mayaReplied: false,
    dmReplied: false,
    ids,
  };
}

function readyPayload(ctx: TourCtx, w: World) {
  const s = useStore.getState();
  return {
    user: w.me,
    guilds: [
      {
        guild: { id: w.guildId, name: "Practice Server", icon_file_id: null, owner_id: ctx.owner ? w.me.id : w.maya.id, created_at: Date.now() - 4e9, join_mode: "invite" },
        channels: Object.values(w.channels).filter((c) => c.guild_id),
        roles: w.roles,
        members: Object.values(w.members),
      },
    ],
    dms: Object.values(w.channels).filter((c) => c.kind === "dm"),
    friends: Object.values(w.friends),
    read_states: [],
    presences: [
      { user_id: w.maya.id, status: "online" },
      { user_id: w.theo.id, status: "online" },
      { user_id: w.priya.id, status: "online" },
      { user_id: w.jordan.id, status: "idle" },
      ...(w.rex ? [{ user_id: w.rex.id, status: "online" }] : []),
      ...(w.bot ? [{ user_id: w.bot.id, status: "online" }] : []),
    ],
    my_status: { status: "online", hide_activity: false },
    viewers: [],
    voice_states: ctx.voice
      ? [w.theo, w.priya].map((u) => ({ user_id: u.id, channel_id: w.hangout, guild_id: w.guildId, muted: false, deafened: false, video: false, screen: false }))
      : [],
    config: s.config,
  };
}

// ---------- answering requests ----------

const practiceNo = () => Promise.reject(new ApiError(0, "Practice: nothing was changed."));
const later = (ms: number, f: () => void) => window.setTimeout(() => W && f(), ms);

function emitMessage(m: Message) {
  if (!W) return;
  (W.messages[m.channel_id] ||= []).push(m);
  W.ids.add(m.id);
  handleEvent("MESSAGE_CREATE", m);
}

function say(channelId: string, author: User, content: string, wait = 1400) {
  later(wait - 900, () => handleEvent("TYPING_START", { channel_id: channelId, user_id: author.id }));
  later(wait, () => {
    const now = Date.now();
    emitMessage({ id: tid(now), channel_id: channelId, author, content, reply_to: null, attachments: [], embeds: [], reactions: [], edited_at: null, created_at: now });
  });
}

function findMessage(mid: string): Message | undefined {
  for (const list of Object.values(W!.messages)) {
    const m = list.find((x) => x.id === mid);
    if (m) return m;
  }
}

function sendMessage(cid: string, body: any): Promise<Message> {
  const w = W!;
  const now = Date.now();
  const atts: FileObj[] = (body.attachments || []).map((a: { id: string; spoiler?: boolean }) => ({ ...(uploads.get(a.id) as FileObj), spoiler: !!a.spoiler }));
  const reply = body.reply_to ? findMessage(body.reply_to) : undefined;
  const m: Message = {
    id: tid(now),
    channel_id: cid,
    author: w.me,
    content: body.content || "",
    reply_to: reply ? { id: reply.id, author_id: reply.author.id, content: reply.content } : null,
    attachments: atts,
    embeds: [],
    reactions: [],
    edited_at: null,
    created_at: now,
    nonce: body.nonce,
  };
  emitMessage(m);
  // the pretend people answer
  const text = (m.content || "").toLowerCase();
  const askedBot = !!w.bot && (cid === w.botDm || text.includes("@" + w.bot.display_name.toLowerCase()) || text.includes(`<@${w.bot.id}>`));
  if (askedBot && w.bot) {
    say(cid, w.bot, `In practice I can only give this one answer. For real, ask me anything: questions, help writing, ideas, even pictures (type /imagine and what you want).`, 1800);
  } else if (cid === w.general && !w.mayaReplied) {
    w.mayaReplied = true;
    say(cid, w.maya, `Hi ${w.me.display_name}! Welcome 😊`);
  } else if (cid === w.pictures && atts.length) {
    say(cid, w.priya, "Ooh, nice one! 😍");
  } else if (cid === w.mayaDm && !w.dmReplied) {
    w.dmReplied = true;
    say(cid, w.maya, "Got it! 👍");
  }
  return Promise.resolve(m);
}

const uploads = new Map<string, FileObj>();

function hookUpload(file: File | Blob, name: string, onProgress?: (p: number) => void): Promise<FileObj> {
  const url = URL.createObjectURL(file);
  const isImg = (file.type || "").startsWith("image/");
  const fo: FileObj = { id: tid(), filename: name, mime: file.type || "application/octet-stream", size: file.size, width: null, height: null, url, thumb_url: isImg ? url : null };
  uploads.set(fo.id, fo);
  return new Promise((resolve) => {
    let p = 0;
    const t = setInterval(() => {
      p = Math.min(1, p + 0.34);
      onProgress?.(p);
      if (p >= 1) {
        clearInterval(t);
        if (!isImg) return resolve(fo);
        // pictures get their size, so they show like real ones
        const img = new Image();
        img.onload = () => resolve({ ...fo, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve(fo);
        img.src = url;
      }
    }, 150);
  });
}

const json = (v: any) => Promise.resolve(JSON.parse(JSON.stringify(v)));

function hookApi(path: string, opts: { method?: string; body?: unknown }): Promise<any> | undefined {
  const w = W;
  if (!w) return;
  const method = (opts.method || (opts.body !== undefined ? "POST" : "GET")).toUpperCase();
  const body: any = opts.body || {};
  const [p, q] = path.split("?");
  const seg = p.split("/").filter(Boolean); // ["api", ...]
  const fake = seg.some((x) => w.ids.has(x));
  let m: RegExpMatchArray | null;

  // the one thing that must reach the server: "seen the tutorial"
  if (p === "/api/users/@me/tutorial") return;

  if ((m = p.match(/^\/api\/channels\/([^/]+)\/messages$/))) {
    const cid = m[1];
    if (method === "GET") {
      const before = new URLSearchParams(q || "").get("before");
      const list = (w.messages[cid] || []).filter((x) => !before || x.id < before);
      return json([...list].reverse());
    }
    if (method === "POST") return sendMessage(cid, body);
  }
  if ((m = p.match(/^\/api\/channels\/([^/]+)\/(typing|ack)$/))) {
    if (m[2] === "ack" && body.message_id) handleEvent("READ_STATE_UPDATE", { channel_id: m[1], last_read_id: body.message_id });
    return json({});
  }
  if ((m = p.match(/^\/api\/messages\/([^/]+)\/reactions\/(.+)$/))) {
    const msg = findMessage(m[1]);
    const emoji = decodeURIComponent(m[2]);
    if (msg) {
      const add = method === "PUT";
      const r = msg.reactions.find((x) => x.emoji === emoji);
      if (add) r ? r.users.includes(w.me.id) || r.users.push(w.me.id) : msg.reactions.push({ emoji, users: [w.me.id] });
      else if (r) r.users = r.users.filter((u) => u !== w.me.id);
      msg.reactions = msg.reactions.filter((x) => x.users.length);
      handleEvent(add ? "REACTION_ADD" : "REACTION_REMOVE", { channel_id: msg.channel_id, message_id: msg.id, emoji, user_id: w.me.id });
    }
    return json({});
  }
  if ((m = p.match(/^\/api\/messages\/([^/]+)$/))) {
    const msg = findMessage(m[1]);
    if (msg && method === "DELETE") {
      w.messages[msg.channel_id] = w.messages[msg.channel_id].filter((x) => x.id !== msg.id);
      handleEvent("MESSAGE_DELETE", { id: msg.id, channel_id: msg.channel_id });
      return json({});
    }
    if (msg && method === "PATCH") {
      msg.content = body.content ?? msg.content;
      msg.edited_at = Date.now();
      handleEvent("MESSAGE_UPDATE", { ...msg });
      return json(msg);
    }
  }
  if ((m = p.match(/^\/api\/guilds\/([^/]+)\/channels$/)) && method === "POST" && m[1] === w.guildId) {
    const c: Channel = { id: tid(), guild_id: w.guildId, kind: body.kind || "text", name: String(body.name || "new-space"), topic: "", parent_id: body.parent_id || null, position: Object.keys(w.channels).length, created_at: Date.now(), last_message_id: null };
    w.channels[c.id] = c;
    w.ids.add(c.id);
    handleEvent("CHANNEL_CREATE", c);
    return json(c);
  }
  if ((m = p.match(/^\/api\/channels\/([^/]+)$/)) && w.channels[m[1]]) {
    if (method === "DELETE") {
      delete w.channels[m[1]];
      handleEvent("CHANNEL_DELETE", { id: m[1], guild_id: w.guildId });
      return json({});
    }
    if (method === "PATCH") {
      const c = { ...w.channels[m[1]], ...body };
      w.channels[m[1]] = c;
      handleEvent("CHANNEL_UPDATE", c);
      return json(c);
    }
  }
  if ((m = p.match(/^\/api\/guilds\/([^/]+)\/members\/([^/]+)$/)) && m[1] === w.guildId && method === "DELETE") {
    delete w.members[m[2]];
    handleEvent("GUILD_MEMBER_REMOVE", { guild_id: w.guildId, user_id: m[2] });
    handleEvent("VOICE_STATE_UPDATE", { user_id: m[2], channel_id: null });
    return json({});
  }
  if ((m = p.match(/^\/api\/guilds\/([^/]+)\/invites$/)) && m[1] === w.guildId) {
    return method === "POST" ? json({ code: "PRACTICE", uses: 0, max_uses: 0, expires_at: null }) : json([]);
  }
  if (p === "/api/users/@me/channels" && method === "POST") {
    const other = body.recipient_id;
    const existing = Object.values(w.channels).find((c) => c.kind === "dm" && c.recipients?.some((r) => r.id === other));
    if (existing) return json(existing);
    const u = w.users[other];
    if (!u) return practiceNo();
    const c: Channel = { id: tid(), guild_id: null, kind: "dm", name: "", topic: "", parent_id: null, position: 0, created_at: Date.now(), last_message_id: null, recipients: [w.me, u] };
    w.channels[c.id] = c;
    w.ids.add(c.id);
    handleEvent("CHANNEL_CREATE", c);
    return json(c);
  }
  if (p === "/api/bot/dm" && w.botDm) return json(w.channels[w.botDm]);
  if ((m = p.match(/^\/api\/friends\/([^/]+)$/)) && w.friends[m[1]]) {
    const f = w.friends[m[1]];
    if (method === "PUT") {
      f.state = "friend";
      f.since = Date.now();
      handleEvent("FRIEND_UPDATE", f);
    } else if (method === "DELETE") {
      delete w.friends[m[1]];
      handleEvent("FRIEND_UPDATE", { ...f, state: "none" });
    }
    return json({});
  }
  if (p === "/api/friends" && method === "GET") return json(Object.values(w.friends));
  if (p === "/api/home") return json({ notes: w.notes, highlights: [], news: [] });
  if ((m = p.match(/^\/api\/guilds\/([^/]+)\/notes$/)) && m[1] === w.guildId && method === "GET") return json(w.notes);
  if (p === "/api/notifications" || p === "/api/voicemail" || p === "/api/parties") return method === "GET" ? json([]) : practiceNo();
  if (p === "/api/discover" && method === "GET") {
    return json({
      servers: [
        { id: tid(), name: "Board Game Club", description: "Weekly game nights", member_count: 24, join_mode: "open", icon_file_id: null, listed_at: 0 },
        { id: tid(), name: "Book Nook", description: "One book a month", member_count: 9, join_mode: "request", icon_file_id: null, listed_at: 0 },
      ].map((g) => (w.ids.add(g.id), g)),
    });
  }
  if (p === "/api/voice/leave") return json({});
  if ((m = p.match(/^\/api\/users\/([^/]+)\/profile$/)) && w.users[m[1]]) return json({ user: w.users[m[1]], bio: "", banner: null, mutual_guilds: [] });

  // anything else about the pretend world: nothing there
  if (fake) return method === "GET" ? json([]) : practiceNo();
  // real reads (settings pages) are fine; real changes are not
  if (method === "GET") return;
  return practiceNo();
}

// ---------- the practice voice room ----------

export const usePractice = create<{ joined: string | null; level: number; hearMe: boolean; camera: boolean; micError: string | null }>(() => ({
  joined: null,
  level: 0,
  hearMe: false,
  camera: false,
  micError: null,
}));

let mic: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let micRaf = 0;
let echo: HTMLAudioElement | null = null;
let chatter: number | undefined;

function joinPractice(cid: string): boolean {
  const w = W;
  if (!w || !w.channels[cid]) return false;
  usePractice.setState({ joined: cid, micError: null });
  useVoice.setState({ channelId: cid, status: "connected", speaking: [] });
  handleEvent("VOICE_STATE_UPDATE", { user_id: w.me.id, channel_id: cid, guild_id: w.guildId, muted: useVoice.getState().muted, deafened: false, video: false, screen: false });
  // the others take turns talking (their rings light up)
  clearInterval(chatter);
  chatter = window.setInterval(() => {
    const others = Object.values(useStore.getState().voiceStates)
      .filter((v) => v.channel_id === cid && v.user_id !== w.me.id)
      .map((v) => v.user_id);
    const talking = Math.random() < 0.6 && others.length ? [others[Math.floor(Math.random() * others.length)]] : [];
    const meTalking = useVoice.getState().speaking.includes(w.me.id) ? [w.me.id] : [];
    useVoice.setState({ speaking: [...talking, ...meTalking] });
  }, 1400);
  startMic();
  return true;
}

async function startMic() {
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    micCtx = new AudioContext();
    const an = micCtx.createAnalyser();
    an.fftSize = 512;
    micCtx.createMediaStreamSource(mic).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const muted = useVoice.getState().muted;
      const level = muted ? 0 : Math.min(1, peak / 60);
      usePractice.setState({ level });
      const me = W?.me.id;
      if (me) {
        const sp = useVoice.getState().speaking;
        const on = level > 0.12;
        if (on !== sp.includes(me)) useVoice.setState({ speaking: on ? [...sp, me] : sp.filter((x) => x !== me) });
      }
      micRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    usePractice.setState({ micError: "Your microphone isn't available here. Check that Llamble may use it, then try again. In practice, everything else still works." });
  }
}

export function setHearMe(on: boolean) {
  usePractice.setState({ hearMe: on });
  if (echo) {
    echo.pause();
    echo.srcObject = null;
    echo = null;
  }
  if (on && mic) {
    echo = new Audio();
    echo.srcObject = mic;
    echo.play().catch(() => {});
  }
}

export function leavePractice() {
  const w = W;
  clearInterval(chatter);
  cancelAnimationFrame(micRaf);
  setHearMe(false);
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  micCtx?.close().catch(() => {});
  micCtx = null;
  usePractice.setState({ joined: null, level: 0, camera: false });
  useVoice.setState({ channelId: null, status: "idle", speaking: [] });
  if (w) handleEvent("VOICE_STATE_UPDATE", { user_id: w.me.id, channel_id: null });
}

export const isPracticeRoom = (cid: string | null | undefined) => !!cid && !!W && !!W.channels[cid] && W.channels[cid].kind !== "text" && W.channels[cid].kind !== "dm";

// ---------- the steps ----------

export interface Step {
  id: string;
  title: string;
  text: string;
  /** what to point at (a CSS selector, or a function finding it) */
  target?: string | (() => Element | null);
  /** phones: show the list pane (true) or the open page (false) for this step */
  nav?: boolean;
  /** done when this is true (otherwise the step has a Next button) */
  done?: () => boolean;
  /** run when the step starts */
  enter?: () => void;
  /** a step you can skip past even though it waits for something */
  optional?: boolean;
}

function steps(ctx: TourCtx, w: World): Step[] {
  const started = Date.now();
  const s = () => useStore.getState();
  const tap = ctx.phone ? "Tap" : "Click";
  const hold = ctx.phone ? "press and hold" : "right-click";
  const mine = (cid: string, f: (m: Message) => boolean = () => true) => (w.messages[cid] || []).some((m) => m.author.id === w.me.id && f(m));
  const out: Step[] = [];
  const add = (st: Step | false | null) => st && out.push(st);
  const modalOpen = (kind: string) => useUI.getState().modals.some((m) => m.kind === kind);

  add({
    id: "home",
    title: "Home",
    text: "Home is where Llamble opens: notes left for you, who's around, highlights and news.",
    target: ".guild-logo",
    nav: true,
  });
  add({
    id: "server",
    title: "Servers",
    text: `A server is a group with its own spaces and people. ${tap} the Practice Server to open it.`,
    target: `[data-gid="${w.guildId}"]`,
    nav: true,
    done: () => s().selectedGuild === w.guildId,
  });
  add({
    id: "spaces",
    title: "Spaces",
    text: `Spaces are grouped by type: 💬 Chat, 🔊 Voice & Video${ctx.watch ? " and 🍿 Watch" : ""}. ${tap} 💬 general to open it.`,
    target: `[data-cid="${w.general}"]`,
    nav: true,
    enter: () => useStore.setState({ guildView: { ...s().guildView, [w.guildId]: undefined } }),
    done: () => currentChannelId() === w.general,
  });
  add({
    id: "type",
    title: "Say hello",
    text: `Type a message and press ${ctx.phone ? "the send button" : "Enter"}.`,
    target: ".composer",
    nav: false,
    done: () => mine(w.general),
  });
  add({
    id: "react",
    title: "React",
    text: ctx.phone ? "Maya answered! Press and hold her message and pick a reaction." : "Maya answered! Point at her message and pick a reaction from the little bar.",
    target: () => {
      const list = w.messages[w.general] || [];
      const last = [...list].reverse().find((m) => m.author.id === w.maya.id);
      return last ? document.getElementById("msg-" + last.id) : null;
    },
    nav: false,
    done: () => Object.values(w.messages).some((l) => l.some((m) => m.reactions.some((r) => r.users.includes(w.me.id)))),
  });
  add({
    id: "upload",
    title: "Share a picture",
    text: "Share pictures and files with the + button. Pick any picture: in practice it stays on this device.",
    target: ".composer-plus",
    nav: false,
    enter: () => currentChannelId() !== w.pictures && useStore.getState().lastChannel && selectSpace(w.pictures),
    done: () => Object.values(w.messages).some((l) => l.some((m) => m.author.id === w.me.id && m.attachments.length > 0)),
    optional: true,
  });
  add(
    !!ctx.bot && {
      id: "bot",
      title: `Ask ${ctx.bot}`,
      text: `${ctx.bot} is the AI helper on this Llamble. In any chat, type @${ctx.bot} and a question.`,
      target: ".composer",
      nav: false,
      done: () => !!w.bot && Object.values(w.messages).some((l) => l.some((m) => m.author.id === w.bot!.id && m.created_at > started)),
      optional: true,
    },
  );
  add(
    ctx.voice && {
      id: "voice",
      title: "Voice & Video",
      text: `${tap} 🔊 Hangout to go in. Theo and Priya are already there.`,
      target: `[data-cid="${w.hangout}"]`,
      nav: true,
      done: () => usePractice.getState().joined === w.hangout,
    },
  );
  add(
    ctx.voice && {
      id: "talk-room",
      title: "You're in",
      text: "Say something and watch your ring light up. Turn on Hear myself to check how you sound. The mic button mutes you.",
      target: ".practice-voice",
      nav: false,
    },
  );
  add(
    ctx.voice && {
      id: "leave",
      title: "Leave",
      text: "Leave the room with the red button.",
      target: ".practice-leave",
      nav: false,
      done: () => !usePractice.getState().joined,
    },
  );
  add(
    !!w.movies && {
      id: "watch",
      title: "Watch together",
      text: `🍿 Watch spaces play shows and movies for everyone in sync, with chat beside them. ${tap} Movie Night.`,
      target: `[data-cid="${w.movies}"]`,
      nav: true,
      done: () => usePractice.getState().joined === w.movies,
    },
  );
  add(
    !!w.movies && {
      id: "watch-room",
      title: "Movie Night",
      text: "Pick something from the library to add it to the queue. Leave when you're done.",
      target: ".practice-watch",
      nav: false,
      done: () => !usePractice.getState().joined,
      optional: true,
    },
  );
  add({
    id: "talk",
    title: "Talk",
    text: `Talk holds your direct messages, parties and voicemail. ${tap} it.`,
    target: '[data-tut="talk"]',
    nav: true,
    done: () => isMessages(s().selectedGuild),
  });
  add({
    id: "dm",
    title: "Direct messages",
    text: "Open your chat with Maya and send her something.",
    target: () => document.querySelector(`[data-cid="${w.mayaDm}"]`) || document.querySelector(".composer"),
    nav: !(currentChannelId() === w.mayaDm),
    done: () => mine(w.mayaDm),
  });
  add({
    id: "friends",
    title: ctx.people,
    text: `Your ${ctx.people.toLowerCase()} list. Jordan sent you a request: open ${ctx.people} and accept it.`,
    target: () => document.querySelector(`[data-uid="${w.jordan.id}"]`) || document.querySelector('[data-tut="friends"]'),
    nav: true,
    done: () => w.friends[w.jordan.id]?.state === "friend",
  });
  add(
    !ctx.kid && {
      id: "discover",
      title: "Find servers",
      text: "The binoculars list open servers on this Llamble that you can look at and join.",
      target: ".discover-btn",
      nav: true,
    },
  );

  // staff: only the powers they actually have
  if (ctx.perms) {
    const role = ctx.owner ? "the owner" : ctx.roleName ? `a ${ctx.roleName}` : "staff";
    add({
      id: "staff",
      title: "Staff tools",
      text: `You're ${role} in a server here, so the next steps show what you can do with that.`,
    });
  }
  add(
    !!(ctx.perms & P.MANAGE_MESSAGES) && !!w.rexMsg && {
      id: "delete",
      title: "Remove a message",
      text: ctx.phone ? "Rex posted spam in general. Press and hold it, then Delete." : "Rex posted spam in general. Point at it, open ⋯ More, then Delete.",
      target: () => document.getElementById("msg-" + w.rexMsg),
      nav: false,
      enter: () => selectSpace(w.general),
      done: () => !findMessage(w.rexMsg!),
    },
  );
  add(
    !!(ctx.perms & P.KICK) && !!w.rex && {
      id: "kick",
      title: "Kick someone",
      text: `Now kick Rex: ${hold} his name${ctx.phone ? " in the people list" : " in the member list"}, then Kick.`,
      target: () => document.querySelector(`[data-uid="${w.rex!.id}"]`) || document.querySelector(".member-list"),
      nav: false,
      enter: () => {
        selectSpace(w.general);
        useStore.setState({ memberListOpen: true });
      },
      done: () => !useStore.getState().members[w.guildId]?.[w.rex!.id],
    },
  );
  add(
    !!(ctx.perms & P.MANAGE_CHANNELS) && {
      id: "add-space",
      title: "Add a space",
      text: "Add a space with the + next to Spaces. It lands under its type.",
      target: ".spaces-head .icon-btn",
      nav: true,
      enter: () => useStore.setState({ selectedGuild: w.guildId }),
      done: () => Object.keys(w.channels).length > (w.movies ? 4 : 3) + 2,
      optional: true,
    },
  );
  add(
    !!(ctx.perms & (P.MANAGE_GUILD | P.MANAGE_ROLES)) && {
      id: "server-settings",
      title: "Server settings",
      text: `${ctx.phone ? "Press and hold" : "Right-click"} the Practice Server and pick Server Settings: roles, members, invites, bans.`,
      target: `[data-gid="${w.guildId}"]`,
      nav: true,
      done: () => modalOpen("serverSettings"),
      optional: true,
    },
  );

  add({
    id: "settings",
    title: "Your settings",
    text: `Your name, picture, look, sound and notifications${ctx.kid ? "" : ", plus Family for parents"}. ${tap} the gear.`,
    target: '[title="User Settings"]',
    nav: true,
    enter: () => useUI.setState({ modals: [] }),
    done: () => modalOpen("userSettings"),
  });
  add({
    id: "settings-look",
    title: "Look around",
    text: ctx.admin
      ? `Under My Llamble Instance you run this Llamble: accounts${ctx.master ? ", settings and updates, the AI model and remote access" : ""}. In practice, nothing you change in settings is saved to the server.`
      : "Have a look. In practice, nothing you change here is saved to the server.",
    target: ".modal",
  });
  return out;
}

function selectSpace(cid: string) {
  const w = W;
  if (!w) return;
  const c = w.channels[cid];
  if (!c) return;
  const g = c.guild_id || "@me";
  const lastChannel = { ...useStore.getState().lastChannel, [g]: cid };
  useStore.setState({ selectedGuild: g, lastChannel, guildView: { ...useStore.getState().guildView, [g]: undefined } });
}

// ---------- running it ----------

interface TourState {
  active: boolean;
  /** -1: the welcome card; steps.length: the last card */
  index: number;
  steps: Step[];
  ctx: TourCtx | null;
  /** offered automatically (a new account): Skip marks it seen */
  first: boolean;
}

export const useTour = create<TourState>(() => ({ active: false, index: -1, steps: [], ctx: null, first: false }));

const KEEP = ["llamble.lastChannel", "llamble.lastGuild", "llamble.msgTab", "llamble.collapsed", "llamble.status", "llamble.memberList"];
let saved: Record<string, string | null> = {};
let offered = false;

export async function startTutorial(first = false) {
  if (useTour.getState().active || !useStore.getState().me) return;
  if (useVoice.getState().channelId) await leaveVoice();
  const ctx = readCtx();
  saved = Object.fromEntries(KEEP.map((k) => [k, localStorage.getItem(k)]));
  disconnectGateway();
  useUI.setState({ modals: [], menu: null, lightbox: null, replyTo: {}, editing: null });
  W = buildWorld(ctx);
  apiHooks.api = hookApi;
  apiHooks.upload = hookUpload;
  voiceHooks.join = joinPractice;
  voiceHooks.leave = () => usePractice.getState().joined && leavePractice();
  handleEvent("READY", readyPayload(ctx, W));
  useStore.setState({ selectedGuild: "@home", homePage: "board", messages: {}, hasMore: {} });
  useTour.setState({ active: true, index: -1, steps: steps(ctx, W), ctx, first });
}

/** Done or skipped: tell the server (so it isn't offered again), then back to the real app. */
export async function endTutorial() {
  if (!useTour.getState().active) return;
  leavePractice();
  apiHooks.api = undefined;
  apiHooks.upload = undefined;
  voiceHooks.join = undefined;
  voiceHooks.leave = undefined;
  W = null;
  for (const u of uploads.values()) URL.revokeObjectURL(u.url);
  uploads.clear();
  useTour.setState({ active: false, index: -1, steps: [], ctx: null, first: false });
  useUI.setState({ modals: [], menu: null, lightbox: null, replyTo: {}, editing: null });
  for (const [k, v] of Object.entries(saved)) (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
  const lastChannel = JSON.parse(saved["llamble.lastChannel"] || "{}");
  useStore.setState({ ready: false, selectedGuild: "@home", homePage: "board", lastChannel, messages: {}, hasMore: {}, notes: {}, highlights: {}, news: {}, typing: {}, mentions: {}, guildView: {} });
  api("/api/users/@me/tutorial", { method: "POST" }).catch(() => {});
  connectGateway();
}

export function goStep(i: number) {
  const t = useTour.getState();
  const n = Math.max(-1, Math.min(t.steps.length, i));
  useTour.setState({ index: n });
  const st = t.steps[n];
  if (!st) return;
  st.enter?.();
  if (t.ctx?.phone && st.nav !== undefined) useStore.setState({ mobileMain: !st.nav });
}

// a new account: offer the tutorial once it has signed in
onEvent((t, d) => {
  if (t !== "READY" || useTour.getState().active || offered) return;
  if (d?.tutorial_new) {
    offered = true;
    setTimeout(() => startTutorial(true), 600);
  }
});

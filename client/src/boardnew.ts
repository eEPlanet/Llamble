// "Something new on this server's board": a dot on the server's icon AND on Home (which gathers
// every server's board), and on a phone, tapping the server opens its board first instead of
// its channel list. New means a note, highlight or news post someone else added since you last
// looked (on this device). Seeing it in either place clears both: Home's board shows every
// server's, so looking at Home marks them all seen; a server's board marks that server.
import { create } from "zustand";
import { api } from "./api";
import { onEvent, useStore } from "./store";

const KEY = "llamble.boardSeen";

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

export const useBoardNew = create<{ latest: Record<string, number>; seen: Record<string, number> }>(() => ({ latest: {}, seen: loadSeen() }));

const me = () => useStore.getState().me?.id;

function bump(gid: string | null | undefined, at: number | undefined, by: string | undefined) {
  if (!gid || !at || (by && by === me())) return;
  const latest = useBoardNew.getState().latest;
  if ((latest[gid] ?? 0) >= at) return;
  useBoardNew.setState({ latest: { ...latest, [gid]: at } });
}

/** Has this server's board got something you haven't seen? */
export function boardHasNew(gid: string): boolean {
  const { latest, seen } = useBoardNew.getState();
  // a server you've never opened here starts as "seen" (no dots everywhere on a new install)
  return (latest[gid] ?? 0) > (seen[gid] ?? Infinity);
}

export const useBoardHasNew = (gid: string) => useBoardNew((s) => (s.latest[gid] ?? 0) > (s.seen[gid] ?? Infinity));

/** Is anything new on any server's board? (the dot on Home) */
export const useAnyBoardNew = () => useBoardNew((s) => Object.keys(s.latest).some((g) => (s.latest[g] ?? 0) > (s.seen[g] ?? Infinity)));

export function markBoardSeen(gid: string) {
  const seen = { ...useBoardNew.getState().seen, [gid]: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(seen));
  useBoardNew.setState({ seen });
}

async function refresh() {
  try {
    const h = await api<any>("/api/home");
    for (const n of h.notes || []) bump(n.guild_id, n.created_at, n.author?.id);
    for (const x of h.highlights || []) bump(x.guild_id, x.created_at, x.added_by?.id);
    for (const x of h.news || []) bump(x.guild_id, x.created_at, x.author?.id);
  } catch {}
}

let timer: ReturnType<typeof setTimeout> | undefined;
onEvent((t, d) => {
  if (t === "READY") {
    // servers never opened on this device count as seen from now
    const seen = { ...useBoardNew.getState().seen };
    let changed = false;
    for (const g of ((d?.guilds || []) as any[]).map((x) => x.guild?.id).filter(Boolean))
      if (!(g in seen)) {
        seen[g] = Date.now();
        changed = true;
      }
    if (changed) {
      localStorage.setItem(KEY, JSON.stringify(seen));
      useBoardNew.setState({ seen });
    }
    clearTimeout(timer);
    timer = setTimeout(refresh, 1500);
  } else if (t === "NOTE_CREATE") bump(d.guild_id, d.created_at || Date.now(), d.author?.id);
  else if (t === "HIGHLIGHT_CREATE") bump(d.guild_id, d.created_at || Date.now(), d.added_by?.id);
  else if (t === "NEWS_CREATE") bump(d.guild_id, d.created_at || Date.now(), d.author?.id);
});

/** Mark seen whatever board is on screen now: Home's (every server) or one server's. */
function seeWhatsShown() {
  const s = useStore.getState();
  const g = s.selectedGuild;
  // on a phone a board only counts while it's actually on screen
  if (typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches && !s.mobileMain) return;
  if (g === "@home" && s.homePage === "board") {
    const fresh = Object.keys(useBoardNew.getState().latest).filter(boardHasNew);
    if (fresh.length) {
      const seen = { ...useBoardNew.getState().seen };
      for (const x of fresh) seen[x] = Date.now();
      localStorage.setItem(KEY, JSON.stringify(seen));
      useBoardNew.setState({ seen });
    }
    return;
  }
  if (g && !g.startsWith("@") && s.guildView[g] && boardHasNew(g)) markBoardSeen(g);
}
// looking at a board marks it seen (and keeps it seen while it's open)
useStore.subscribe(seeWhatsShown);
useBoardNew.subscribe((b, prev) => {
  if (b.latest !== prev.latest) seeWhatsShown();
});

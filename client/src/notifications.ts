// The Notifications desk: invites, friend requests, parties, removals… (see the server's
// api/notifications.rs). Kept in its own small store; the gateway keeps it live.
import { create } from "zustand";
import { api } from "./api";
import { onEvent, selectChannel, useStore } from "./store";

export interface Notice {
  id: string;
  kind: string;
  data: any;
  ref_id: string | null;
  created_at: number;
  read_at: number | null;
}

export const useNotices = create<{ list: Notice[]; loaded: boolean; cardRev: Record<string, number> }>(() => ({ list: [], loaded: false, cardRev: {} }));
const set = useNotices.setState;
const get = useNotices.getState;

export function useUnreadNotices(): number {
  return useNotices((s) => s.list.filter((n) => !n.read_at).length);
}

export async function loadNotices() {
  try {
    const list = await api<Notice[]>("/api/notifications");
    set({ list, loaded: true });
  } catch {}
}

export async function markRead(ids?: string[]) {
  const now = Date.now();
  set({ list: get().list.map((n) => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)) });
  await api("/api/notifications/read", { body: ids ? { ids } : {} }).catch(() => {});
}

export async function clearNotice(id: string | "all") {
  set({ list: get().list.filter((n) => (id === "all" ? !n.read_at : n.id !== id)) });
  await api(`/api/notifications/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Go to the chat an invite was posted in. */
export function openCardChat(channelId: string, party: boolean) {
  selectChannel(party ? "@parties" : "@me", channelId);
}

let wired = false;
export function wireNotices() {
  if (wired) return;
  wired = true;
  onEvent((t, d) => {
    switch (t) {
      case "READY":
        loadNotices();
        break;
      case "NOTIFICATION_CREATE":
        set({ list: [d, ...get().list.filter((n) => n.id !== d.id)] });
        break;
      case "NOTIFICATION_READ":
        set({ list: get().list.map((n) => (d.ids.includes(n.id) ? { ...n, read_at: d.read_at } : n)) });
        break;
      case "NOTIFICATION_DELETE":
        set({ list: get().list.filter((n) => !d.ids.includes(n.id)) });
        break;
      case "INVITE_CARD_UPDATE":
        set({ cardRev: { ...get().cardRev, [d.card_id]: (get().cardRev[d.card_id] || 0) + 1 } });
        break;
    }
  });
  if (useStore.getState().me) loadNotices();
}

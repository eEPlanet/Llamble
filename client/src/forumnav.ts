// Which forum post is open in each forum space (null = the post list), shared by the forum
// screen, Notifications and forum links in messages.
import { create } from "zustand";
import { selectChannel, useStore } from "./store";

export const useForumNav = create<{ open: Record<string, string | null>; focus: Record<string, string | null>; flash: string | null }>(() => ({ open: {}, focus: {}, flash: null }));

export function openForumPost(cid: string, pid: string | null, flash?: string) {
  useForumNav.setState((s) => ({ open: { ...s.open, [cid]: pid }, focus: { ...s.focus, [cid]: null }, flash: flash || null }));
}

/** Go to a forum post (and a reply in it) from anywhere: a link, a notification. */
export function goToForumPost(cid: string, pid: string, rid?: string) {
  const ch = useStore.getState().channels[cid];
  if (ch?.guild_id) selectChannel(ch.guild_id, cid);
  openForumPost(cid, pid, rid);
}

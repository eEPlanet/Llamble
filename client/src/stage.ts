// Show spaces ("stage"): the live state of each show (see server api/stage.rs), kept from
// STAGE_UPDATE events, plus which shows are live right now (for LIVE marks in the list).
import { create } from "zustand";
import { api } from "./api";
import { onEvent } from "./store";
import { leaveVoice, useVoice } from "./voice";
import { toast } from "./ui";

export type StageRole = { user_id: string; role: "host" | "moderator" | "guest"; muted: boolean };
export type StageEvent = { id: string; title: string; description: string; starts_at: number; status: string; interested: number };
export interface Stage {
  channel_id: string;
  live: boolean;
  title: string;
  live_since: number | null;
  hands_open: boolean;
  audience: string;
  /** the director's settings (the same as the recording director's: focus, hold, layout, pip, lower third, title, card) */
  director: Record<string, any>;
  event_id: string | null;
  roles: StageRole[];
  hands: { user_id: string; at: number }[];
  events: StageEvent[];
  in_room: number;
  // yours (from GET only)
  my_interested?: string[];
  following?: boolean;
  can_run?: boolean;
  can_manage?: boolean;
}

export const useStages = create<{ stages: Record<string, Stage>; live: Record<string, { title: string; live_since: number | null }> }>(() => ({ stages: {}, live: {} }));

/** Load a show's state (with your own bits: interested, following, what you can do). */
export function loadStage(cid: string) {
  return api(`/api/channels/${cid}/stage`).then((s: Stage) => useStages.setState((st) => ({ stages: { ...st.stages, [cid]: s } })));
}

onEvent((t, d) => {
  if (t === "READY") {
    const live: Record<string, { title: string; live_since: number | null }> = {};
    for (const s of d.stages || []) live[s.channel_id] = { title: s.title, live_since: s.live_since };
    useStages.setState({ live });
  } else if (t === "STAGE_UPDATE") {
    const s = d as Stage;
    useStages.setState((st) => {
      const live = { ...st.live };
      if (s.live) live[s.channel_id] = { title: s.title, live_since: s.live_since };
      else delete live[s.channel_id];
      const prev = st.stages[s.channel_id];
      // keep your own bits (only GET has them); interest counts may have changed, so refresh those
      return { live, stages: { ...st.stages, [s.channel_id]: { ...prev, ...s } } };
    });
  } else if (t === "STAGE_ENDED") {
    if (useVoice.getState().channelId === d.channel_id) {
      leaveVoice();
      toast("The show has ended");
    }
  } else if (t === "STAGE_ON") {
    toast("You're on stage! Your mic is open.");
  }
});

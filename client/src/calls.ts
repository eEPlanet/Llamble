// Calling people like a phone: ring them, hear it ringing, see "Calling…", and on their side a
// full-screen Accept / Decline that keeps ringing until they answer, decline, the caller hangs
// up, or nobody answers (the server ends the ring and leaves a "missed call" in the chat).
import { create } from "zustand";
import { api } from "./api";
import { onEvent, useStore } from "./store";
import { sounds } from "./sounds";
import { toast } from "./ui";

export interface Incoming {
  channel_id: string;
  from: string;
  ring_id: number;
  party?: string | null;
  /** added to someone else's call: you join the call but don't get its chat */
  guest?: boolean;
  /** who's already in the call (when you're being added) */
  with?: string[];
  /** their name, when we only know it from the phone's notification */
  name?: string;
  /** an urgent call: rings through Do Not Disturb, marked URGENT */
  urgent?: boolean;
}

/** Show a ringing call that the phone's notification told us about; it stops by itself. */
export function showIncoming(c: Incoming, ms: number) {
  useCalls.setState({ incoming: c }); // the phone's notification is doing the ringing
  setTimeout(() => {
    if (useCalls.getState().incoming?.ring_id === c.ring_id) useCalls.setState({ incoming: null });
  }, Math.max(1000, ms));
}
export interface Outgoing {
  channel_id: string;
  ring_id?: number;
  at: number;
}

export const useCalls = create<{
  incoming: Incoming | null;
  outgoing: Outgoing | null;
  /** the dialer-style call screen is open (else minimized to the chat) */
  view: boolean;
  /** when the call actually started (someone else joined), for the timer */
  since: number | null;
  /** calls we joined as an added guest (no chat to go back to) */
  guestOf: string | null;
  /** the call is moving to the party just made by adding someone (no hang-up in between) */
  moving: string | null;
  /** a call's party nobody has kept yet, whose call just ended: keep it or delete it */
  keepParty: string | null;
  /** our call wasn't answered: offer a voicemail */
  noAnswer: { channel_id: string; reason: string } | null;
  /** we hung up a call some people never joined: offer them a voicemail */
  missedSome: { channel_id: string; users: string[] } | null;
}>(() => ({ incoming: null, outgoing: null, view: false, since: null, guestOf: null, moving: null, keepParty: null, noAnswer: null, missedSome: null }));

/** Open (or bring back) the call screen. */
export const showCallScreen = (on = true) => useCalls.setState({ view: on });

let loop: ReturnType<typeof setInterval> | null = null;
let safety: ReturnType<typeof setTimeout> | null = null;

function startLoop(play: () => void, every: number) {
  stopLoop();
  play();
  loop = setInterval(play, every);
}
function stopLoop() {
  if (loop) clearInterval(loop);
  loop = null;
}

/** Keep the sound and the safety timer in step with what's showing. */
useCalls.subscribe((s, prev) => {
  if (s.incoming === prev.incoming && s.outgoing === prev.outgoing) return;
  if (safety) clearTimeout(safety);
  safety = null;
  if (s.incoming) {
    startLoop(sounds.ring, 2500);
    window.llambleNative?.flash();
    safety = setTimeout(() => useCalls.setState({ incoming: null }), 45_000); // the server ends it at 30 s
  } else if (s.outgoing) {
    startLoop(sounds.ringback, 3000);
    safety = setTimeout(() => useCalls.setState({ outgoing: null }), 45_000);
  } else stopLoop();
});

/** Call a DM or a party: join its call and ring the others. */
export async function startCall(channelId: string, opts: { urgent?: boolean } = {}) {
  const { joinVoice, useVoice } = await import("./voice");
  // the call screen opens straight away ("Calling…") while the call connects
  useCalls.setState({ outgoing: { channel_id: channelId, at: Date.now() }, view: true });
  if (useVoice.getState().channelId !== channelId) await joinVoice(channelId);
  if (useVoice.getState().channelId !== channelId || useVoice.getState().status === "idle") {
    useCalls.setState({ outgoing: null, view: false }); // couldn't join (the reason was shown)
    return;
  }
  try {
    const r = await api(`/api/channels/${channelId}/ring`, { method: "POST", body: { urgent: !!opts.urgent } });
    const unreachable: string[] = r.unreachable || [];
    if (!r.ringing && unreachable.length) {
      // nothing of theirs is on to ring (app closed and phone not listening): say so, and
      // go straight to leaving a voicemail, like a phone that's off
      useCalls.setState({ outgoing: null });
      hangUpIfAlone(channelId).then(() => useCalls.setState({ noAnswer: { channel_id: channelId, reason: "unreachable" } }));
      return;
    }
    if (unreachable.length) toast(`Couldn't reach ${unreachable.map(name).join(", ")}`);
    if (!r.ringing) useCalls.setState({ outgoing: null }); // everyone's already in the call
    else useCalls.setState((s) => (s.outgoing?.channel_id === channelId ? { outgoing: { ...s.outgoing, ring_id: r.ring_id } } : {}));
  } catch (e: any) {
    useCalls.setState({ outgoing: null });
    toast(e.message, "error");
  }
}

/** The caller hangs up before anyone answered. */
export async function cancelCall() {
  const o = useCalls.getState().outgoing;
  if (!o) return;
  useCalls.setState({ outgoing: null });
  api(`/api/channels/${o.channel_id}/ring/end`, { method: "POST", body: { reason: "cancelled" } }).catch(() => {});
  const { leaveVoice, useVoice } = await import("./voice");
  if (useVoice.getState().channelId === o.channel_id) leaveVoice();
}

export async function acceptCall() {
  const c = useCalls.getState().incoming;
  if (!c) return;
  useCalls.setState({ incoming: null, view: true, guestOf: c.guest ? c.channel_id : null });
  import("./gateway").then(({ wake }) => wake()); // answering: they're here now
  if (!c.guest) {
    const { selectChannel, homeOf } = await import("./store");
    selectChannel(homeOf(useStore.getState().channels[c.channel_id]), c.channel_id);
  }
  const { joinVoice } = await import("./voice");
  joinVoice(c.channel_id); // joining is the answer: the server stops the ring everywhere
}

export function declineCall() {
  const c = useCalls.getState().incoming;
  if (!c) return;
  useCalls.setState({ incoming: null });
  api(`/api/channels/${c.channel_id}/ring/end`, { method: "POST", body: { reason: "declined" } }).catch(() => {});
}

const name = (id: string) => useStore.getState().users[id]?.display_name ?? "They";

onEvent((t, d) => {
  if (t === "CALL_RING") {
    // already in that call (another device answered first): nothing to ring
    import("./voice").then(({ useVoice }) => {
      if (useVoice.getState().channelId !== d.channel_id) useCalls.setState({ incoming: { channel_id: d.channel_id, from: d.from, ring_id: d.ring_id, party: d.party, guest: !!d.guest, with: d.with || [], urgent: !!d.urgent } });
    });
  } else if (t === "CALL_RING_END") {
    const { incoming, outgoing } = useCalls.getState();
    if (incoming?.channel_id === d.channel_id) useCalls.setState({ incoming: null });
    if (outgoing?.channel_id === d.channel_id) {
      useCalls.setState({ outgoing: null });
      if (d.reason === "missed" || d.reason === "declined") {
        // nobody picked up: offer to leave a voice message for them (everyone, in a party)
        hangUpIfAlone(d.channel_id).then((alone) => alone && useCalls.setState({ noAnswer: { channel_id: d.channel_id, reason: d.reason } }));
      }
    }
  } else if (t === "CALL_MOVED") {
    // someone added people to our call: it continues in the new party
    import("./voice").then(({ useVoice }) => {
      if (useVoice.getState().channelId === d.from) moveCall(d.to);
    });
  } else if (t === "CHANNEL_UPDATE" && d.unsaved === false && useCalls.getState().keepParty === d.id) {
    // someone kept it (or wrote in its chat): nothing to ask anymore
    useCalls.setState({ keepParty: null });
    toast(`Kept as a party: ${d.name}`);
  } else if (t === "CALL_DECLINED") {
    toast(`${name(d.by)} declined the call`);
  } else if (t === "VOICE_STATE_UPDATE") {
    // someone joined the call we're ringing for: they answered
    const o = useCalls.getState().outgoing;
    const me = useStore.getState().me?.id;
    if (o && d.channel_id === o.channel_id && d.user_id !== me) useCalls.setState({ outgoing: null });
  }
});

async function hangUpIfAlone(channelId: string): Promise<boolean> {
  const { leaveVoice, useVoice } = await import("./voice");
  const me = useStore.getState().me?.id;
  const others = Object.values(useStore.getState().voiceStates).filter((v) => v.channel_id === channelId && v.user_id !== me);
  if (useVoice.getState().channelId === channelId && others.length === 0) {
    leaveVoice();
    return true;
  }
  return false;
}

/** The call goes over to another room (the party made by adding someone) without hanging up:
 *  the call screen stays, and nobody's asked about voicemail for the old one. */
export async function moveCall(to: string) {
  const { joinVoice, useVoice } = await import("./voice");
  if (useVoice.getState().channelId === to || useCalls.getState().moving === to) return;
  useCalls.setState({ moving: to });
  try {
    await joinVoice(to);
  } finally {
    useCalls.setState({ moving: null });
  }
}

/** Add friends to the call you're in: everyone on the call plus them become a new party (its
 *  own chat, named after everyone), the call moves there and they're rung. When the call ends
 *  you're asked to keep that party or delete it; writing anything in its chat keeps it. */
export async function addToCall(channelId: string, userIds: string[]) {
  if (!userIds.length) return;
  try {
    const r = await api(`/api/channels/${channelId}/call/add`, { method: "POST", body: { user_ids: userIds } });
    if (r.party_id && r.party_id !== channelId) moveCall(r.party_id);
    const unreachable: string[] = r.unreachable || [];
    if (unreachable.length) toast(`Couldn't reach ${unreachable.map(name).join(", ")} right now`);
    if (r.ringing) toast(r.ringing === 1 ? `Calling ${name(userIds.find((u) => !unreachable.includes(u))!)}…` : `Calling ${r.ringing} people…`);
  } catch (e: any) {
    toast(e.message, "error");
  }
}

/** Hang up: cancel a call nobody answered yet, or leave the one we're in. */
export async function hangUp() {
  if (useCalls.getState().outgoing) return cancelCall();
  const { leaveVoice } = await import("./voice");
  leaveVoice();
}

// the timer starts when someone else is in the call; the screen closes when we leave
import("./voice").then(({ useVoice, leaveVoice }) => {
  const others = () => {
    const v = useVoice.getState();
    const me = useStore.getState().me?.id;
    return !!v.channelId && Object.values(useStore.getState().voiceStates).some((x) => x.channel_id === v.channelId && x.user_id !== me);
  };
  // who joined the DM/party call we're in, so hanging up can offer the others a voicemail
  let session: { cid: string; joined: Set<string> } | null = null;
  const tick = () => {
    const v = useVoice.getState();
    const s = useCalls.getState();
    const me = useStore.getState().me?.id;
    if (v.channelId && v.status === "connected") {
      if (!session || session.cid !== v.channelId) session = { cid: v.channelId, joined: new Set() };
      for (const x of Object.values(useStore.getState().voiceStates)) if (x.channel_id === v.channelId && x.user_id !== me) session.joined.add(x.user_id);
    }
    if (s.moving) return; // going straight on into the new party's call
    if (!v.channelId && session) {
      const done = session;
      session = null;
      const ch = useStore.getState().channels[done.cid];
      if (ch?.kind === "party" && ch.unsaved) {
        // the call's own party, not kept yet: keep it or delete it
        useCalls.setState({ keepParty: ch.id });
      } else if (ch && (ch.kind === "dm" || ch.kind === "party") && done.joined.size > 0) {
        const missing = (ch.recipients ?? []).map((r) => r.id).filter((id) => id !== me && !done.joined.has(id));
        if (missing.length) useCalls.setState({ missedSome: { channel_id: done.cid, users: missing } });
      }
    }
    if (!v.channelId) {
      if (!s.outgoing && (s.view || s.since || s.guestOf)) useCalls.setState({ view: false, since: null, guestOf: null });
      return;
    }
    if (others() && !s.since) useCalls.setState({ since: Date.now() });
    else if (!others() && s.since && !s.outgoing) useCalls.setState({ since: null });
    // like a phone: once you're the last one left (the other person hung up, or everyone else
    // in a party call did), the call is over for you too
    const ch = useStore.getState().channels[v.channelId];
    if ((ch?.kind === "dm" || ch?.kind === "party" || s.guestOf === v.channelId) && v.status === "connected" && !s.outgoing && session?.cid === v.channelId && session.joined.size > 0 && !others()) {
      leaveVoice();
    }
  };
  useVoice.subscribe(tick);
  useStore.subscribe((st, prev) => {
    if (st.voiceStates !== prev.voiceStates) tick();
  });
});

/** Call a person (opens your chat with them, then rings). */
export async function callUser(userId: string, opts: { urgent?: boolean } = {}) {
  try {
    const dm = await api("/api/users/@me/channels", { body: { recipient_id: userId } });
    const { selectChannel } = await import("./store");
    selectChannel("@me", dm.id);
    await startCall(dm.id, opts);
  } catch (e: any) {
    toast(e.message, "error");
  }
}

/** An urgent call, after a check: it rings through their Do Not Disturb with an alarm sound. */
export function urgentCall(target: { channelId?: string; userId?: string; name: string }) {
  import("./ui").then(({ openModal }) =>
    openModal({
      kind: "confirm",
      title: "Urgent call?",
      body: `${target.name}'s phone will ring like an alarm, even on Do Not Disturb. Use it when it really can't wait.`,
      danger: true,
      confirmLabel: "Call now",
      onConfirm: () => (target.channelId ? startCall(target.channelId, { urgent: true }) : callUser(target.userId!, { urgent: true })),
    }),
  );
}

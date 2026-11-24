// Tell the server which chat this device has open, so others see who's "here" in it.
// You're "in" a chat while it's the one open in Llamble, even if you switch to another app
// (chat overlays for games will count too); you leave when you open something else in
// Llamble or close it. Chat is live, so "Hide what I'm doing" doesn't hide you here.
import { sendGateway } from "./gateway";
import { currentChannelId, onEvent, useStore } from "./store";

let sent: string | null | undefined;
let wired = false;

function wanted(): string | null {
  const s = useStore.getState();
  const cid = currentChannelId(s);
  const ch = cid ? s.channels[cid] : undefined;
  return ch && ch.kind === "text" && ch.guild_id ? ch.id : null;
}

function update() {
  const w = wanted();
  if (w === sent) return;
  sent = w;
  sendGateway("viewing", { channel_id: w });
}

export function wireViewing() {
  if (wired) return;
  wired = true;
  useStore.subscribe(update);
  // a fresh connection starts with nothing: say it again
  onEvent((t) => {
    if (t === "READY") {
      sent = undefined;
      setTimeout(update, 200);
    }
  });
}

/** Leave Invisible (show as Online), on this and every other device. */
export function goOnline() {
  const s = useStore.getState();
  localStorage.setItem("llamble.status", "online");
  sendGateway("presence", { status: "online" });
  useStore.setState({ myStatus: { ...s.myStatus, status: "online" }, presences: s.me ? { ...s.presences, [s.me.id]: "online" } : s.presences });
}

import { api, session } from "./api";
import { handleEvent, useStore } from "./store";

let ws: WebSocket | null = null;
let stopped = false;
let attempt = 0;
let pingTimer: number | undefined;
let retryTimer: number | undefined;
// when we last heard anything from the server (a dead connection can look open for a long
// time, e.g. after a phone froze the app in the background)
let lastHeard = 0;
// the server said it's restarting and when to come back (spread out, so everyone doesn't reconnect at once)
let comeBackIn = 0;

// A phone app opened only to show a ringing call doesn't make you look online: the connection
// is "quiet" until you actually use the app (answer, or tap anything else). The phone app
// starts the page with ?ring=1 for that; a ring that wakes an app already in the background
// calls ringQuiet() before it reconnects.
let quiet = (() => {
  try {
    const q = new URLSearchParams(location.search);
    if (!q.has("ring")) return false;
    q.delete("ring");
    history.replaceState(history.state, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
    return true;
  } catch {
    return false;
  }
})();

/** A ringing call brought the app back from the background: stay hidden until it's used. */
export function ringQuiet() {
  // still connected and heard from just now: they were using the app anyway
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastHeard < 40000) return;
  quiet = true;
}

/** The person is using the app now: show them online. */
export function wake() {
  if (!quiet) return;
  quiet = false;
  sendGateway("awake");
  window.dispatchEvent(new Event("llamble:awake"));
}

export const isQuiet = () => quiet;

export function connectGateway() {
  stopped = false;
  open();
}

export function disconnectGateway() {
  stopped = true;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  ws?.close();
  ws = null;
}

export function sendGateway(op: string, data: Record<string, unknown> = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, ...data }));
}

function open() {
  clearTimeout(retryTimer);
  // only ever one connection: a second one (opened while the first was still connecting)
  // delivered every event twice
  const prev = ws;
  if (prev) {
    ws = null;
    try {
      prev.close();
    } catch {}
  }
  const url = session.server.replace(/^http/, "ws") + "/api/gateway?access_token=" + encodeURIComponent(session.token) + (quiet ? "&quiet=1" : "");
  useStore.setState({ conn: "connecting" });
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    lastHeard = Date.now();
    useStore.setState({ conn: "open" });
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => {
      const sent = Date.now();
      sendGateway("ping");
      // no answer at all within 10s: the connection is dead even if it looks open
      window.setTimeout(() => {
        if (ws === sock && lastHeard < sent) restart();
      }, 10000);
    }, 30000);
    window.dispatchEvent(new Event("llamble:gateway-open"));
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return; // an old connection on its way out
    lastHeard = Date.now();
    try {
      const { t, d } = JSON.parse(e.data);
      if (t === "RESTARTING") comeBackIn = Number(d?.retry_in_ms) || 8000;
      else if (t && t !== "PONG") handleEvent(t, d);
    } catch (err) {
      console.error("gateway parse", err);
    }
  };
  sock.onclose = (e) => {
    clearInterval(pingTimer);
    if (ws !== sock) return;
    ws = null;
    useStore.setState({ conn: "closed" });
    if (stopped) return;
    if (e.code === 1008 || e.code === 4001) {
      window.dispatchEvent(new Event("llamble:unauthorized"));
      return;
    }
    if (attempt >= 2) api("/api/users/@me").catch(() => {}); // 401 here signs the user out
    let delay = Math.min(30000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    if (comeBackIn || e.code === 1012) {
      // the server is restarting (an update): come back when it said, not all at the same moment
      delay = comeBackIn || 4000 + Math.random() * 20000;
      comeBackIn = 0;
    }
    attempt++;
    retryTimer = window.setTimeout(open, delay);
  };
}

// reconnect fast when the network comes back / machine wakes
window.addEventListener("online", () => {
  if (!stopped && !ws) {
    attempt = 0;
    open();
  }
});

/** Throw away the current connection and open a new one right away. */
function restart() {
  if (stopped) return;
  const old = ws;
  ws = null;
  clearInterval(pingTimer);
  try {
    old?.close();
  } catch {}
  attempt = 0;
  open();
}

/**
 * Coming back to the app (tab shown, window focused, phone app resumed): make sure the
 * connection is really alive, and if not, replace it now instead of waiting it out.
 */
export function checkGateway() {
  if (stopped || !session.token) return;
  if (!ws) {
    clearTimeout(retryTimer);
    attempt = 0;
    open();
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return; // already connecting
  if (Date.now() - lastHeard < 15000) return; // heard from it just now
  const sent = Date.now();
  const sock = ws;
  sendGateway("ping");
  window.setTimeout(() => {
    if (ws === sock && lastHeard < sent) restart();
  }, 4000);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkGateway();
});
window.addEventListener("focus", checkGateway);
window.addEventListener("pageshow", checkGateway);
document.addEventListener("resume", checkGateway);

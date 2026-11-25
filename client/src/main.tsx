import React from "react";
import { applyTheme } from "./theme";
applyTheme();
import { checkGateway, isQuiet, ringQuiet, wake } from "./gateway";
import { useCalls } from "./calls";
import { session } from "./api";
// first: inside the Android app this sets up notifications before anything uses them
import { androidListener, androidSend, installBack, isAndroidApp, onAndroid } from "./android";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { getRoom, joinVoice, leaveVoice, micSound, setMicSound, setWatching, toggleCamera, useVoice } from "./voice";
import { PRESETS } from "./micsound";
import { homeOf, openGuildView, openHome, openLibrary, selectChannel, showMobileNav, useStore } from "./store";
import { isPhone } from "./phone";
import { useRecorder } from "./show";
import * as localrec from "./localrec";
import { startPhoneCapture } from "./phonescreen";
import { api } from "./api";
import { closeMenu, closeModal, openModal, useUI } from "./ui";

// handle for automated tests and troubleshooting from the dev console
(window as any).llambleDebug = { selectChannel, joinVoice, leaveVoice, getRoom, voice: () => useVoice.getState(), useVoice, toggleCamera, setWatching, recorder: () => useRecorder.getState(), localrec, startPhoneCapture, openLibrary, micSound, setMicSound, PRESETS, openHome, openGuildView,
  // tests: the show's music player (file handed over as base64)
  showMusic: async (b64: string, name: string) => {
    const m = await import("./showmusic");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await m.addMusic([new File([bytes], name)]);
    const it = m.useShowMusic.getState().items.at(-1)!;
    m.setMusic(it.id, { loop: true });
    await m.playMusic(it.id);
    return m.useShowMusic.getState();
  },
  // tests: a recording kept in this browser, as base64
  recordingB64: async (id: string) => {
    const url = await localrec.playUrl(id);
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  },
  // tests: open "Share to…" for a message
  openShare: async (cid: string, mid: string) => {
    const msgs = await api<any[]>(`/api/channels/${cid}/messages?limit=20`);
    const msg = msgs.find((m) => m.id === mid);
    if (msg) openModal({ kind: "share", msg });
    return !!msg;
  } };

import { OverlayApp } from "./OverlayApp";

const isOverlay = location.hash === "#overlay" && !!window.llambleNative?.overlay;
/** Last line of defence: show what broke instead of an empty window. */
class Crash extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 40, color: "#ddd", fontFamily: "sans-serif" }}>
        <h2>Something went wrong</h2>
        <p style={{ color: "#aaa" }}>{this.state.err.message}</p>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload Llamble
        </button>
      </div>
    );
  }
}

// on a plain-HTTP address, follow the server to HTTPS if it requires it now
import("./api").then((a) => a.checkHttps());
createRoot(document.getElementById("root")!).render(isOverlay ? <OverlayApp /> : <Crash><App /></Crash>);

// installable web app (only in browsers served over http(s), not inside Electron)
if (!isOverlay && !window.llambleNative && !isAndroidApp && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// ---- inside the Android app
if (isAndroidApp && !isOverlay) {
  // in a call: the app keeps running with the screen off (its "in a call" notification)
  let inCall: string | null = null;
  const sync = (v: ReturnType<typeof useVoice.getState>) => {
    // only once connected: by then the microphone has been allowed (Android won't start a
    // microphone call before that), and it stays on while reconnecting
    const on = v.channelId && (v.status === "connected" || (v.status === "reconnecting" && inCall)) ? v.channelId : null;
    if (on === inCall) return;
    inCall = on;
    const ch = on ? useStore.getState().channels[on] : null;
    // DM and party calls (and calls we were added to) start on the earpiece like a phone; voice rooms on the speaker
    const phone = !!on && (!ch || ch.kind === "dm" || ch.kind === "party");
    const who = ch?.kind === "dm" ? ch.recipients?.find((r) => r.id !== useStore.getState().me?.id)?.display_name : ch?.name;
    androidSend("voice", { on: !!on, phone, channel_id: on, title: who ? `In a call · ${who}` : "In a call" });
  };
  useVoice.subscribe(sync);
  onAndroid((m) => {
    if (m.event === "leave-voice") leaveVoice();
    if (m.event === "resume") checkGateway();
    // a tapped notification from the listener: open that chat
    if (m.event === "open-channel" && m.channel_id) wake();
    if (m.event === "open-channel" && m.channel_id) selectChannel((m.guild_id as string) || homeOf(useStore.getState().channels[String(m.channel_id)]), String(m.channel_id));
    // "Answer" on the phone's incoming-call screen (the app may only just be starting)
    if (m.event === "answer-call" && m.channel_id) (wake(), answerWhenReady(String(m.channel_id)));
    // the phone was woken by a ringing call: show it ringing (Accept / Decline), never answer
    if (m.event === "ring-call" && m.channel_id) {
      ringQuiet();
      const age = Date.now() - Number(m.at || Date.now());
      if (age < 30_000)
        import("./calls").then(({ useCalls, showIncoming }) => {
          if (!useCalls.getState().incoming) showIncoming({ channel_id: String(m.channel_id), from: String(m.from || ""), ring_id: Number(m.ring_id), party: m.party ? String(m.party) : null, guest: !!m.guest, name: String(m.name || ""), urgent: !!m.urgent }, 30_000 - age);
        });
    }
    // Android restarted the page mid-call (memory): straight back into the call
    if (m.event === "rejoin-call" && m.channel_id) rejoinWhenReady(String(m.channel_id));
  });
  // notifications while closed: tell the app's listener who's signed in (each time it opens)
  androidListener(session.server, session.token);
  // the phone's back button closes menus and windows first
  installBack(() => {
    const ui = useUI.getState();
    if (ui.menu) return closeMenu(), true;
    if (ui.modals.length) return closeModal(), true;
    // on a phone: from a page back to the server/channel list
    if (isPhone() && useStore.getState().mobileMain) return showMobileNav(true), true;
    return false;
  });
}

/** Join a call as soon as the app knows about its chat (after a cold start that takes a moment). */
function rejoinWhenReady(cid: string) {
  let tries = 0;
  const go = () => {
    if (!useStore.getState().me) return false;
    import("./voice").then((v) => v.joinVoice(cid));
    const ch = useStore.getState().channels[cid];
    if (!ch || ch.kind === "dm" || ch.kind === "party") import("./calls").then((c) => c.useCalls.setState({ view: true, guestOf: ch ? null : cid }));
    return true;
  };
  if (go()) return;
  const t = setInterval(() => (go() || ++tries > 60) && clearInterval(t), 500);
}

function answerWhenReady(cid: string) {
  const go = () => {
    const ch = useStore.getState().channels[cid];
    if (!ch) return false;
    // answered from the notification: straight to the call screen
    import("./calls").then(({ useCalls }) => useCalls.setState({ incoming: null, view: ch.kind === "dm" || ch.kind === "party" }));
    selectChannel(homeOf(ch), cid);
    import("./voice").then((v) => v.joinVoice(cid));
    return true;
  };
  if (go()) return;
  const off = useStore.subscribe(() => go() && (off(), clearTimeout(t)));
  const t = setTimeout(off, 30_000);
}

// a phone opened only by a ringing call: the first real tap or key (anything but the
// Accept / Decline screen) means they're using the app, so they show online
for (const ev of ["pointerdown", "keydown"])
  window.addEventListener(
    ev,
    () => {
      if (isQuiet() && !useCalls.getState().incoming) wake();
    },
    true,
  );

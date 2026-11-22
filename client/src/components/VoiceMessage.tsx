// A voice message in the chat (play, its text version, urgent + "Got it"), the recorder in the
// composer, and the full-screen alert for urgent ones.
import { useEffect, useRef, useState } from "react";
import { api, media } from "../api";
import { ackVoice, beep, fmtMs, saveRecording, sayGreeting, sendVoice, stopSaying, startRecording, type Recording, type VmTarget } from "../voicemsg";
import { homeOf, selectChannel, useStore } from "../store";
import { toast } from "../ui";
import type { Message } from "../types";
import { Avatar, Icon } from "./common";
import { create } from "zustand";

export function VoiceNote({ msg }: { msg: Message }) {
  const v = msg.voice!;
  const me = useStore((s) => s.me?.id);
  const users = useStore((s) => s.users);
  const file = msg.attachments[0];
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const mine = msg.author.id === me;
  const acked = !!me && v.acks.includes(me);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch(() => {});
      if ((v.urgent || v.voicemail) && !mine && !acked) {
        markHeard(msg, me!);
        ackVoice(msg.channel_id, msg.id).then(() => v.voicemail && refreshVoicemailCount());
      }
    } else a.pause();
  };
  const dur = v.duration_ms || 1;
  return (
    <div className={"vnote" + (v.urgent ? " urgent" : "")}>
      {(v.urgent || v.voicemail) && (
        <div className="vnote-flag">
          {v.urgent && "URGENT "}
          {v.voicemail && <span className="vnote-vm">VOICEMAIL{v.about ? ` · ${v.about}` : ""}</span>}
        </div>
      )}
      <div className="vnote-row">
        <button className="vnote-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          <Icon name={playing ? "pause" : "play"} size={20} />
        </button>
        <div className="vnote-bar">
          <span style={{ width: `${Math.min(100, (at / dur) * 100)}%` }} />
        </div>
        <span className="vnote-time">{fmtMs(playing || at ? at : dur)}</span>
        {file && (
          <button
            className="vnote-save"
            onClick={() => saveRecording(file.id, `${v.voicemail ? "Voicemail" : "Voice message"} from ${msg.author.display_name} ${new Date(msg.created_at).toISOString().slice(0, 10)}`)}
            title="Save as an MP3"
            aria-label="Save as an MP3"
          >
            <Icon name="download" size={16} />
          </button>
        )}
        {file && (
          <audio
            ref={audio}
            src={media(`/api/files/${file.id}`)}
            preload="none"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => (setPlaying(false), setAt(0))}
            onTimeUpdate={(e) => setAt(e.currentTarget.currentTime * 1000)}
          />
        )}
      </div>
      <div className="vnote-text">
        {v.status === "done" && (v.transcript ? v.transcript : <span className="muted">(no words heard)</span>)}
        {v.status === "pending" && <span className="muted">Writing it out…</span>}
        {v.status === "failed" && <span className="muted">Couldn't write this one out.</span>}
      </div>
      {v.urgent && (
        <div className="vnote-acks">
          {!mine && !acked && (
            <button className="btn small danger" onClick={() => ackVoice(msg.channel_id, msg.id)}>
              Got it
            </button>
          )}
          <span className="muted small">
            {v.acks.length ? `Heard by ${v.acks.map((id) => (id === me ? "you" : users[id]?.display_name ?? "someone")).join(", ")}` : "Nobody has said Got it yet"}
          </span>
        </div>
      )}
    </div>
  );
}

/** The recording bar that replaces the message box while recording. */
export function VoiceRecorder({ channelId, canUrgent, onDone }: { channelId: string; canUrgent: boolean; onDone: () => void }) {
  const rec = useRef<Recording | null>(null);
  const [ms, setMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [urgent, setUrgent] = useState(false);
  const [ready, setReady] = useState(false);
  const urgentRef = useRef(false);
  urgentRef.current = urgent;
  const finish = async () => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    const out = await r.stop();
    onDone();
    if (!out) return toast("Too short to send");
    sendVoice(channelId, out.wav, out.ms, urgentRef.current);
  };
  useEffect(() => {
    let alive = true;
    startRecording(() => finish())
      .then((r) => {
        if (!alive) return r.cancel();
        rec.current = r;
        setReady(true);
      })
      .catch(() => {
        toast("Couldn't use the microphone", "error");
        onDone();
      });
    const t = setInterval(() => {
      if (rec.current) {
        setMs(rec.current.ms());
        setLevel(rec.current.level());
      }
    }, 100);
    return () => {
      alive = false;
      clearInterval(t);
      rec.current?.cancel();
    };
  }, []);
  return (
    <div className="vrec">
      <button className="icon-btn" title="Throw it away" onClick={() => (rec.current?.cancel(), (rec.current = null), onDone())}>
        <Icon name="trash" size={20} />
      </button>
      <span className="vrec-dot" style={{ transform: `scale(${1 + Math.min(1, level * 3) * 0.6})` }} />
      <span className="vrec-time">{ready ? fmtMs(ms) : "Starting…"}</span>
      <span className="grow" />
      {canUrgent && (
        <button className={"vrec-urgent" + (urgent ? " on" : "")} onClick={() => setUrgent(!urgent)} title="Alert everyone like an emergency">
          Urgent
        </button>
      )}
      <button className="btn small primary" disabled={!ready} onClick={finish}>
        <Icon name="send" size={16} /> Send
      </button>
    </div>
  );
}

// ---- the full-screen alert for an urgent voice message ----

export const useUrgent = create<{ msg: Message | null }>(() => ({ msg: null }));
let siren: (() => void) | null = null;

export function UrgentAlert() {
  const msg = useUrgent((s) => s.msg);
  const ch = useStore((s) => (msg ? s.channels[msg.channel_id] : undefined));
  useEffect(() => {
    if (!msg) return;
    let stop = false;
    const loop = () => {
      if (stop) return;
      import("../sounds").then((m) => (m.sounds as any).siren?.() ?? m.sounds.ring());
      setTimeout(loop, 1800);
    };
    loop();
    navigator.vibrate?.([600, 300, 600, 300, 600]);
    siren = () => (stop = true);
    return () => {
      stop = true;
      siren = null;
    };
  }, [msg?.id]);
  if (!msg) return null;
  const close = () => useUrgent.setState({ msg: null });
  return (
    <div className="call-screen urgent-screen" role="alertdialog" aria-label="Urgent voice message">
      <div className="call-card">
        <div className="urgent-badge">URGENT</div>
        <Avatar user={msg.author} size={110} />
        <div className="call-name">{msg.author.display_name}</div>
        <div className="muted">{ch?.kind === "party" ? `sent an urgent voice message to ${ch.name}` : "sent you an urgent voice message"}</div>
        <div className="urgent-note">
          <VoiceNote msg={msg} />
        </div>
        <div className="row" style={{ gap: 12, marginTop: 16 }}>
          <button
            className="btn danger"
            onClick={() => {
              ackVoice(msg.channel_id, msg.id);
              close();
            }}
          >
            Got it
          </button>
          <button
            className="btn"
            onClick={() => {
              close();
              if (ch) selectChannel(homeOf(ch), ch.id);
            }}
          >
            Open the chat
          </button>
        </div>
      </div>
    </div>
  );
}

/** Called for every new message: urgent voice messages from others pop the alert. */
export function maybeUrgent(m: Message) {
  const me = useStore.getState().me?.id;
  if (!m.voice?.urgent || m.author.id === me) return;
  useUrgent.setState({ msg: m });
}
/** Keep the alert's copy fresh (text version arriving, someone saying Got it). */
export function urgentUpdated(m: Message) {
  const cur = useUrgent.getState().msg;
  if (cur && cur.id === m.id) useUrgent.setState({ msg: m });
}
export const stopSiren = () => siren?.();

// ---- voicemail: greeting, the tone, record, then Listen / Re-record / Send ----

export function VoicemailRecorder({ targets, about, canUrgent, onDone }: { targets: VmTarget[]; about?: string; canUrgent: boolean; onDone: () => void }) {
  const [step, setStep] = useState<"greeting" | "recording" | "review">("greeting");
  const [take, setTake] = useState(0);
  const rec = useRef<Recording | null>(null);
  const [ms, setMs] = useState(0);
  const [result, setResult] = useState<{ wav: Blob; ms: number } | null>(null);
  const [urgent, setUrgent] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const names = targets.map((t) => t.name);
  const who = names.length === 1 ? names[0] : names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const greeting = `${who} ${names.length === 1 ? "can't" : "couldn't"} answer right now. Leave a message after the tone.`;
  const stop = async () => {
    const r = rec.current;
    rec.current = null;
    const out = r ? await r.stop() : null;
    if (!out) {
      toast("Too short. Try again.");
      setTake((t) => t + 1);
      return;
    }
    setResult(out);
    setStep("review");
  };
  // greeting → tone → record (again for each re-record)
  useEffect(() => {
    let alive = true;
    setStep("greeting");
    setResult(null);
    (take === 0 ? sayGreeting(greeting) : Promise.resolve())
      .then(async () => {
        if (alive) await beep();
      })
      .then(async (): Promise<Recording | null> => (alive ? startRecording(() => stop()) : null))
      .then((r) => {
        if (!r) return;
        if (!alive) return r.cancel();
        rec.current = r;
        setStep("recording");
      })
      .catch(() => {
        toast("Couldn't use the microphone", "error");
        onDone();
      });
    const t = setInterval(() => rec.current && setMs(rec.current.ms()), 200);
    return () => {
      alive = false;
      clearInterval(t);
      rec.current?.cancel();
      rec.current = null;
      stopSaying();
    };
  }, [take]);
  useEffect(() => {
    if (!result) return;
    const u = URL.createObjectURL(result.wav);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [result]);
  const send = async () => {
    if (!result) return;
    onDone();
    for (const t of targets) await sendVoice(t.channelId, result.wav, result.ms, urgent, { voicemail: true, about });
    toast(targets.length === 1 ? `Voicemail sent to ${targets[0].name}` : "Voicemail sent");
  };
  return (
    <div className="vmail">
      {step === "greeting" && <div className="vmail-greet">“{greeting}”</div>}
      {step === "recording" && (
        <div className="vrec">
          <span className="vrec-dot" />
          <span className="vrec-time">Recording {fmtMs(ms)}</span>
          <span className="grow" />
          <button className="btn small" onClick={() => setTake((t) => t + 1)} title="Throw this one away and start over">
            Start over
          </button>
          <button className="btn small primary" onClick={stop}>
            Stop
          </button>
        </div>
      )}
      {step === "review" && result && (
        <>
          <div className="vmail-review">
            {url && <audio src={url} controls preload="auto" style={{ width: "100%" }} />}
          </div>
          <div className="noanswer-actions">
            {canUrgent && (
              <button className={"vrec-urgent" + (urgent ? " on" : "")} onClick={() => setUrgent(!urgent)}>
                {urgent ? "Urgent: everyone gets an emergency alert" : "Mark urgent"}
              </button>
            )}
            <button className="btn primary" onClick={send}>
              <Icon name="send" size={18} /> Send voicemail ({fmtMs(result.ms)})
            </button>
            <button className="btn" onClick={() => setTake((t) => t + 1)}>
              <Icon name="mic" size={18} /> Re-record
            </button>
            <button className="btn" onClick={onDone}>
              Don't send
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Show it as heard straight away (the chat and Voicemail), while the server is told. */
function markHeard(msg: Message, me: string) {
  const s = useStore.getState();
  const list = s.messages[msg.channel_id];
  if (list) useStore.setState({ messages: { ...s.messages, [msg.channel_id]: list.map((m) => (m.id === msg.id && m.voice ? { ...m, voice: { ...m.voice, acks: [...m.voice.acks, me] } } : m)) } });
  window.dispatchEvent(new CustomEvent("llamble-voicemail-heard", { detail: msg.id }));
  if (msg.voice?.voicemail) useVoicemailCount.setState((c) => ({ n: Math.max(0, c.n - 1) }));
}

/** The Voicemail tab's list: one row per voicemail (who, when, NEW). Tap one and it opens
 *  right there with its player, Save MP3, Open chat and Delete. No separate page. */
export function VoicemailInbox() {
  const [list, setList] = useState<Message[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const me = useStore((s) => s.me?.id);
  const channels = useStore((s) => s.channels);
  const load = () => api("/api/voicemail").then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
    const on = () => load();
    const heard = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      const meId = useStore.getState().me?.id;
      if (meId) setList((l) => l?.map((m) => (m.id === id && m.voice && !m.voice.acks.includes(meId) ? { ...m, voice: { ...m.voice, acks: [...m.voice.acks, meId] } } : m)) ?? l);
    };
    window.addEventListener("llamble-voicemail", on);
    window.addEventListener("llamble-voicemail-heard", heard);
    return () => {
      window.removeEventListener("llamble-voicemail", on);
      window.removeEventListener("llamble-voicemail-heard", heard);
    };
  }, []);
  const remove = (m: Message) =>
    api(`/api/voicemail/${m.id}`, { method: "DELETE" })
      .then(() => {
        setList((l) => l?.filter((x) => x.id !== m.id) ?? l);
        refreshVoicemailCount();
        toast("Voicemail deleted. It's still in your chat with " + m.author.display_name + ".");
      })
      .catch((e) => toast(e.message, "error"));
  return (
    <div className="channel-scroll vm-list">
      {list === null && <p className="muted small pad">Loading…</p>}
      {list?.length === 0 && <p className="muted small pad">No voicemail. When someone calls and you don't answer, the message they leave shows up here.</p>}
      {list?.map((m) => {
        const ch = channels[m.channel_id];
        const heard = !!me && m.voice!.acks.includes(me);
        const isOpen = open === m.id;
        const where = m.voice?.about ? m.voice.about : ch?.kind === "party" ? ch.name : "";
        return (
          <div key={m.id} className={"vm-row" + (isOpen ? " open" : "") + (heard ? "" : " new")}>
            <button className="vm-head" onClick={() => setOpen(isOpen ? null : m.id)} aria-expanded={isOpen}>
              <Avatar user={m.author} size={36} />
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="vm-name ellipsis">
                  {m.author.display_name} {!heard && <span className="vmail-new">NEW</span>}
                </span>
                <span className="muted small ellipsis">
                  {fmtWhen(m.created_at)} · {fmtMs(m.voice!.duration_ms)}
                  {where ? ` · ${where}` : ""}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
            {isOpen && (
              <div className="vm-body">
                <VoiceNote msg={m} />
                <div className="vm-actions">
                  {m.attachments[0] && (
                    <button className="btn small" onClick={() => saveRecording(m.attachments[0].id, `Voicemail from ${m.author.display_name} ${new Date(m.created_at).toISOString().slice(0, 10)}`)}>
                      <Icon name="download" size={15} /> Save MP3
                    </button>
                  )}
                  {ch && (
                    <button className="btn small" onClick={() => selectChannel(homeOf(ch), ch.id)}>
                      <Icon name="chat" size={15} /> Open chat
                    </button>
                  )}
                  <button className="btn small danger" onClick={() => remove(m)}>
                    <Icon name="trash" size={15} /> Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Desktop: the space next to the Voicemail list. */
export function VoicemailPage() {
  return (
    <div className="empty-main">
      <div className="empty-art">📞</div>
      <h2>Voicemail</h2>
      <p className="muted">Messages people left when you didn't answer. Pick one on the left to play it, save it as an MP3 or delete it.</p>
    </div>
  );
}

function fmtWhen(t: string | number) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

/** How many voicemails you haven't listened to (for the Home list). */
export const useVoicemailCount = create<{ n: number }>(() => ({ n: 0 }));
export function refreshVoicemailCount() {
  const me = useStore.getState().me?.id;
  api("/api/voicemail")
    .then((l: Message[]) => useVoicemailCount.setState({ n: l.filter((m) => !m.voice?.acks.includes(me || "")).length }))
    .catch(() => {});
  window.dispatchEvent(new Event("llamble-voicemail"));
}

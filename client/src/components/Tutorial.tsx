// The tutorial's on-screen guide (a spotlight on what to use, and a card saying what to do),
// plus the practice voice and Watch rooms. See tutorial.ts for the pretend world.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { endTutorial, goStep, leavePractice, setHearMe, usePractice, useTour } from "../tutorial";
import type { Channel } from "../types";
import { toggleDeafen, toggleMute, useVoice } from "../voice";
import { Avatar, Icon } from "./common";
import { useUI } from "../ui";

export function TutorialGuide() {
  const t = useTour();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ w: 320, h: 160 });
  const step = t.index >= 0 ? t.steps[t.index] : undefined;
  // a right-click menu is open: step aside so its choices can be picked
  const menuOpen = useUI((u) => !!u.menu);

  // follow the thing we're pointing at (it can move, open or close)
  useEffect(() => {
    if (!t.active) return;
    const find = () => {
      const tg = step?.target;
      const el = !tg ? null : typeof tg === "string" ? document.querySelector(tg) : tg();
      const r = el?.getBoundingClientRect();
      setRect(r && r.width > 0 && r.height > 0 ? r : null);
    };
    find();
    const i = setInterval(find, 250);
    return () => clearInterval(i);
  }, [t.active, step]);

  // done with what the step asked: on to the next
  useEffect(() => {
    if (!t.active || !step?.done) return;
    const idx = t.index;
    const i = setInterval(() => {
      if (step.done!() && useTour.getState().index === idx) {
        clearInterval(i);
        setTimeout(() => useTour.getState().index === idx && goStep(idx + 1), 700);
      }
    }, 300);
    return () => clearInterval(i);
  }, [t.active, step, t.index]);

  useLayoutEffect(() => {
    const c = card.current;
    if (c && (c.offsetWidth !== cardSize.w || c.offsetHeight !== cardSize.h)) setCardSize({ w: c.offsetWidth, h: c.offsetHeight });
  }, [t.index, rect?.top, rect?.left]);

  if (!t.active) return null;
  const phone = !!t.ctx?.phone;
  const total = t.steps.length;

  if (t.index < 0 || t.index >= total) {
    const start = t.index < 0;
    return (
      <div className="tut-dim">
        <div className="tut-card center" role="dialog">
          <div className="tut-emoji">{start ? "👋" : "🎉"}</div>
          <h2>{start ? `Welcome to Llamble, ${t.ctx?.name}!` : "That's the tour!"}</h2>
          {start ? (
            <p>
              Here's a quick tour of the real app with a <b>practice server</b>. Everything in it is pretend: the people, the messages, the rooms. Nothing you do reaches anyone, so try anything.
            </p>
          ) : (
            <p>You can take it again any time from Settings → Tutorial. Now back to your real Llamble.</p>
          )}
          <div className="tut-buttons">
            {start ? (
              <>
                <button className="btn" onClick={() => endTutorial()}>
                  Skip tutorial
                </button>
                <button className="btn primary" onClick={() => goStep(0)}>
                  Start
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={() => goStep(total - 1)}>
                  Back
                </button>
                <button className="btn primary" onClick={() => endTutorial()}>
                  Finish
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // where the card goes: under or over the spotlight, else the middle (phones: the bottom)
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let style: React.CSSProperties;
  if (phone) {
    style = rect && rect.top > vh * 0.55 ? { left: 8, right: 8, top: 8 } : { left: 8, right: 8, bottom: 8 };
  } else if (rect) {
    const below = rect.bottom + pad + cardSize.h < vh;
    const above = rect.top - pad - cardSize.h > 0;
    const right = rect.right + pad + cardSize.w < vw;
    if (rect.height > vh * 0.5 && right) style = { left: rect.right + pad * 2, top: Math.max(8, Math.min(vh - cardSize.h - 8, rect.top + 40)) };
    else if (below) style = { left: clamp(rect.left, 8, vw - cardSize.w - 8), top: rect.bottom + pad * 2 };
    else if (above) style = { left: clamp(rect.left, 8, vw - cardSize.w - 8), top: rect.top - cardSize.h - pad * 2 };
    else if (right) style = { left: rect.right + pad * 2, top: clamp(rect.top, 8, vh - cardSize.h - 8) };
    else style = { left: clamp(rect.left - cardSize.w - pad * 2, 8, vw - cardSize.w - 8), top: clamp(rect.top, 8, vh - cardSize.h - 8) };
  } else {
    style = { left: (vw - cardSize.w) / 2, top: (vh - cardSize.h) / 2 };
  }
  const waits = !!step!.done;
  return (
    <>
      {rect ? (
        <div className="tut-spot" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />
      ) : (
        <div className="tut-dim passthrough" />
      )}
      <div className={"tut-card" + (phone ? " phone" : "") + (menuOpen ? " aside" : "")} ref={card} style={style} role="dialog" aria-live="polite">
        <div className="tut-top">
          <span className="tut-count">
            {t.index + 1} of {total}
          </span>
          <button className="icon-btn tiny" title="End the tutorial" onClick={() => endTutorial()}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <h3>{step!.title}</h3>
        <p>{step!.text}</p>
        <div className="tut-buttons">
          <button className="btn small" onClick={() => goStep(t.index - 1)}>
            Back
          </button>
          {(!waits || step!.optional) && (
            <button className={"btn small" + (waits ? "" : " primary")} onClick={() => goStep(t.index + 1)}>
              {waits ? "Skip this step" : "Next"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A practice room: you, the pretend people, your mic level, and Hear myself. */
export function PracticeVoice({ channel }: { channel: Channel }) {
  const p = usePractice();
  const v = useVoice();
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const voiceStates = useStore((s) => s.voiceStates);
  const here = Object.values(voiceStates).filter((x) => x.channel_id === channel.id);
  const joined = p.joined === channel.id;
  if (!joined) {
    return (
      <div className="voice-view idle">
        <Icon name="speaker" size={48} />
        <h2>{channel.name}</h2>
        <p className="muted">{here.length ? `${here.length} connected` : "No one is here yet."}</p>
        <button className="btn green" onClick={() => import("../voice").then((x) => x.joinVoice(channel.id))}>
          Join Voice
        </button>
      </div>
    );
  }
  return (
    <div className="voice-view practice-voice">
      <header className="chat-header">
        <span className="chat-head-emoji">🔊</span>
        <span className="chat-title">{channel.name}</span>
        <span className="voice-label connected">Practice</span>
      </header>
      {p.micError && <div className="voice-alert error">{p.micError}</div>}
      <div className={"tile-grid n" + Math.min(here.length, 9)}>
        {here.map((x) => {
          const u = users[x.user_id];
          const talking = v.speaking.includes(x.user_id);
          return (
            <div key={x.user_id} className={"tile" + (talking ? " speaking" : "")}>
              <Avatar user={u} size={72} speaking={talking} />
              <div className="tile-name">
                {u?.display_name}
                {x.user_id === me?.id && v.muted && <Icon name="micOff" size={14} className="red" />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="call-controls">
        <button className={"call-btn" + (v.muted ? " red" : "")} onClick={toggleMute} title={v.muted ? "Unmute" : "Mute"}>
          <Icon name={v.muted ? "micOff" : "mic"} size={22} />
        </button>
        <button className={"call-btn" + (v.deafened ? " red" : "")} onClick={toggleDeafen} title={v.deafened ? "Undeafen" : "Deafen"}>
          <Icon name={v.deafened ? "deaf" : "headphones"} size={22} />
        </button>
        <button className={"call-btn" + (p.hearMe ? " on" : "")} onClick={() => setHearMe(!p.hearMe)} title="Hear myself (use headphones)">
          <Icon name="speaker" size={22} />
        </button>
        <button className="call-btn hang practice-leave" onClick={() => leavePractice()} title="Leave">
          <Icon name="phoneOff" size={22} />
        </button>
      </div>
    </div>
  );
}

const SHOWS = [
  { title: "Moonlight Picnic", c: ["#3d5a80", "#98c1d9"], e: "🌙" },
  { title: "The Robot Garden", c: ["#2a9d8f", "#e9c46a"], e: "🤖" },
  { title: "Big Snow Day", c: ["#8ecae6", "#ffffff"], e: "⛄" },
  { title: "The Lost Kite", c: ["#f4a261", "#e76f51"], e: "🪁" },
  { title: "Deep Sea Friends", c: ["#023047", "#219ebc"], e: "🐙" },
  { title: "Dino Road Trip", c: ["#606c38", "#dda15e"], e: "🦕" },
];

/** A practice Watch room: a made-up library, a queue, and the room's people. */
export function PracticeWatch({ channel }: { channel: Channel }) {
  const p = usePractice();
  const [queue, setQueue] = useState<string[]>([]);
  const [tab, setTab] = useState<"library" | "queue">("library");
  const joined = p.joined === channel.id;
  if (!joined) {
    return (
      <div className="voice-view idle">
        <span style={{ fontSize: 48 }}>🍿</span>
        <h2>{channel.name}</h2>
        <button className="btn green" onClick={() => import("../voice").then((x) => x.joinVoice(channel.id))}>
          Join Watch
        </button>
      </div>
    );
  }
  const playing = SHOWS.find((s) => s.title === queue[0]);
  return (
    <div className="voice-view practice-watch">
      <header className="chat-header">
        <span className="chat-head-emoji">🍿</span>
        <span className="chat-title">{channel.name}</span>
        <span className="voice-label connected">Practice</span>
      </header>
      <div className="practice-screen" style={playing ? { background: `linear-gradient(135deg, ${playing.c[0]}, ${playing.c[1]})` } : undefined}>
        {playing ? (
          <>
            <span className="practice-screen-emoji">{playing.e}</span>
            <b>{playing.title}</b>
            <div className="practice-progress">
              <div />
            </div>
          </>
        ) : (
          <span className="muted">Nothing playing yet. Add something to the queue.</span>
        )}
      </div>
      <div className="watch-tabs">
        <button className={"watch-tab" + (tab === "library" ? " on" : "")} onClick={() => setTab("library")}>
          📚 Library
        </button>
        <button className={"watch-tab" + (tab === "queue" ? " on" : "")} onClick={() => setTab("queue")}>
          🎬 Queue{queue.length ? ` (${queue.length})` : ""}
        </button>
      </div>
      {tab === "library" ? (
        <div className="practice-posters">
          {SHOWS.map((s) => (
            <button key={s.title} className="practice-poster" onClick={() => setQueue((q) => (q.includes(s.title) ? q : [...q, s.title]))} title="Add to the queue">
              <div style={{ background: `linear-gradient(160deg, ${s.c[0]}, ${s.c[1]})` }}>{s.e}</div>
              <span>{s.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="practice-queue">
          {queue.length ? queue.map((q, i) => <div key={q}>{i === 0 ? "▶ " : `${i + 1}. `}{q}</div>) : <p className="muted">The queue is empty.</p>}
        </div>
      )}
      <div className="call-controls">
        <button className="call-btn hang practice-leave" onClick={() => leavePractice()} title="Leave">
          <Icon name="phoneOff" size={22} />
        </button>
      </div>
    </div>
  );
}

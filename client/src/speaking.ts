// Who's talking, worked out right here from the sound itself (about every 50 ms), so the green
// ring lights up with the voice. The voice server also says who's talking, but a fraction of a
// second late; that's only used if listening here isn't possible.
import { Track, type Participant, type Room } from "livekit-client";
import { micContext } from "./micfx";

const LOUD = 0.012; // RMS of a quiet speaking voice
const HOLD_MS = 350; // stay lit through the little gaps between words

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const taps = new Map<string, { track: MediaStreamTrack; an: AnalyserNode; src: MediaStreamAudioSourceNode; last: number }>();
const buf = new Float32Array(512);

/** Start listening in a call; `set` gets the list of who's talking whenever it changes. */
export function startSpeaking(room: Room, set: (ids: string[]) => void): boolean {
  stopSpeaking();
  try {
    // the same sound context as the mic chain: one sound connection, not two (on phones a second
    // one could pull call sound onto the wrong speaker)
    ctx = micContext();
  } catch {
    return false;
  }
  let shown = "";
  timer = setInterval(() => {
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = performance.now();
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const seen = new Set<string>();
    const talking: string[] = [];
    for (const p of all) {
      const pub = p.getTrackPublication(Track.Source.Microphone);
      const mst = pub && !pub.isMuted ? pub.track?.mediaStreamTrack : undefined;
      if (!mst || mst.readyState !== "live") continue;
      seen.add(p.identity);
      let tap = taps.get(p.identity);
      if (!tap || tap.track !== mst) {
        tap?.src.disconnect();
        const src = ctx.createMediaStreamSource(new MediaStream([mst]));
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        tap = { track: mst, an, src, last: 0 };
        taps.set(p.identity, tap);
      }
      tap.an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      if (Math.sqrt(sum / buf.length) > LOUD) tap.last = now;
      if (now - tap.last < HOLD_MS) talking.push(p.identity);
    }
    for (const [id, tap] of taps)
      if (!seen.has(id)) {
        tap.src.disconnect();
        taps.delete(id);
      }
    const key = talking.join(",");
    if (key !== shown) {
      shown = key;
      set(talking);
    }
  }, 50);
  return true;
}

export function stopSpeaking() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const t of taps.values()) t.src.disconnect();
  taps.clear();
  ctx = null; // shared with the mic chain: not ours to close
}

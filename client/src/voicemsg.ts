// Voice messages: record from the mic as 16 kHz mono WAV (what the instance's own speech
// recognition reads to write out the text version), upload it, post it. Urgent ones alert
// everyone in the DM or party like an emergency until they tap "Got it".
import { api, media, upload } from "./api";
import { androidSend, isAndroidApp, onAndroid } from "./android";
import { toast } from "./ui";

export const MAX_MS = 5 * 60_000;

export interface Recording {
  stop: () => Promise<{ audio: Blob; ms: number } | null>;
  cancel: () => void;
  level: () => number;
  ms: () => number;
}

/** The mic you picked in Settings, with the noise/echo/volume options from your Mic sound. */
async function openMic(): Promise<MediaStream> {
  const { micSound, prefs } = await import("./voice");
  const m = micSound();
  const dev = prefs.get("audioInput");
  const want = (deviceId?: string) =>
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: m.echoCancellation, noiseSuppression: m.noise !== "off", autoGainControl: m.autoGainControl, channelCount: 1 },
    });
  try {
    return await want(dev || undefined);
  } catch (e) {
    if (dev) return want(); // the picked mic is gone: use the default one
    throw e;
  }
}

/** Opus at your Mic sound quality, capped by the server's maximum (and at least voice quality). */
async function voiceBitrate(): Promise<number> {
  const { micSound, micLimits } = await import("./voice");
  return Math.max(24_000, Math.min(micSound().bitrate, micLimits().max));
}

function recorderType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=opus", "audio/webm"]) if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}

export async function startRecording(onLimit: () => void): Promise<Recording> {
  const stream = await openMic();
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // level meter
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const level = () => {
    an.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i += 8) m = Math.max(m, Math.abs(buf[i]));
    return m;
  };
  const started = performance.now();
  const limit = window.setInterval(() => performance.now() - started > MAX_MS && onLimit(), 500);
  const close = () => {
    clearInterval(limit);
    try {
      src.disconnect();
    } catch {}
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
  const type = recorderType();
  if (type) {
    // full quality (Opus); the server makes the 16 kHz copy its speech recognition reads
    const rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: await voiceBitrate() });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.start(1000);
    return {
      level,
      ms: () => performance.now() - started,
      cancel: () => {
        rec.onstop = null;
        try {
          rec.stop();
        } catch {}
        close();
      },
      stop: () =>
        new Promise((done) => {
          const ms = Math.round(performance.now() - started);
          rec.onstop = () => {
            close();
            done(ms < 600 ? null : { audio: new Blob(parts, { type: type.split(";")[0] }), ms });
          };
          rec.stop();
        }),
    };
  }
  // no recorder here: 16 kHz WAV the old way
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let done = false;
  proc.onaudioprocess = (e) => {
    if (!done) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  src.connect(proc);
  // a ScriptProcessor only runs while connected to the output; it outputs silence
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.connect(mute).connect(ctx.destination);
  return {
    level,
    ms: () => performance.now() - started,
    cancel: () => {
      done = true;
      proc.disconnect();
      close();
    },
    stop: async () => {
      const ms = Math.round(performance.now() - started);
      const rate = ctx.sampleRate;
      done = true;
      proc.disconnect();
      close();
      if (ms < 600) return null;
      return { audio: toWav16k(chunks, rate), ms };
    },
  };
}

/** Float samples at `rate` → 16 kHz, mono, 16-bit WAV */
function toWav16k(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const ratio = rate / 16000;
  const n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    // average the samples that fall into this output sample (a simple low-pass)
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const w = (p: number, s: string) => [...s].forEach((ch, i) => dv.setUint8(p + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  w(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true);
  dv.setUint32(28, 32000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

const EXT: Record<string, string> = { "audio/wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a" };

export async function sendVoice(channelId: string, audio: Blob, ms: number, urgent: boolean, extra?: { voicemail?: boolean; about?: string }) {
  try {
    const f = await upload(audio, `${extra?.voicemail ? "Voicemail" : "Voice message"} ${new Date().toLocaleString()}.${EXT[audio.type] || "webm"}`);
    await api(`/api/channels/${channelId}/messages`, { body: { content: "", attachments: [{ id: f.id }], voice: { duration_ms: ms, urgent, ...extra } } });
  } catch (e: any) {
    toast(e.message || "Couldn't send the voice message", "error");
  }
}

export async function ackVoice(channelId: string, messageId: string) {
  try {
    await api(`/api/channels/${channelId}/messages/${messageId}/ack`, { method: "POST" });
  } catch (e: any) {
    toast(e.message, "error");
  }
}

export function fmtMs(ms: number) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The beep before a voicemail. */
export function beep(): Promise<void> {
  return new Promise((done) => {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 1000;
      g.gain.value = 0.25;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.45);
      o.onended = () => (ctx.close().catch(() => {}), done());
    } catch {
      done();
    }
  });
}

export function stopSaying() {
  if (isAndroidApp) androidSend("say-stop");
  (window as any).speechSynthesis?.cancel?.();
}

/** Say the greeting out loud where the device can (else it's only shown on screen). */
export function sayGreeting(text: string): Promise<void> {
  // the Android app has no browser voice: the phone says it, out loud on the speaker
  if (isAndroidApp)
    return new Promise((done) => {
      const id = "g" + Date.now();
      const off = onAndroid((m) => {
        if (m.event === "said" && m.id === id) finish();
      });
      const t = setTimeout(() => finish(), 12000); // never wait forever on a silent voice
      function finish() {
        clearTimeout(t);
        off?.();
        done();
      }
      androidSend("say", { text, id });
    });
  return new Promise((done) => {
    const s = (window as any).speechSynthesis as SpeechSynthesis | undefined;
    if (!s || typeof SpeechSynthesisUtterance === "undefined") return setTimeout(done, 1200);
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.onend = () => done();
      u.onerror = () => done();
      s.speak(u);
      setTimeout(done, 9000); // never wait forever on a silent voice
    } catch {
      done();
    }
  });
}

export interface VmTarget {
  /** where it's posted: the DM or party */
  channelId: string;
  /** who it's for, for the greeting */
  name: string;
}

/** Save a voice message or voicemail as an MP3: in the Android app into Downloads, elsewhere
 *  as a normal download. */
export async function saveRecording(fileId: string, name: string) {
  try {
    const r = await fetch(media(`/api/files/${fileId}/mp3?name=${encodeURIComponent(name)}`));
    if (!r.ok) throw new Error("couldn't make the MP3");
    const blob = await r.blob();
    const file = name.replace(/[\\/:*?"<>|]/g, "") + ".mp3";
    if (isAndroidApp) {
      const { androidSave } = await import("./android");
      await androidSave(new Blob([blob], { type: "audio/mpeg" }), file);
      toast(`Saved to Downloads: ${file}`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e: any) {
    toast(e.message || "Couldn't save it", "error");
  }
}

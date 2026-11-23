// Watch Party spaces: the queue and "what's playing" live on the server (api/watch.rs);
// every app plays it locally and lines itself up, or watches the streamer's live video.
import { create } from "zustand";
import { Track, type LocalTrackPublication } from "livekit-client";
import { api } from "./api";
import { onEvent } from "./store";
import { getRoom } from "./voice";

export interface WatchItem {
  id: string;
  added_by: string;
  kind: "youtube" | "url" | "library" | "device";
  src: string;
  title: string;
  created_at: number;
}

export interface WatchState {
  channel_id: string;
  now: null | { item: WatchItem; playing: boolean; pos_ms: number; at_ms: number; skip_votes: number; voted: boolean };
  queue: WatchItem[];
  server_now: number;
  in_room: number;
  run: boolean;
  held: string[];
  asked: string[];
  sources: { library: boolean; device: boolean };
}

/** per channel: the latest state, and how far the server's clock is ahead of ours */
export const useWatch = create<{ byChannel: Record<string, WatchState>; skew: Record<string, number> }>(() => ({ byChannel: {}, skew: {} }));

export async function loadWatch(cid: string) {
  const sent = Date.now();
  try {
    const st = await api<WatchState>(`/api/channels/${cid}/watch`);
    const back = Date.now();
    // the server's clock vs ours, taking the middle of the round trip
    const skew = st.server_now - (sent + back) / 2;
    useWatch.setState((s) => ({ byChannel: { ...s.byChannel, [cid]: st }, skew: { ...s.skew, [cid]: skew } }));
  } catch {}
}

export function applyWatch(cid: string, st: WatchState) {
  useWatch.setState((s) => ({ byChannel: { ...s.byChannel, [cid]: st } }));
}

/** Where playback should be right now, in ms. */
export function targetMs(cid: string): number | null {
  const s = useWatch.getState();
  const st = s.byChannel[cid];
  if (!st?.now) return null;
  const n = st.now;
  return n.playing ? n.pos_ms + (Date.now() + (s.skew[cid] || 0) - n.at_ms) : n.pos_ms;
}

export async function watchAction(cid: string, path: string, body?: any, method = "POST") {
  const st = await api<WatchState>(`/api/channels/${cid}/watch${path}`, { method, body });
  if (st && (st as any).channel_id) applyWatch(cid, st);
  return st;
}

export const isYouTube = (src: string) => /(?:youtube\.com|youtu\.be)\//i.test(src);

// ---------------------------------------------------------------- streaming from your device

let streamPubs: LocalTrackPublication[] = [];
let streamVideo: HTMLVideoElement | null = null;
export const useMyStream = create<{ file: File | null; itemId: string | null; live: boolean }>(() => ({ file: null, itemId: null, live: false }));

export const canStreamFromDevice = () => typeof (HTMLVideoElement.prototype as any).captureStream === "function" || typeof (HTMLVideoElement.prototype as any).mozCaptureStream === "function";

/** Start sending a local video file to the room (as the room's "screen share" track). */
export async function startDeviceStream(video: HTMLVideoElement) {
  const room = getRoom();
  if (!room) throw new Error("Join the room first");
  await stopDeviceStream();
  streamVideo = video;
  const ms: MediaStream = (video as any).captureStream ? (video as any).captureStream() : (video as any).mozCaptureStream();
  const v = ms.getVideoTracks()[0];
  const a = ms.getAudioTracks()[0];
  if (!v) throw new Error("This video can't be streamed");
  const pv = await room.localParticipant.publishTrack(v, { source: Track.Source.ScreenShare, name: "watch-stream", simulcast: false, videoEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 } });
  streamPubs = [pv];
  if (a) streamPubs.push(await room.localParticipant.publishTrack(a, { source: Track.Source.ScreenShareAudio, name: "watch-stream-audio", dtx: false, red: false, audioPreset: { maxBitrate: 160_000 } }));
  useMyStream.setState({ live: true });
}

export async function stopDeviceStream() {
  const room = getRoom();
  for (const p of streamPubs) {
    try {
      if (p.track) await room?.localParticipant.unpublishTrack(p.track, false);
    } catch {}
  }
  streamPubs = [];
  if (streamVideo) {
    streamVideo.pause();
    streamVideo = null;
  }
  useMyStream.setState({ live: false });
}

onEvent((t, d) => {
  if (t === "WATCH_UPDATE") {
    // only channels someone has open are kept; refresh those
    if (useWatch.getState().byChannel[d.channel_id]) loadWatch(d.channel_id);
  }
});

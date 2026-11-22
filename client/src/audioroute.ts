// Where call sound comes out: on the phone app, the earpiece (held to your ear), the speaker,
// a wired headset or Bluetooth, like a phone's dialer; on a PC or in a browser, any sound
// output the system offers (the same choice as Settings → Voice & Video → Output).
import { create } from "zustand";
import { androidSend, isAndroidApp, onAndroid } from "./android";

export type RouteKind = "earpiece" | "speaker" | "headset" | "bluetooth" | "device";
export interface Route {
  id: string;
  kind: RouteKind;
  name: string;
}

export const useRoutes = create<{ routes: Route[]; current: string | null }>(() => ({ routes: [], current: null }));
/** what kind of output is in use ("speaker", "earpiece", …) */
export const currentKind = (s = useRoutes.getState()) => (s.current ? s.current.split(":")[0] : null);

const LABEL: Record<RouteKind, string> = { earpiece: "Phone", speaker: "Speaker", headset: "Headset", bluetooth: "Bluetooth", device: "" };
export const routeLabel = (r: Route) => (r.kind === "device" ? r.name || "Sound output" : r.kind === "bluetooth" && r.name ? r.name : LABEL[r.kind]);
export const routeIcon = (k: RouteKind) => (k === "earpiece" ? "phone" : k === "speaker" ? "speaker" : k === "bluetooth" ? "bluetooth" : "headphones");

if (isAndroidApp) {
  onAndroid((m) => {
    if (m.event === "audio-routes") useRoutes.setState({ routes: (m.routes as Route[]) || [], current: (m.current as string) || null });
  });
}

/** Ask what's available now (the answer arrives in useRoutes). */
export async function refreshRoutes() {
  if (isAndroidApp) return androidSend("audio-routes");
  try {
    const { prefs } = await import("./voice");
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
    const routes: Route[] = outs.filter((d) => d.deviceId !== "communications").map((d) => ({ id: d.deviceId, kind: "device", name: d.label.replace(/^Default - /, "") }));
    const saved = prefs.get("audioOutput") || "default";
    useRoutes.setState({ routes, current: routes.some((r) => r.id === saved) ? saved : routes[0]?.id ?? null });
  } catch {
    useRoutes.setState({ routes: [], current: null });
  }
}

/** Can this device pick where sound goes at all? */
export const canPickRoute = () => isAndroidApp || "setSinkId" in HTMLMediaElement.prototype;

export async function setRoute(id: string) {
  useRoutes.setState({ current: id });
  if (isAndroidApp) return androidSend("audio-route", { id });
  const { prefs, applyDevicePrefs } = await import("./voice");
  prefs.set("audioOutput", id);
  await applyDevicePrefs();
}

if (!isAndroidApp && navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => refreshRoutes());

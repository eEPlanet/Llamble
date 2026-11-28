import type { FileObj } from "./types";

const LS_SERVER = "llamble.server";
import { androidListener } from "./android";

const LS_TOKEN = "llamble.token";

/** your time zone, so the bot can tell you the time */
export const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
})();

export const session = {
  // in a browser the page's own server; in the Windows and Android apps you pick one when logging in
  server: (localStorage.getItem(LS_SERVER) || (location.protocol.startsWith("http") && !location.port.startsWith("517") && location.hostname !== "appassets.androidplatform.net" ? location.origin : "")).replace(/\/+$/, ""),
  token: localStorage.getItem(LS_TOKEN) || "",
};

export function setSession(server: string, token: string) {
  session.server = server.replace(/\/+$/, "");
  session.token = token;
  localStorage.setItem(LS_SERVER, session.server);
  if (token) localStorage.setItem(LS_TOKEN, token);
  else localStorage.removeItem(LS_TOKEN);
  // the Android app's notification listener follows who's signed in
  androidListener(session.server, token);
}

export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(s) ? "http://" : "https://") + s;
  return s;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/** The tutorial answers requests itself while it runs (practice: nothing reaches the server). */
export const apiHooks: {
  api?: (path: string, opts: { method?: string; body?: unknown }) => Promise<any> | undefined;
  upload?: (file: File | Blob, name: string, onProgress?: (p: number) => void) => Promise<FileObj> | undefined;
} = {};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; server?: string; token?: string | null; keepalive?: boolean } = {}): Promise<T> {
  if (apiHooks.api && !opts.server) {
    const r = apiHooks.api(path, opts);
    if (r) return r;
  }
  const server = opts.server ?? session.server;
  const token = opts.token === undefined ? session.token : opts.token;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  headers["X-TZ"] = TZ;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(server + path, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      // still sent if the page is closing
      keepalive: opts.keepalive,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login") window.dispatchEvent(new Event("llamble:unauthorized"));
    // the server only accepts HTTPS now: move to its secure address for good
    if (res.status === 426 && data?.https_url && !opts.server) moveToHttps(String(data.https_url));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

/** Absolute URL for a server-relative media path, with the auth token attached (for <img>/<video>). */
export function media(path: string | null | undefined): string {
  if (!path) return "";
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${session.server}${path}${sep}access_token=${encodeURIComponent(session.token)}`;
}

export function avatarUrl(fileId: string | null | undefined): string {
  return fileId ? media(`/api/files/${fileId}`) : "";
}

export async function upload(file: File | Blob, filename: string, onProgress?: (p: number) => void, signal?: AbortSignal, purpose?: "library"): Promise<FileObj> {
  const hooked = apiHooks.upload?.(file, filename, onProgress);
  if (hooked) return hooked;
  // say it's too big before sending it all (movies for the library, by instance admins, can be bigger)
  const { useStore } = await import("./store");
  const st = useStore.getState();
  const max = st.config.max_upload_bytes;
  if (max && !(purpose === "library" && st.me?.is_admin) && file.size > max) throw new ApiError(413, `That file is too big. The limit here is ${Math.round(max / 1024 / 1024)} MB.`);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", session.server + "/api/files" + (purpose ? `?purpose=${purpose}` : ""));
    xhr.setRequestHeader("Authorization", `Bearer ${session.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error || "Upload failed"));
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed: the connection dropped. If this keeps happening with big files, something between you and the server may limit upload size."));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    const fd = new FormData();
    fd.append("file", file, filename);
    xhr.send(fd);
  });
}

export function ulidTime(id: string): number {
  const A = "0123456789abcdefghjkmnpqrstvwxyz";
  let t = 0;
  for (const c of id.slice(0, 10).toLowerCase()) t = t * 32 + A.indexOf(c);
  return t;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Switch this device to the server's HTTPS address (it turned on "Require HTTPS"). */
export function moveToHttps(url: string) {
  const u = url.replace(/\/+$/, "");
  if (!/^https:\/\//.test(u) || u === session.server) return;
  setSession(u, session.token);
  if (location.protocol.startsWith("http") && location.origin !== u && location.hostname !== "appassets.androidplatform.net" && !location.port.startsWith("517")) location.href = u + location.pathname;
  else location.reload();
}

/** At startup on a plain-HTTP address: if the server now requires HTTPS, move there first. */
export async function checkHttps() {
  if (!session.server.startsWith("http://")) return;
  try {
    const r = await fetch(session.server + "/api/https-info", { cache: "no-store" });
    const d = await r.json();
    if (d.require_https && d.https_url) {
      // only if the secure address really answers from this device
      const ok = await fetch(String(d.https_url).replace(/\/+$/, "") + "/api/health", { cache: "no-store" }).then((x) => x.ok).catch(() => false);
      if (ok) moveToHttps(d.https_url);
    }
  } catch {}
}

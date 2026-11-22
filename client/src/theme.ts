// App colors. Navy (the logo's navy, with the logo ring's blue as the accent) is the default;
// Graphite is a neutral dark gray; "Custom" lets you pick any background and accent color.
// Chosen in Settings → Appearance, kept on this device.
export const THEMES = [
  { id: "navy", label: "Navy", swatch: "#1a2640", titlebar: "#0f1626" },
  { id: "graphite", label: "Graphite", swatch: "#2c2d32", titlebar: "#1b1c1f" },
  { id: "custom", label: "Custom", swatch: "", titlebar: "" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

export const ACCENTS = [
  { id: "blue", label: "Blue", color: "#3f84eb" },
  { id: "purple", label: "Purple", color: "#5c51b7" },
  { id: "green", label: "Green", color: "#a6d052" },
  { id: "custom", label: "Custom", color: "" },
] as const;
export type AccentId = (typeof ACCENTS)[number]["id"];

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const put = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
const isHex = (v: string | null): v is string => !!v && /^#[0-9a-f]{6}$/i.test(v);

// ---- color math ----
function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
function hsl(h: number, s: number, l: number): string {
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** The app is built for dark backgrounds, so a custom background is kept dark enough to read. */
export const MAX_BG_LIGHTNESS = 32;

/** Every shade of a dark theme, worked out from one background color (the chat area). */
export function themeFromBase(base: string): Record<string, string> {
  let [h, s, l] = hexToHsl(base);
  l = Math.min(l, MAX_BG_LIGHTNESS);
  const ts = Math.min(s, 25);
  return {
    "--bg-0": hsl(h, s, l - 7),
    "--bg-1": hsl(h, s, l - 3.5),
    "--bg-2": hsl(h, s, l),
    "--bg-3": hsl(h, s, l + 4.5),
    "--bg-input": hsl(h, s, l + 4.5),
    "--bg-float": hsl(h, s, l - 10),
    "--btn": hsl(h, Math.min(s, 35), l + 13),
    "--bg-hover": hsl(h, ts, l + 6) + "99",
    "--bg-active": hsl(h, ts, l + 11) + "aa",
    "--text": hsl(h, Math.min(s, 18), 90),
    "--text-strong": hsl(h, Math.min(s, 15), 97),
    "--muted": hsl(h, Math.min(s, 14), 67),
    "--faint": hsl(h, Math.min(s, 12), 50),
  };
}
export function accentFromColor(c: string): Record<string, string> {
  const [h, s, l] = hexToHsl(c);
  return { "--brand": c, "--brand-hover": hsl(h, s, l - 7), "--on-brand": luminance(c) > 0.4 ? "#14181f" : "#ffffff" };
}
const THEME_VARS = Object.keys(themeFromBase("#1a2640"));
const ACCENT_VARS = ["--brand", "--brand-hover", "--on-brand"];
function setVars(vars: Record<string, string> | null, names: string[]) {
  const st = document.documentElement.style;
  for (const n of names) st.removeProperty(n);
  if (vars) for (const [k, v] of Object.entries(vars)) st.setProperty(k, v);
}

// ---- saved choices ----
export const customBase = () => (isHex(get("llamble.customTheme")) ? get("llamble.customTheme")! : "#1a2640");
export const customAccent = () => (isHex(get("llamble.customAccent")) ? get("llamble.customAccent")! : "#a6d052");
export function setCustomBase(c: string) {
  put("llamble.customTheme", c);
  applyTheme("custom");
}
export function setCustomAccent(c: string) {
  put("llamble.customAccent", c);
  applyAccent("custom");
}

export function currentAccent(): AccentId {
  const a = get("llamble.accent");
  return ACCENTS.some((x) => x.id === a) ? (a as AccentId) : "blue";
}

export function applyAccent(id: AccentId = currentAccent()) {
  if (id === "blue" || id === "custom") delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = id;
  setVars(id === "custom" ? accentFromColor(customAccent()) : null, ACCENT_VARS);
  put("llamble.accent", id);
}

export function currentTheme(): ThemeId {
  const t = get("llamble.theme");
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : "navy";
}

export function applyTheme(id: ThemeId = currentTheme()) {
  applyAccent();
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  if (t.id === "navy" || t.id === "custom") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t.id;
  const vars = t.id === "custom" ? themeFromBase(customBase()) : null;
  setVars(vars, THEME_VARS);
  const bar = vars ? vars["--bg-0"] : t.titlebar;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bar);
  window.llambleNative?.setTitleBarColor?.(bar);
  put("llamble.theme", t.id);
}

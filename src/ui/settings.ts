// Shared display settings — theme, CRT tube, art background — applied to <html>
// and persisted in localStorage. The alerts toggle lives in App state (Notifier
// reads it). Centralized here so the Settings panel is the single owner.
//
// Everything is a data-attribute or a custom property on the root element, never
// a class, so the three settings compose instead of clobbering each other:
//   <html data-theme="alien" data-crt="max" data-bg="stars" style="--bg-dim:.3">

/** The palettes. `default` is the SNES workshop look the app shipped with. */
export const THEMES = [
  { id: "default", label: "WORKSHOP", hint: "The 16-bit workshop. Navy, bone and gold." },
  { id: "alien", label: "NOSTROMO", hint: "Phosphor green on black, MU/TH/UR 6000." },
  { id: "material", label: "MATERIAL", hint: "Light surfaces, elevation and a purple key colour." },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** CRT tube strength, weakest first. `off` removes the overlay entirely. */
export const CRT_MODES = [
  { id: "off", label: "OFF" },
  { id: "soft", label: "SOFT" },
  { id: "on", label: "CRT" },
  { id: "max", label: "MAX" },
] as const;

export type CrtMode = (typeof CRT_MODES)[number]["id"];

export const BACKGROUNDS = [
  { id: "night", label: "NIGHT" },
  { id: "stars", label: "STARS" },
  { id: "clouds", label: "CLOUDS" },
  { id: "aurora", label: "AURORA" },
  { id: "rain", label: "RAIN" },
  { id: "synth", label: "SYNTH" },
  { id: "grid", label: "GRID" },
  { id: "dusk", label: "DUSK" },
] as const;

/** The id used when the background is the user's own uploaded image. */
export const CUSTOM_BG = "custom";

export const KEYS = {
  theme: "aw-theme",
  crt: "aw-crt",
  bg: "aw-bg",
  bgImage: "aw-bg-image",
  bgDim: "aw-bg-dim",
  alerts: "aw-alerts",
} as const;

export function loadSetting(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function saveSetting(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* private mode */ }
}
export function loadBool(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

const root = () => document.documentElement;

export function applyTheme(id: string): void { root().dataset.theme = id; }
export function applyCrt(mode: string): void { root().dataset.crt = mode; }
export function applyBg(id: string): void { root().dataset.bg = id; }

/** The uploaded background image, as a CSS url() (or none). */
export function applyBgImage(url: string): void {
  // The url is a /uploads/<name> path this app minted, but quote-and-escape it
  // anyway: an unescaped quote would break out of the url() and inject CSS.
  const safe = url.replace(/["\\]/g, "\\$&");
  root().style.setProperty("--bg-image", url ? `url("${safe}")` : "none");
}

/** How far the background is dimmed behind the UI, 0–100. Clamped, because the
 *  value round-trips through localStorage where anything could be sitting. */
export function applyBgDim(pct: number): void {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
  root().style.setProperty("--bg-dim", String(clamped / 100));
}

/** The stored CRT mode, migrating the pre-theme `aw-tube` class value
 *  ("" | "crt-soft" | "crt-off") so an existing user's choice survives. */
export function loadCrt(): CrtMode {
  const saved = loadSetting(KEYS.crt, "");
  if (CRT_MODES.some((m) => m.id === saved)) return saved as CrtMode;
  const legacy = loadSetting("aw-tube", "");
  if (legacy === "crt-off") return "off";
  if (legacy === "crt-soft") return "soft";
  return "on";
}

export function loadBgDim(): number {
  const n = Number(loadSetting(KEYS.bgDim, "0"));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/** Put every saved display setting on <html>. Called once on load, before the
 *  first paint of the app's own chrome. */
export function applyAllSettings(): void {
  applyTheme(loadSetting(KEYS.theme, "default"));
  applyCrt(loadCrt());
  applyBg(loadSetting(KEYS.bg, "night"));
  applyBgImage(loadSetting(KEYS.bgImage, ""));
  applyBgDim(loadBgDim());
}

/** Everything the display controls own, in one object so App can hold a single
 *  piece of state and the Settings panel can patch it. */
export type Display = { theme: string; crt: CrtMode; bg: string; bgImage: string; bgDim: number };

export function readDisplay(): Display {
  return {
    theme: loadSetting(KEYS.theme, "default"),
    crt: loadCrt(),
    bg: loadSetting(KEYS.bg, "night"),
    bgImage: loadSetting(KEYS.bgImage, ""),
    bgDim: loadBgDim(),
  };
}

/** Apply a display object to <html> and persist it. */
export function writeDisplay(d: Display): void {
  applyTheme(d.theme); saveSetting(KEYS.theme, d.theme);
  applyCrt(d.crt); saveSetting(KEYS.crt, d.crt);
  applyBg(d.bg); saveSetting(KEYS.bg, d.bg);
  applyBgImage(d.bgImage); saveSetting(KEYS.bgImage, d.bgImage);
  applyBgDim(d.bgDim); saveSetting(KEYS.bgDim, String(d.bgDim));
}

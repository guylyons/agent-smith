// Shared display settings — theme, CRT tube, glass bevel, art background —
// applied to <html> and persisted in localStorage. The alerts toggle lives in
// App state (Notifier reads it). Centralized here so the Settings panel is the
// single owner.
//
// Everything is a data-attribute or a custom property on the root element, never
// a class, so the settings compose instead of clobbering each other:
//   <html data-theme="alien" data-crt="max" data-bevel="thick" data-bg="stars"
//         style="--bg-dim:.3">

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

/** Thickness of the glass bevel round the picture, thinnest first. Its own
 *  setting rather than another CRT step: the moulded glass edge of a TV set is
 *  a different thing from the raster inside it, and plenty of people want one
 *  without the other. `off` renders nothing. */
export const BEVEL_MODES = [
  { id: "off", label: "OFF" },
  { id: "slim", label: "SLIM" },
  { id: "thick", label: "THICK" },
] as const;

export type BevelMode = (typeof BEVEL_MODES)[number]["id"];

/** The UI font. Source Code Pro is the default in every theme; THEME hands the
 *  face back to the palette (Share Tech Mono in NOSTROMO, Roboto in MATERIAL).
 *  Each family is loaded from Google Fonts in index.html. */
export const FONT_THEME = "theme";
export const FONT_DEFAULT = "source-code-pro";
export const FONTS = [
  { id: "source-code-pro", label: "SOURCE CODE PRO", family: "Source Code Pro" },
  { id: "jetbrains-mono", label: "JETBRAINS MONO", family: "JetBrains Mono" },
  { id: "fira-code", label: "FIRA CODE", family: "Fira Code" },
  { id: "ibm-plex-mono", label: "IBM PLEX MONO", family: "IBM Plex Mono" },
  { id: "roboto-mono", label: "ROBOTO MONO", family: "Roboto Mono" },
  { id: FONT_THEME, label: "THEME'S OWN", family: "" },
] as const;

export const BACKGROUNDS = [
  { id: "night", label: "NIGHT" },
  { id: "stars", label: "STARS" },
  { id: "clouds", label: "CLOUDS" },
  { id: "aurora", label: "AURORA" },
  { id: "rain", label: "RAIN" },
  { id: "synth", label: "SYNTH" },
  { id: "grid", label: "GRID" },
  { id: "dusk", label: "DUSK" },
  { id: "nostromo", label: "NOSTROMO" },
] as const;

/** The id used when the background is the user's own uploaded image. */
export const CUSTOM_BG = "custom";

/** How many cards a column on THE LINE shows before it scrolls. `LINE_ROWS_OFF`
 *  means no cap — the column grows with its stack, the way it used to. */
export const LINE_ROWS_MIN = 3;
export const LINE_ROWS_MAX = 12;
export const LINE_ROWS_OFF = 0;
export const LINE_ROWS_DEFAULT = 6;

/** The conversation drawer's width in px, and the size of its transcript text.
 *  Both are dragged/clicked from inside the drawer itself rather than the
 *  Settings panel, because that is where you feel the need for them — so they
 *  live outside `Display` and are read and written one at a time.
 *
 *  Width has a hard max as well as the `94vw` ceiling in CSS: on a very wide
 *  monitor a drawer can be dragged out to fill the screen, and there is no way
 *  back if the handle ends up off the edge. */
export const DRAWER_W_MIN = 360;
export const DRAWER_W_MAX = 1400;
export const DRAWER_W_DEFAULT = 560;

export const DRAWER_FONT_MIN = 12;
export const DRAWER_FONT_MAX = 24;
export const DRAWER_FONT_DEFAULT = 15;
export const DRAWER_FONT_STEP = 1;

export const KEYS = {
  theme: "aw-theme",
  crt: "aw-crt",
  bevel: "aw-bevel",
  bg: "aw-bg",
  bgImage: "aw-bg-image",
  bgDim: "aw-bg-dim",
  font: "aw-font",
  alerts: "aw-alerts",
  lineRows: "aw-line-rows",
  face: "aw-face",
  drawerWidth: "aw-drawer-w",
  drawerFont: "aw-drawer-font",
  // JSON array of repo folders, most recent first — see recentFolders.ts.
  recentFolders: "aw-recent-folders",
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
/** Like loadBool, but unset means ON — for toggles that ship enabled and are
 *  opted OUT of, where an absent key must not read as "off". */
export function loadBoolDefaultOn(key: string): boolean {
  try { return (localStorage.getItem(key) ?? "1") === "1"; } catch { return true; }
}

const root = () => document.documentElement;

export function applyTheme(id: string): void { root().dataset.theme = id; }
export function applyCrt(mode: string): void { root().dataset.crt = mode; }
export function applyBevel(mode: string): void { root().dataset.bevel = mode; }
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

/** Clamp a drawer width to the range the handle can drag, so a value that
 *  round-tripped through localStorage (or a drag that ran off the screen)
 *  can never leave the drawer unusably narrow or wider than the reset. */
export function clampDrawerWidth(px: number): number {
  if (!Number.isFinite(px)) return DRAWER_W_DEFAULT;
  return Math.round(Math.min(DRAWER_W_MAX, Math.max(DRAWER_W_MIN, px)));
}

/** Clamp a transcript font size to the offered range. */
export function clampDrawerFont(px: number): number {
  if (!Number.isFinite(px)) return DRAWER_FONT_DEFAULT;
  return Math.round(Math.min(DRAWER_FONT_MAX, Math.max(DRAWER_FONT_MIN, px)));
}

/** The drawer width lives on <html> as a custom property, not in React state,
 *  so a drag writes one CSS value per frame instead of re-rendering a long
 *  transcript. CSS still caps it at 94vw for small windows. */
export function applyDrawerWidth(px: number): void {
  root().style.setProperty("--drawer-w", `${clampDrawerWidth(px)}px`);
}

export function applyDrawerFont(px: number): void {
  root().style.setProperty("--drawer-font", `${clampDrawerFont(px)}px`);
}

/** The font-family stack for a font id, or null for THEME (use the palette's). */
export function fontStack(id: string): string | null {
  const f = FONTS.find((x) => x.id === id);
  if (!f || !f.family) return null;
  return `"${f.family}",ui-monospace,"SF Mono",Menlo,Consolas,monospace`;
}

/** Sets the body and code faces as inline properties on <html>, which outrank
 *  the [data-theme] blocks; THEME removes them so the palette's own show. */
export function applyFont(id: string): void {
  const stack = fontStack(id);
  const style = root().style;
  if (stack) { style.setProperty("--mono", stack); style.setProperty("--code", stack); }
  else { style.removeProperty("--mono"); style.removeProperty("--code"); }
}

export function loadFont(): string {
  const saved = loadSetting(KEYS.font, FONT_DEFAULT);
  return FONTS.some((f) => f.id === saved) ? saved : FONT_DEFAULT;
}

/** An empty stored value reads as 0 through Number(), which would clamp to the
 *  narrowest drawer rather than the default — so blank is treated as unset. */
function storedNumber(key: string, fallback: number): number {
  const raw = loadSetting(key, "").trim();
  return raw ? Number(raw) : fallback;
}

export function loadDrawerWidth(): number {
  return clampDrawerWidth(storedNumber(KEYS.drawerWidth, DRAWER_W_DEFAULT));
}

export function loadDrawerFont(): number {
  return clampDrawerFont(storedNumber(KEYS.drawerFont, DRAWER_FONT_DEFAULT));
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

/** The stored card cap for a LINE column, clamped to the offered range (0 = off).
 *  It round-trips through localStorage, so anything could be sitting there. */
export function loadLineRows(): number {
  const n = Math.round(Number(loadSetting(KEYS.lineRows, String(LINE_ROWS_DEFAULT))));
  if (!Number.isFinite(n)) return LINE_ROWS_DEFAULT;  // junk in storage: ship's default
  if (n <= LINE_ROWS_OFF) return LINE_ROWS_OFF;       // 0 or less means "no cap"
  return Math.min(LINE_ROWS_MAX, Math.max(LINE_ROWS_MIN, n));
}

/** The stored bevel mode. New setting, so it defaults to off — an existing
 *  user's screen doesn't grow a glass edge on upgrade. */
export function loadBevel(): BevelMode {
  const saved = loadSetting(KEYS.bevel, "");
  return BEVEL_MODES.some((m) => m.id === saved) ? (saved as BevelMode) : "off";
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
  applyBevel(loadBevel());
  applyBg(loadSetting(KEYS.bg, "night"));
  applyBgImage(loadSetting(KEYS.bgImage, ""));
  applyBgDim(loadBgDim());
  applyFont(loadFont());
  applyDrawerWidth(loadDrawerWidth());
  applyDrawerFont(loadDrawerFont());
}

/** Everything the display controls own, in one object so App can hold a single
 *  piece of state and the Settings panel can patch it. */
export type Display = {
  theme: string; crt: CrtMode; bevel: BevelMode; bg: string; bgImage: string; bgDim: number;
  /** A FONTS id; FONT_THEME means the theme's own face. */
  font: string;
  /** Cards shown per LINE column before it scrolls; 0 = no cap. */
  lineRows: number;
};

export function readDisplay(): Display {
  return {
    theme: loadSetting(KEYS.theme, "default"),
    crt: loadCrt(),
    bevel: loadBevel(),
    bg: loadSetting(KEYS.bg, "night"),
    bgImage: loadSetting(KEYS.bgImage, ""),
    bgDim: loadBgDim(),
    font: loadFont(),
    lineRows: loadLineRows(),
  };
}

/** Apply a display object to <html> and persist it. */
export function writeDisplay(d: Display): void {
  applyTheme(d.theme); saveSetting(KEYS.theme, d.theme);
  applyCrt(d.crt); saveSetting(KEYS.crt, d.crt);
  applyBevel(d.bevel); saveSetting(KEYS.bevel, d.bevel);
  applyBg(d.bg); saveSetting(KEYS.bg, d.bg);
  applyBgImage(d.bgImage); saveSetting(KEYS.bgImage, d.bgImage);
  applyBgDim(d.bgDim); saveSetting(KEYS.bgDim, String(d.bgDim));
  applyFont(d.font); saveSetting(KEYS.font, d.font);
  saveSetting(KEYS.lineRows, String(d.lineRows));
}

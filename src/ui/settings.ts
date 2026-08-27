// Shared display settings (CRT tube mode, art background), applied to <html> and
// persisted in localStorage. The alerts toggle lives in App state (Notifier reads
// it). Centralized here so the Settings panel is the single owner of these.

export const TUBE_MODES = [
  { cls: "", label: "CRT" },
  { cls: "crt-soft", label: "SOFT" },
  { cls: "crt-off", label: "OFF" },
] as const;

export const BACKGROUNDS = [
  { id: "night", label: "NIGHT" },
  { id: "stars", label: "STARS" },
  { id: "synth", label: "SYNTH" },
  { id: "grid", label: "GRID" },
  { id: "dusk", label: "DUSK" },
] as const;

export function loadSetting(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function saveSetting(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* private mode */ }
}
export function loadBool(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

// CRT mode is applied via the <html> class; background via a data-attribute — kept
// separate so they never clobber each other.
export function applyTube(cls: string): void { document.documentElement.className = cls; }
export function applyBg(id: string): void { document.documentElement.dataset.bg = id; }

// Turning the dashboard into a stand-alone app window.
//
// The UI is a normal web page served by src/server.ts, but a browser tab is the
// wrong frame for it: a URL bar, tabs and a bookmarks strip are all noise around
// a full-screen workshop. Every Chromium browser can drop them with `--app=URL`,
// which opens one plain window with no chrome at all — so "stand-alone app" here
// means finding an installed Chromium browser and launching it that way.
//
// Everything in this file is pure: `exists` is injected rather than read off the
// filesystem, so the choices are testable without a browser installed.
import { basename, join } from "node:path";

export type Browser = { name: string; bin: string };

/** Chromium browsers that support `--app`, most-preferred first. */
export const BROWSERS: Browser[] = [
  { name: "Google Chrome", bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { name: "Brave Browser", bin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
  { name: "Microsoft Edge", bin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  { name: "Chromium", bin: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
];

/**
 * The browser to launch the app window in.
 *
 * `preferred` (AGENT_WORKSHOP_BROWSER) may be a rough name — "brave", "edge" —
 * or an absolute path to a binary we don't know about. A preference we can't
 * honour is never fatal: an unknown name, or one naming a browser that isn't
 * installed, falls back to the priority order rather than leaving the human
 * with no window.
 */
export function pickBrowser(exists: (path: string) => boolean, preferred?: string): Browser | null {
  const want = (preferred ?? "").trim();
  if (want.startsWith("/")) {
    if (exists(want)) return { name: basename(want), bin: want };
  } else if (want) {
    const match = BROWSERS.find((b) => b.name.toLowerCase().includes(want.toLowerCase()));
    if (match && exists(match.bin)) return match;
  }
  return BROWSERS.find((b) => exists(b.bin)) ?? null;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`not a usable port: ${port}`);
  }
}

/** The loopback URL the app window loads. Throws on a port a server can't hold. */
export function appUrl(port: number): string {
  assertPort(port);
  return `http://localhost:${port}/`;
}

/** Loopback only: this window is a view onto a server on this machine, and
 *  --app on an arbitrary origin would make the launcher a way to open any page
 *  in a window with no address bar to reveal where it actually went. */
function assertLocalHttpUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`not a url: ${url}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`not an http url: ${url}`);
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`not a loopback url: ${url}`);
  }
}

export type WindowOpts = { size?: [number, number] };

/**
 * The argv to spawn for a chromeless window on `url`.
 *
 * `--user-data-dir` is not optional dressing: without it the flags land on the
 * human's everyday browser process, which may already be running (so the flags
 * are ignored and the page opens as a tab) and whose profile we have no business
 * touching. A dedicated profile gets its own process, its own window, and
 * remembers this window's size and position between runs.
 */
export function browserArgv(bin: string, url: string, profileDir: string, opts: WindowOpts = {}): string[] {
  assertLocalHttpUrl(url);
  const argv = [
    bin,
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (opts.size) argv.push(`--window-size=${opts.size[0]},${opts.size[1]}`);
  return argv;
}

/**
 * Where the app window's own browser profile lives — one per port.
 *
 * Chromium hands a launch on an already-open profile to the process that owns
 * it, and the one we spawned then exits immediately. A launcher that read that
 * as "the window closed" would shut down the server it had just started, so two
 * dashboards on two ports must never share a profile.
 */
export function appProfileDir(home: string, port: number): string {
  assertPort(port);
  return join(home, ".agent-workshop", `browser-profile-${port}`);
}

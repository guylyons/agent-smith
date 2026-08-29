import { test, expect } from "bun:test";
import {
  BROWSERS,
  appProfileDir,
  appUrl,
  browserArgv,
  pickBrowser,
} from "../src/lib/appwindow";

const none = () => false;
const all = () => true;
const only = (...paths: string[]) => (p: string) => paths.includes(p);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

// ---- pickBrowser ---------------------------------------------------------

test("picks the first installed browser in priority order", () => {
  expect(pickBrowser(all)?.bin).toBe(CHROME);
  expect(pickBrowser(only(BRAVE))?.name).toBe("Brave Browser");
});

test("returns null when no chromium browser is installed", () => {
  expect(pickBrowser(none)).toBe(null);
});

test("every candidate points at a real binary inside the app bundle", () => {
  for (const b of BROWSERS) {
    expect(b.bin.startsWith("/Applications/")).toBe(true);
    expect(b.bin).toContain("/Contents/MacOS/");
  }
});

// ---- pickBrowser: an explicit preference ---------------------------------

test("a preferred browser wins over priority order", () => {
  expect(pickBrowser(all, "brave")?.bin).toBe(BRAVE);
  expect(pickBrowser(all, "Brave Browser")?.bin).toBe(BRAVE);
  expect(pickBrowser(all, "  BRAVE  ")?.bin).toBe(BRAVE);
});

test("a preferred browser that isn't installed falls back to what is", () => {
  expect(pickBrowser(only(CHROME), "brave")?.bin).toBe(CHROME);
});

test("a preference naming an unknown browser is ignored, not fatal", () => {
  expect(pickBrowser(all, "netscape")?.bin).toBe(CHROME);
});

test("a preference that is an absolute path to an existing binary is used as-is", () => {
  const custom = "/Applications/Thorium.app/Contents/MacOS/Thorium";
  expect(pickBrowser(only(custom), custom)).toEqual({ name: "Thorium", bin: custom });
});

test("a preference that is an absolute path to nothing falls back", () => {
  expect(pickBrowser(only(CHROME), "/nope/Contents/MacOS/nope")?.bin).toBe(CHROME);
});

// ---- appUrl --------------------------------------------------------------

test("appUrl builds a loopback url from a port", () => {
  expect(appUrl(4173)).toBe("http://localhost:4173/");
});

test("appUrl rejects a port that isn't a usable TCP port", () => {
  for (const bad of [0, -1, 65536, 1.5, NaN]) {
    expect(() => appUrl(bad)).toThrow();
  }
});

// ---- browserArgv ---------------------------------------------------------

test("browserArgv opens a chromeless app window on the url", () => {
  const argv = browserArgv(CHROME, "http://localhost:4173/", "/tmp/profile");
  expect(argv[0]).toBe(CHROME);
  expect(argv).toContain("--app=http://localhost:4173/");
  expect(argv).toContain("--user-data-dir=/tmp/profile");
  // first-run interstitials would sit on top of the app window
  expect(argv).toContain("--no-first-run");
  expect(argv).toContain("--no-default-browser-check");
});

test("browserArgv never emits a bare url argument", () => {
  // a positional url would open a normal tabbed window alongside the app one
  const argv = browserArgv(CHROME, "http://localhost:4173/", "/tmp/profile");
  expect(argv.filter((a) => a === "http://localhost:4173/")).toEqual([]);
});

test("browserArgv refuses a url that could be read as a flag", () => {
  expect(() => browserArgv(CHROME, "--headless", "/tmp/p")).toThrow();
  expect(() => browserArgv(CHROME, "javascript:alert(1)", "/tmp/p")).toThrow();
  expect(() => browserArgv(CHROME, "file:///etc/passwd", "/tmp/p")).toThrow();
});

test("browserArgv refuses a url pointing off this machine", () => {
  expect(() => browserArgv(CHROME, "http://example.com/", "/tmp/p")).toThrow();
});

test("browserArgv accepts the loopback spellings", () => {
  for (const u of ["http://localhost:4173/", "http://127.0.0.1:4173/", "http://[::1]:4173/"]) {
    expect(browserArgv(CHROME, u, "/tmp/p")).toContain(`--app=${u}`);
  }
});

test("browserArgv sizes the window only when asked", () => {
  expect(browserArgv(CHROME, "http://localhost:4173/", "/tmp/p")).not.toContain("--window-size=1440,900");
  expect(browserArgv(CHROME, "http://localhost:4173/", "/tmp/p", { size: [1440, 900] }))
    .toContain("--window-size=1440,900");
});

// ---- appProfileDir -------------------------------------------------------

test("the app window gets its own profile, away from the user's browsing one", () => {
  const dir = appProfileDir("/Users/someone", 4173);
  expect(dir.startsWith("/Users/someone/")).toBe(true);
  expect(dir).not.toContain("Library/Application Support/Google");
});

test("each port gets its own profile", () => {
  // Chromium hands a launch on an already-open profile to the running process,
  // which then exits at once — so two dashboards sharing a profile would leave
  // the second launcher unable to tell "window closed" from "handed off".
  expect(appProfileDir("/h", 4173)).not.toBe(appProfileDir("/h", 4199));
  expect(appProfileDir("/h", 4173)).toContain("4173");
});

test("appProfileDir rejects a port that isn't a usable TCP port", () => {
  for (const bad of [0, -1, 65536, 1.5, NaN]) {
    expect(() => appProfileDir("/h", bad)).toThrow();
  }
});

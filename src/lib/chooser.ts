// The real macOS folder picker, so choosing a repo is a Finder dialog rather
// than a path typed from memory. A browser can't do this: the File System
// Access API hands back an opaque handle with no filesystem path, and this app
// needs an absolute path to launch `claude` in. So the dashboard's own server —
// which is already on this machine and already drives Ghostty by AppleScript —
// opens the dialog and returns the path.
//
// Best-effort like every other OS action here: resolves to a result, never
// throws. Cancelling is not an error the user should be told about, so it comes
// back flagged rather than as a failure.
import { existsSync } from "node:fs";
import { asStr } from "../ghostty";

export type ChooseResult = { ok: boolean; path?: string; cancelled?: boolean; error?: string };

/** Sentinel the script returns for a user cancel (AppleScript error -128), kept
 *  distinct from any real path — a POSIX path always starts with "/". */
const CANCELLED = "AWF-CANCELLED";

/** Build the AppleScript for the dialog. Pure and exported so the escaping and
 *  the cancel branch are unit-testable without opening a window on anyone's
 *  screen. `defaultLocation` must already be known to exist. */
export function chooseFolderScript(prompt: string, defaultLocation?: string): string {
  // `default location` on a path that doesn't exist raises, so the caller only
  // ever passes one it has stat'd.
  const at = defaultLocation ? ` default location (POSIX file ${asStr(defaultLocation)})` : "";
  // System Events is told to activate first so the dialog comes to the front —
  // osascript itself is a background process and its sheet can open behind
  // everything otherwise. -128 is "user cancelled"; any other error propagates
  // so a real failure isn't silently reported as a cancel.
  return `tell application "System Events"
    activate
    try
      set chosen to choose folder with prompt ${asStr(prompt)}${at}
    on error number -128
      return ${asStr(CANCELLED)}
    end try
    return POSIX path of chosen
  end tell`;
}

/** POSIX path of a folder always ends in "/". Drop it (but never turn "/" into
 *  ""), so the path matches the shape every other cwd in the app has. */
export function trimFolderPath(p: string): string {
  const t = p.trim();
  return t.length > 1 && t.endsWith("/") ? t.replace(/\/+$/, "") : t;
}

/** Open the picker, starting in `startIn` when that folder still exists.
 *  Returns `{ ok: false, cancelled: true }` when the user backs out. */
export async function chooseFolder(startIn?: string): Promise<ChooseResult> {
  const at = startIn && existsSync(startIn) ? startIn : undefined;
  try {
    const p = Bun.spawn(["osascript", "-e", chooseFolderScript("Choose a repo folder", at)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    const value = out.trim();
    if (value === CANCELLED) return { ok: false, cancelled: true };
    if (code !== 0 || !value.startsWith("/")) {
      return { ok: false, error: err.trim() || "could not open the folder picker" };
    }
    return { ok: true, path: trimFolderPath(value) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// OS actions on a real Claude session: focus its Ghostty terminal, or interrupt
// it. macOS + Ghostty specific (uses Ghostty's AppleScript dictionary, which
// works without Accessibility permission). Best-effort: every call resolves to a
// {ok, error?} result and never throws.
import { writeFile } from "node:fs/promises";
import type { AgentStatus } from "./schema";

export type ActionResult = { ok: boolean; error?: string };

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function osa(script: string): Promise<string> {
  const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

// AppleScript string literal, escaping backslash and quote.
function asStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function focusScript(match: string): string {
  return `tell application "Ghostty"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with term in terminals of t
          if ${match} then
            focus term
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
    return "no"
  end tell`;
}

let markerSeq = 0;
function newMarker(): string {
  markerSeq = (markerSeq + 1) % 1e6;
  return `AWF-${Date.now().toString(36)}-${markerSeq.toString(36)}`;
}

/** Focus the exact terminal for a session: write a one-shot title marker to its
 *  tty and match on it (precise). Falls back to matching the working directory. */
export async function focusSession(status: Pick<AgentStatus, "tty" | "cwd">): Promise<ActionResult> {
  if (status.tty) {
    const marker = newMarker();
    try {
      await writeFile(status.tty, `\x1b]2;${marker}\x07`); // OSC 2 = set window title
      await delay(70);
      const out = await osa(focusScript(`(name of term) contains ${asStr(marker)}`));
      if (out === "ok") return { ok: true };
    } catch { /* fall through to cwd match */ }
  }
  if (status.cwd) {
    const out = await osa(focusScript(`(working directory of term) is ${asStr(status.cwd)}`));
    if (out === "ok") return { ok: true };
  }
  return { ok: false, error: "could not find the terminal (is it still open?)" };
}

/** Interrupt the session's current turn — equivalent to pressing Esc/Ctrl-C once.
 *  The session stays alive and waiting; resume by typing in it. */
export function interruptSession(status: Pick<AgentStatus, "pid">): ActionResult {
  if (!status.pid) return { ok: false, error: "no pid — run `bun run install-hooks` to enable pausing" };
  try {
    process.kill(status.pid, "SIGINT");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not signal pid ${status.pid}: ${String(e)}` };
  }
}

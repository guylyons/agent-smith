// OS actions on a real Claude session: focus its Ghostty terminal, send it a
// prompt/answer, or interrupt it. macOS + Ghostty specific (uses Ghostty's
// AppleScript dictionary, which works without Accessibility permission).
// Best-effort: every call resolves to a {ok, error?} result and never throws.
import { writeFile } from "node:fs/promises";
import type { AgentStatus } from "./schema";

export type ActionResult = { ok: boolean; error?: string };
type Target = Pick<AgentStatus, "tty" | "cwd" | "title">;

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

async function runWhere(matchExpr: string, body: string): Promise<boolean> {
  const script = `tell application "Ghostty"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with term in terminals of t
          if ${matchExpr} then
            ${body}
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
    return "no"
  end tell`;
  return (await osa(script)) === "ok";
}

let markerSeq = 0;
function newMarker(): string {
  markerSeq = (markerSeq + 1) % 1e6;
  return `AWF-${Date.now().toString(36)}-${markerSeq.toString(36)}`;
}

/**
 * Run an AppleScript `body` (with `term` bound) on the session's exact terminal.
 * Targeting, most precise first: a one-shot title marker written to the tty
 * (hooks) → Claude's task title, which equals the Ghostty tab title (scanner) →
 * working directory. cwd is imprecise (many tabs share one), so it's only used
 * when `allowCwd` is set — never for sending input.
 */
async function runOnTerminal(t: Target, body: string, allowCwd: boolean): Promise<ActionResult> {
  if (t.tty) {
    const marker = newMarker();
    try {
      await writeFile(t.tty, `\x1b]2;${marker}\x07`); // OSC 2 = set window title
      await delay(70);
      if (await runWhere(`(name of term) contains ${asStr(marker)}`, body)) return { ok: true };
    } catch { /* fall through */ }
  }
  if (t.title && (await runWhere(`(name of term) contains ${asStr(t.title)}`, body))) return { ok: true };
  if (allowCwd && t.cwd && (await runWhere(`(working directory of term) is ${asStr(t.cwd)}`, body))) return { ok: true };
  return { ok: false, error: "could not pinpoint the terminal (is it still open?)" };
}

/** Bring the session's terminal to the front. */
export function focusSession(t: Target): Promise<ActionResult> {
  return runOnTerminal(t, "focus term\n            activate", true);
}

/** Type a prompt/answer into the session and submit it (Enter). Does NOT focus or
 *  activate the terminal — the user stays in the web UI. Only precise targets are
 *  used (never the cwd fallback), so a prompt can't be sent to the wrong session. */
export async function sendPrompt(t: Target, text: string): Promise<ActionResult> {
  const body = `input text ${asStr(text)} to term
            delay 0.1
            send key "enter" to term`;
  const r = await runOnTerminal(t, body, false);
  if (!r.ok && !t.tty && !t.title) {
    return { ok: false, error: "can't pinpoint this session's terminal — run `bun run install-hooks` to enable sending prompts" };
  }
  return r;
}

/** Interrupt the session's current turn — equivalent to pressing Esc/Ctrl-C once.
 *  The session stays alive and waiting; resume by typing in it. Verifies the pid
 *  is still a live `claude` process first, so a crashed session's recycled pid
 *  can't be signaled by mistake. */
export async function interruptSession(status: Pick<AgentStatus, "pid">): Promise<ActionResult> {
  const pid = status.pid;
  if (!pid) return { ok: false, error: "no pid — run `bun run install-hooks` to enable pausing" };
  try {
    const p = Bun.spawn(["ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const comm = (await new Response(p.stdout).text()).trim();
    await p.exited;
    if (!comm) return { ok: false, error: "that session isn't running any more" };
    // Accept the CLI (claude) and shim hosts (npm/node, bun) so pausing works
    // regardless of install method, while still refusing an obviously-unrelated
    // recycled pid (e.g. a browser).
    const base = comm.split("/").pop() ?? comm;
    const hosts = new Set(["claude", "node", "bun", "deno"]);
    if (!hosts.has(comm) && !hosts.has(base)) {
      return { ok: false, error: "that session isn't running any more" };
    }
  } catch {
    return { ok: false, error: "could not verify the session" };
  }
  try {
    process.kill(pid, "SIGINT");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not signal pid ${pid}: ${String(e)}` };
  }
}

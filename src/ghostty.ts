// OS actions on a real Claude session: focus its Ghostty terminal, send it a
// prompt/answer, or interrupt it. macOS + Ghostty specific (uses Ghostty's
// AppleScript dictionary, which works without Accessibility permission).
// Best-effort: every call resolves to a {ok, error?} result and never throws.
import { writeFile } from "node:fs/promises";
import type { AgentStatus } from "./schema";
import { createWorktree } from "./lib/worktree";
import { composePrompt, getPersona, type Persona } from "./lib/personas";

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

// Like runWhere, but closes the containing TAB (`t` in scope, not `term`) on a
// match rather than running a body against the terminal — used by killAgent.
async function closeWhere(matchExpr: string): Promise<boolean> {
  const script = `tell application "Ghostty"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with term in terminals of t
          if ${matchExpr} then
            close tab t
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
  // A Ghostty tab title is "<prefix-symbol> <aiTitle>"; t.title is the bare
  // aiTitle. Match exactly, or as a suffix (tolerating the prefix symbol),
  // rather than "contains" — a substring match could hit the wrong terminal
  // when one session's title happens to be a substring of another's.
  if (t.title && (await runWhere(`(name of term) is ${asStr(t.title)} or (name of term) ends with ${asStr(t.title)}`, body))) return { ok: true };
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

export const ALLOWED_MODELS = new Set(["opus", "sonnet", "haiku"]);
export const ALLOWED_PERMISSION_MODES = new Set(["default", "plan", "acceptEdits", "bypassPermissions"]);

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** The exact line typed into the new terminal. Pure and exported so the command
 *  shape is unit-tested without driving AppleScript.
 *  `model`/`permissionMode` are checked against fixed allowlists — an unknown
 *  value is dropped, never interpolated. The persona rides in twice: its prompt
 *  as --append-system-prompt (so it survives compaction and never shows up in
 *  the CHAT tab), and its id as an env var the session's hooks inherit, which is
 *  what binds the persona to the real session id. */
export function buildLaunchInput(
  task: string,
  opts: { model?: string; permissionMode?: string },
  persona: Persona | null,
): string {
  let flags = "";
  if (opts.model && ALLOWED_MODELS.has(opts.model)) flags += ` --model ${opts.model}`;
  if (opts.permissionMode && ALLOWED_PERMISSION_MODES.has(opts.permissionMode)) flags += ` --permission-mode ${opts.permissionMode}`;
  if (persona) flags += ` --append-system-prompt ${shq(composePrompt(persona))}`;
  const env = persona ? `AGENT_PERSONA=${persona.id} ` : "";
  return `${env}claude${flags} ${shq(task)}\n`;
}

/** Launch a NEW Claude session in `cwd` with `task` as its opening prompt — a new
 *  Ghostty tab (or window) that runs `claude '<task>'`. Does not steal focus. The
 *  new session appears on the board via the scanner once it starts.
 *  `opts.model` and `opts.permissionMode` are checked against a fixed allowlist
 *  before being interpolated into the shell command — unknown values are
 *  silently ignored rather than passed through.
 *  `opts.worktree`, when set, creates an isolated git worktree off the folder's
 *  HEAD and launches the session there instead of in `cwd`, so agents never share
 *  a working tree; a worktree failure aborts the launch with its error.
 *  `opts.persona`, when it names a known persona, binds that persona to the new
 *  session (see buildLaunchInput); an unknown id resolves to null and is
 *  ignored, same as an unknown model. */
export async function spawnAgent(
  cwd: string,
  task: string,
  opts?: { model?: string; permissionMode?: string; worktree?: string; persona?: string },
): Promise<ActionResult> {
  let launchCwd = cwd;
  if (opts?.worktree) {
    const wt = await createWorktree(cwd, opts.worktree);
    if (!wt.ok) return { ok: false, error: wt.error ?? "could not create worktree" };
    launchCwd = wt.path!;
  }
  // An unknown persona id resolves to null and is ignored, the same way an
  // unknown model is — never interpolated into the command.
  const persona = opts?.persona ? getPersona(opts.persona) : null;
  const input = buildLaunchInput(task, opts ?? {}, persona);
  const script = `tell application "Ghostty"
    set cfg to new surface configuration
    set initial working directory of cfg to ${asStr(launchCwd)}
    set initial input of cfg to ${asStr(input)}
    if (count of windows) > 0 then
      new tab in front window with configuration cfg
    else
      new window with configuration cfg
    end if
    return "ok"
  end tell`;
  const out = await osa(script);
  return out === "ok" ? { ok: true } : { ok: false, error: "could not launch a new terminal (is Ghostty running?)" };
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

/** Kill (end) the session by closing its Ghostty tab. Targeting is deliberately
 *  narrower than runOnTerminal's: a one-shot title marker (hooks) → Claude's
 *  task title. No cwd fallback — cwd is shared by many tabs, and closing the
 *  wrong one is destructive, so an ambiguous match is refused rather than
 *  guessed at. */
export async function killAgent(t: Target): Promise<ActionResult> {
  if (t.tty) {
    const marker = newMarker();
    try {
      await writeFile(t.tty, `\x1b]2;${marker}\x07`); // OSC 2 = set window title
      await delay(70);
      if (await closeWhere(`(name of term) contains ${asStr(marker)}`)) return { ok: true };
    } catch { /* fall through */ }
  }
  if (t.title && (await closeWhere(`(name of term) is ${asStr(t.title)} or (name of term) ends with ${asStr(t.title)}`))) return { ok: true };
  return { ok: false, error: "couldn't find the terminal" };
}

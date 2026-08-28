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

/** An AppleScript string EXPRESSION for `s`.
 *
 *  osascript decodes its `-e` argument as Latin-1, so UTF-8 bytes for anything
 *  outside ASCII arrive mangled — an em dash reaches the session as three junk
 *  characters, which corrupts any prompt or card text that isn't plain ASCII.
 *  Printable ASCII stays in a quoted literal (escaping backslash and quote);
 *  everything else — accents, dashes, arrows, emoji, and the newlines and tabs
 *  a literal can't hold — is emitted as `character id N` per Unicode code point,
 *  which carries no encoding assumption at all.
 *
 *  Always parenthesised, so the result drops into any expression position
 *  (`(name of term) contains <expr>`) regardless of whether it concatenated. */
export function asStr(s: string): string {
  const parts: string[] = [];
  let run = "";
  const flush = () => {
    if (run) { parts.push('"' + run.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'); run = ""; }
  };
  // Iterate by code POINT: `character id` takes a Unicode scalar and rejects a
  // lone surrogate ("Can't get character id 55357"), so an emoji must go out as
  // its full code point, not the two units a JS string stores it in.
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) run += ch;
    else { flush(); parts.push(`(character id ${code})`); }
  }
  flush();
  return "(" + (parts.length ? parts.join(" & ") : '""') + ")";
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
  opts: { model?: string; permissionMode?: string; serverUrl?: string },
  persona: Persona | null,
): string {
  let flags = "";
  if (opts.model && ALLOWED_MODELS.has(opts.model)) flags += ` --model ${opts.model}`;
  if (opts.permissionMode && ALLOWED_PERMISSION_MODES.has(opts.permissionMode)) flags += ` --permission-mode ${opts.permissionMode}`;
  if (persona) flags += ` --append-system-prompt ${shq(composePrompt(persona))}`;
  let env = persona ? `AGENT_PERSONA=${persona.id} ` : "";
  // Where the dashboard's card API lives — how a launched agent addresses the
  // board (the persona prompt points it at $AGENT_WORKSHOP_URL).
  if (opts.serverUrl) env += `AGENT_WORKSHOP_URL=${shq(opts.serverUrl)} `;
  return `${env}claude${flags} ${shq(task)}\n`;
}

/** The `.claude/settings.local.json` contents written into a freshly created
 *  worktree before its agent launches: allow exactly the board read and the
 *  card-scoped writes, so a worker can drive its own ticket without stalling on
 *  a permission prompt. Deliberately NOT the spawn/kill/prompt endpoints —
 *  anything that reaches other sessions or starts new ones stays behind a
 *  human approval. */
export function workerPermissionSettings(serverUrl: string): { permissions: { allow: string[] } } {
  return {
    permissions: {
      allow: [
        `Bash(curl -s ${serverUrl}/board)`,
        `Bash(curl -s ${serverUrl}/agents)`,
        `Bash(curl -s -X POST ${serverUrl}/action/card-move:*)`,
        `Bash(curl -s -X POST ${serverUrl}/action/card-comment:*)`,
      ],
    },
  };
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
 *  ignored, same as an unknown model.
 *  `opts.serverUrl` (the dashboard's own origin) rides into the session's env,
 *  and — for a fresh worktree only — is written into the worktree's
 *  `.claude/settings.local.json` as a narrow curl allowlist, so the agent can
 *  move/comment its own card without stalling on a permission prompt. Only a
 *  worktree gets this: writing settings into a user's real folder uninvited is
 *  not this tool's call to make. */
export async function spawnAgent(
  cwd: string,
  task: string,
  opts?: { model?: string; permissionMode?: string; worktree?: string; persona?: string; serverUrl?: string },
): Promise<ActionResult> {
  let launchCwd = cwd;
  if (opts?.worktree) {
    const wt = await createWorktree(cwd, opts.worktree);
    if (!wt.ok) return { ok: false, error: wt.error ?? "could not create worktree" };
    launchCwd = wt.path!;
    if (opts.serverUrl) {
      try {
        const dir = `${launchCwd}/.claude`;
        const file = `${dir}/settings.local.json`;
        // A brand-new worktree can't have local settings yet; don't clobber if
        // something unexpected is there.
        if (!(await Bun.file(file).exists())) {
          await Bun.write(file, JSON.stringify(workerPermissionSettings(opts.serverUrl), null, 2) + "\n");
        }
      } catch { /* best-effort — the agent just gets permission prompts instead */ }
    }
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

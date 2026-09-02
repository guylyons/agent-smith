// OS actions on a real Claude session: focus its Ghostty terminal, send it a
// prompt/answer, or interrupt it. macOS + Ghostty specific (uses Ghostty's
// AppleScript dictionary, which works without Accessibility permission).
// Best-effort: every call resolves to a {ok, error?} result and never throws.
import { writeFile } from "node:fs/promises";
import type { AgentStatus } from "./schema";
import { prepareLaunch } from "./lib/worktree";
import { composeIdentityPrompt, composePrompt, getPersona, type Persona } from "./lib/personas";
import type { Crew } from "./lib/crew";
import { isSessionHostComm } from "./lib/proc";

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

/** The terminal input for a NEW task: submit `/clear` first, wait for it to
 *  reset the context, then type and submit the task. Pure and exported so the
 *  clear-first ordering is unit-tested without driving AppleScript. Handing an
 *  agent a fresh task should not leave the previous ticket in its context. */
export function freshTaskInput(text: string): string {
  return `input text ${asStr("/clear")} to term
            delay 0.1
            send key "enter" to term
            delay 0.7
            input text ${asStr(text)} to term
            delay 0.1
            send key "enter" to term`;
}

/** Like sendPrompt, but clears the session's context first (see freshTaskInput).
 *  Used for delivering a card's task to a live agent, so each ticket starts
 *  clean rather than inheriting the last one. */
export async function sendFreshPrompt(t: Target, text: string): Promise<ActionResult> {
  const r = await runOnTerminal(t, freshTaskInput(text), false);
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
 *  what binds the persona to the real session id. The crew member (id + name,
 *  minted by the server) rides the same way: the prompt is addressed to the
 *  name, and the env carries both so every session the process runs — this
 *  one, and each one a /clear starts — keeps the same identity. */
export function buildLaunchInput(
  task: string,
  opts: { model?: string; permissionMode?: string; serverUrl?: string; cardId?: string; crew?: Crew },
  persona: Persona | null,
): string {
  let flags = "";
  if (opts.model && ALLOWED_MODELS.has(opts.model)) flags += ` --model ${opts.model}`;
  if (opts.permissionMode && ALLOWED_PERMISSION_MODES.has(opts.permissionMode)) flags += ` --permission-mode ${opts.permissionMode}`;
  const crew = opts.crew;
  if (persona) flags += ` --append-system-prompt ${shq(composePrompt(persona, crew?.name))}`;
  else if (crew) flags += ` --append-system-prompt ${shq(composeIdentityPrompt(crew.name))}`;
  let env = persona ? `AGENT_PERSONA=${persona.id} ` : "";
  if (crew) env += `AGENT_CREW=${shq(crew.id)} AGENT_NAME=${shq(crew.name)} `;
  // Where the dashboard's card API lives — how a launched agent addresses the
  // board (the persona prompt points it at $AGENT_WORKSHOP_URL).
  if (opts.serverUrl) env += `AGENT_WORKSHOP_URL=${shq(opts.serverUrl)} `;
  // The card this session was spawned for. The SessionStart hook reads it and
  // self-assigns the card to the real session id (which only exists once the
  // new terminal is running), closing the gap where "new agent for this card"
  // left the card unassigned. Shell-quoted: it crosses the launch command
  // unsanitized, like the URL above.
  if (opts.cardId) env += `AGENT_CARD=${shq(opts.cardId)} `;
  return `${env}claude${flags} ${shq(task)}\n`;
}

/** The `.claude/settings.local.json` contents written into a freshly created
 *  worktree before its agent launches: allow exactly the board read and the
 *  card-scoped writes — as curl calls AND as the board's MCP tools, so a worker
 *  can drive its own ticket either way without stalling on a permission prompt.
 *  Deliberately NOT the spawn/kill/prompt endpoints, or the MCP tools that reach
 *  other sessions: anything that touches another session or starts a new one
 *  stays behind a human approval. */
export function workerPermissionSettings(serverUrl: string): { permissions: { allow: string[] } } {
  return {
    permissions: {
      allow: [
        `Bash(curl -s ${serverUrl}/board)`,
        `Bash(curl -s ${serverUrl}/agents)`,
        `Bash(curl -s -X POST ${serverUrl}/action/card-move:*)`,
        `Bash(curl -s -X POST ${serverUrl}/action/card-comment:*)`,
        // Its own notes (see src/lib/crew.ts): what it wants its future self to
        // know, handed back at every SessionStart.
        `Bash(curl -s -X POST ${serverUrl}/action/crew-note:*)`,
        // The same reads and writes again as MCP tools, for sessions that have
        // the board's MCP server registered (bun run install-mcp). Same line
        // drawn in the same place: nothing here reaches another session.
        "mcp__the-line__board_read",
        "mcp__the-line__card_read",
        "mcp__the-line__agents_list",
        "mcp__the-line__card_move",
        "mcp__the-line__card_comment",
        "mcp__the-line__crew_note",
        // The Done column's usual instruction is "worktree clean and committed",
        // so the local git verbs a worker needs mustn't stall it either. The
        // worktree is isolated, so a commit here can't touch anyone's branch;
        // push stays behind a human approval.
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(git add:*)",
        "Bash(git commit:*)",
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
 *  `opts.worktree` and `opts.branch` choose the working area (see prepareLaunch):
 *  a worktree name creates an isolated worktree off the folder's HEAD and
 *  launches there so agents never share a working tree; a branch name alone puts
 *  the folder itself on that feature branch; both gives a worktree checked out
 *  on the branch you named. A failure to prepare aborts the launch with its error.
 *  `opts.persona`, when it names a known persona, binds that persona to the new
 *  session (see buildLaunchInput); an unknown id resolves to null and is
 *  ignored, same as an unknown model. `opts.crew` is the crew member (id +
 *  name) the server minted for this launch.
 *  `opts.serverUrl` (the dashboard's own origin) rides into the session's env,
 *  and — for a fresh worktree only — is written into the worktree's
 *  `.claude/settings.local.json` as a narrow curl allowlist, so the agent can
 *  move/comment its own card without stalling on a permission prompt. Only a
 *  worktree gets this: writing settings into a user's real folder uninvited is
 *  not this tool's call to make. */
export async function spawnAgent(
  cwd: string,
  task: string,
  opts?: { model?: string; permissionMode?: string; worktree?: string; branch?: string; persona?: string; serverUrl?: string; cardId?: string; crew?: Crew },
): Promise<ActionResult> {
  const prepared = await prepareLaunch(cwd, { worktree: opts?.worktree, branch: opts?.branch });
  if (!prepared.ok) return { ok: false, error: prepared.error ?? "could not prepare the working area" };
  const launchCwd = prepared.path!;
  if (prepared.worktreeCreated && opts?.serverUrl) {
    try {
      const file = `${launchCwd}/.claude/settings.local.json`;
      // A brand-new worktree can't have local settings yet; don't clobber if
      // something unexpected is there.
      if (!(await Bun.file(file).exists())) {
        await Bun.write(file, JSON.stringify(workerPermissionSettings(opts.serverUrl), null, 2) + "\n");
      }
    } catch { /* best-effort — the agent just gets permission prompts instead */ }
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
    // recycled pid (e.g. a browser). Same rule the scanner's liveness check uses.
    if (!isSessionHostComm(comm)) {
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

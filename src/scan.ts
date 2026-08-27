// Scan Claude Code session transcripts and surface currently-open sessions as
// status files, so already-running windows appear on the dashboard without
// waiting for each to fire a hook. Runs periodically alongside the hooks;
// hooks remain the real-time authority (they alone see permission prompts).
//
// A transcript is only surfaced if it maps to an actually-running, top-level
// Claude process — otherwise old/abandoned transcripts and internal sub-sessions
// (subagents, scratchpad work under /private/tmp) show up as phantom agents.
import { homedir } from "node:os";
import { join } from "node:path";
import { open, stat, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import type { AgentStatus } from "./schema";
import { parseStatus } from "./schema";
import { ensureStatusDir } from "./lib/paths";
import { deriveStatusFromTranscript } from "./lib/transcript";
import { parseConversation, findPendingQuestion, type ChatMessage, type PendingQuestion } from "./lib/conversation";
import { deriveSubagent, type Subagent } from "./lib/subagents";

const FRESH_MS = Number(process.env.AGENT_SCAN_FRESH_MS ?? 15 * 60_000);
const TAIL_BYTES = 64 * 1024;

export function projectsDir(): string {
  return process.env.AGENT_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** Ephemeral / internal working dirs that are never a real user window. */
export function isEphemeralCwd(cwd: string): boolean {
  return cwd.startsWith("/private/tmp/") || cwd.startsWith("/tmp/") || cwd.includes("/claude-501/");
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

export type GhosttyTerminal = { cwd: string; name: string };

const GHOSTTY_TERM_SEP = "\t"; // unlikely to appear in a cwd/title

/**
 * List every open Ghostty terminal (cwd + tab name), once per scan pass, via
 * a single AppleScript call. Never throws and never launches Ghostty (guarded
 * by `application "Ghostty" is running`). Returns { terminals: [], ok: false }
 * on any failure so callers can fall back rather than trust an empty result.
 */
export async function ghosttyTerminals(): Promise<{ terminals: GhosttyTerminal[]; ok: boolean }> {
  const script = `if application "Ghostty" is running then
    tell application "Ghostty"
      set out to ""
      repeat with w in windows
        repeat with t in tabs of w
          repeat with term in terminals of t
            try
              set out to out & (working directory of term) & "${GHOSTTY_TERM_SEP}" & (name of term) & linefeed
            end try
          end repeat
        end repeat
      end repeat
      return out
    end tell
  else
    return "NOTRUNNING"
  end if`;
  try {
    const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) return { terminals: [], ok: false };
    const trimmed = out.trim();
    if (trimmed === "NOTRUNNING") return { terminals: [], ok: false };
    const terminals: GhosttyTerminal[] = [];
    for (const line of out.split("\n")) {
      const idx = line.indexOf(GHOSTTY_TERM_SEP);
      if (idx < 0) continue;
      const cwd = line.slice(0, idx);
      const name = line.slice(idx + GHOSTTY_TERM_SEP.length);
      if (cwd) terminals.push({ cwd, name });
    }
    return { terminals, ok: true };
  } catch {
    return { terminals: [], ok: false };
  }
}

/** Does a Ghostty terminal's tab name correspond to session `title`? Mirrors
 *  ghostty.ts's own runOnTerminal targeting (exact, or suffix — tolerating a
 *  leading prefix symbol like "✳ ") so "chosen" always means "focusable". */
function terminalMatchesTitle(termName: string, title: string): boolean {
  return termName === title || termName.endsWith(title);
}

/**
 * Count running top-level `claude` CLI processes per working directory.
 * Returns { counts, ok }: ok=false means we couldn't read process info at all
 * (ps failed / no claude found), in which case callers fall back rather than
 * blank the dashboard. Ephemeral cwds are dropped.
 */
export async function runningClaudeCounts(): Promise<{ counts: Map<string, number>; ok: boolean }> {
  const counts = new Map<string, number>();
  let psout = "";
  try { psout = await run(["ps", "ax", "-o", "pid=,comm="]); } catch { return { counts, ok: false }; }
  const pids: string[] = [];
  for (const line of psout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    // exact comm "claude" = the CLI (not the desktop app). NOTE: an npm-shim
    // install invoked via node/bun would report "node"/"bun" here and match
    // nothing -> ok:false -> chooseLive falls back to all-fresh (pre-fix behavior).
    if (m && m[2].trim() === "claude") pids.push(m[1]);
  }
  if (!pids.length) return { counts, ok: false };
  // Resolve every pid's cwd in parallel (serial lsof was ~37ms/pid).
  const cwds = await Promise.all(pids.map(async (pid) => {
    try {
      const l = await run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"]);
      const nline = l.split("\n").find((x) => x.startsWith("n"));
      return nline ? nline.slice(1) : "";
    } catch { return ""; }
  }));
  for (const cwd of cwds) {
    if (!cwd || isEphemeralCwd(cwd)) continue;
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  // If we resolved no cwds at all (e.g. lsof unavailable/failed for every pid),
  // report ok:false so callers FALL BACK rather than blanking the dashboard and
  // deleting tracked sessions.
  return { counts, ok: counts.size > 0 };
}

/** Read the last `bytes` of a file and return its lines (bounded, for large transcripts). */
async function tailLinesOf(file: string, bytes: number): Promise<string[]> {
  const { size } = await stat(file);
  const start = Math.max(0, size - bytes);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fh = await open(file, "r");
  try { await fh.read(buf, 0, len, start); } finally { await fh.close(); }
  return buf.toString("utf8").split("\n");
}
const tailLines = (file: string) => tailLinesOf(file, TAIL_BYTES);

/** Find a session's transcript and parse it into a chat log + any pending question. */
export async function readConversation(sessionId: string, maxBytes = 512 * 1024): Promise<{ messages: ChatMessage[]; question: PendingQuestion | null }> {
  const root = projectsDir();
  let projects: import("node:fs").Dirent[];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return { messages: [], question: null }; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const file = join(root, proj.name, `${sessionId}.jsonl`);
    try {
      const lines = await tailLinesOf(file, maxBytes);
      return { messages: parseConversation(lines), question: findPendingQuestion(lines) };
    } catch { /* not in this project dir */ }
  }
  return { messages: [], question: null };
}

/** Count subagents actively writing (mtime < 90s) in a session's subagents dir. */
export async function countActiveSubagents(transcriptFile: string, now: number, activeMs = 90_000): Promise<number> {
  const dir = transcriptFile.replace(/\.jsonl$/, "") + "/subagents";
  let entries: string[];
  try { entries = await readdir(dir); } catch { return 0; }
  let n = 0;
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    try { if (now - (await stat(join(dir, e))).mtimeMs < activeMs) n++; } catch { /* skip */ }
  }
  return n;
}

/** List a session's recent subagents with their description + current activity. */
export async function readSubagents(sessionId: string, now: number, maxAgeMs = 10 * 60_000): Promise<Subagent[]> {
  const root = projectsDir();
  let projects: import("node:fs").Dirent[];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return []; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const subdir = join(root, proj.name, sessionId, "subagents");
    let entries: string[];
    try { entries = await readdir(subdir); } catch { continue; } // not this project
    const out: Subagent[] = [];
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      const file = join(subdir, e);
      try {
        const mtimeMs = (await stat(file)).mtimeMs;
        if (now - mtimeMs > maxAgeMs) continue;
        const agentId = e.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        let meta = {};
        try { meta = JSON.parse(await readFile(join(subdir, e.replace(/\.jsonl$/, ".meta.json")), "utf8")); } catch { /* no meta */ }
        out.push(deriveSubagent(agentId, meta, await tailLinesOf(file, 32 * 1024), mtimeMs, now));
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return [];
}

/** Top-level transcript files modified within freshMs (subagent sidechains live in subdirs and are skipped). */
export async function freshTranscripts(now: number, freshMs = FRESH_MS): Promise<string[]> {
  const root = projectsDir();
  const out: string[] = [];
  let projects: import("node:fs").Dirent[];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const dir = join(root, proj.name);
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue; // subdirs (subagents/) skipped
      const file = join(dir, ent.name);
      try { if (now - (await stat(file)).mtimeMs <= freshMs) out.push(file); } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * Decide what to write for a session the scanner found open.
 * A permission "needs you" is invisible in the transcript, so once a hook sets
 * it we must NOT let a transcript-derived state overwrite it — we only refresh
 * its liveness (updatedAt) so it stays on the dashboard until a hook clears it
 * (PreToolUse/Stop/SessionEnd) or the session goes stale and ages out.
 */
export function mergeForWrite(existing: AgentStatus | null, derived: AgentStatus, now: number): AgentStatus {
  if (existing && existing.waitingReason === "permission") {
    return { ...existing, updatedAt: now };
  }
  // Transcript-derived status never carries pid/tty (only the hook captures them);
  // carry them forward so a routine scan pass doesn't erase the hook's work and
  // break focus/pause for a session that's just quietly thinking.
  const carried = { ...derived };
  if (carried.pid === undefined && existing?.pid !== undefined) carried.pid = existing.pid;
  if (carried.tty === undefined && existing?.tty !== undefined) carried.tty = existing.tty;
  return carried;
}

type Candidate = { derived: AgentStatus; mtime: number };

// Cache derived status by transcript path+mtime so an unchanged transcript isn't
// re-read (64KB) and re-parsed every 20s tick. Bounded to avoid unbounded growth.
const deriveCache = new Map<string, { mtime: number; base: AgentStatus }>();

const NO_GHOSTTY = { terminals: [] as GhosttyTerminal[], ok: false };

/**
 * Choose which sessions to surface: only cwds with a running claude process
 * are ever considered (unchanged safety net). Within such a cwd:
 *  - if the Ghostty terminal list is available, a titled candidate is kept only
 *    if its title matches an actually-open terminal in that cwd (a process whose
 *    tab was closed — orphaned/leaked — is dropped even though `ps` still counts
 *    it); an untitled candidate falls back to capping by however many terminals
 *    in that cwd are left unclaimed by a title match (newest first).
 *  - if the terminal list is unavailable (osascript failed / Ghostty not
 *    running), falls back to the original behavior: cap at the process count
 *    for that cwd (newest transcripts win) — never blank the board on an error.
 * When process info itself is unavailable, fall back to all fresh non-ephemeral
 * transcripts.
 */
export function chooseLive(
  cands: Candidate[],
  counts: Map<string, number>,
  ok: boolean,
  ghostty: { terminals: GhosttyTerminal[]; ok: boolean } = NO_GHOSTTY,
): AgentStatus[] {
  if (!ok) return cands.filter((c) => !isEphemeralCwd(c.derived.cwd)).map((c) => c.derived);
  const byCwd = new Map<string, Candidate[]>();
  for (const c of cands) {
    if (isEphemeralCwd(c.derived.cwd)) continue;
    (byCwd.get(c.derived.cwd) ?? byCwd.set(c.derived.cwd, []).get(c.derived.cwd)!).push(c);
  }
  const chosen: AgentStatus[] = [];
  for (const [cwd, list] of byCwd) {
    const n = counts.get(cwd) ?? 0;
    if (n <= 0) continue; // no running process for this cwd -> not a live window

    if (!ghostty.ok) {
      // Ghostty terminal list unavailable -- fall back to the process-count cap.
      list.sort((a, b) => b.mtime - a.mtime);
      for (const c of list.slice(0, n)) chosen.push(c.derived);
      continue;
    }

    const termsHere = ghostty.terminals.filter((t) => t.cwd === cwd);
    const titled = list.filter((c) => c.derived.title);
    const untitled = list.filter((c) => !c.derived.title);

    const claimed = new Set<number>(); // indices into termsHere already matched
    const titledOpen: Candidate[] = [];
    for (const c of titled) {
      const title = c.derived.title!;
      const idx = termsHere.findIndex((t, i) => !claimed.has(i) && terminalMatchesTitle(t.name, title));
      if (idx >= 0) { claimed.add(idx); titledOpen.push(c); }
      // no matching open terminal -> tab was closed, process is orphaned -> dropped
    }

    // Untitled sessions can fill the terminals no title claimed (their tab is open
    // but bears no recognizable title), newest first.
    const freeTerms = termsHere.length - claimed.size;
    untitled.sort((a, b) => b.mtime - a.mtime);
    const untitledOpen = freeTerms > 0 ? untitled.slice(0, freeTerms) : [];

    // Everything with an open terminal, but never more than n live processes for
    // this cwd. When a title still lingers on a tab whose process already exited,
    // its candidate can appear here too; capping at n and keeping the FRESHEST
    // transcripts drops that stale phantom in favor of the genuinely-live session
    // (whose transcript is being actively written) rather than hiding the latter.
    const open = [...titledOpen, ...untitledOpen].sort((a, b) => b.mtime - a.mtime);
    for (const c of open.slice(0, n)) chosen.push(c.derived);
  }
  return chosen;
}

/** One scan pass: derive open sessions from fresh transcripts, keep only those with a
 *  running process, write their status files, and clean up scanner-written phantoms. */
export async function scanLiveSessions(
  now: number,
  freshMs = FRESH_MS,
  countsOverride?: { counts: Map<string, number>; ok: boolean },
  ghosttyOverride?: { terminals: GhosttyTerminal[]; ok: boolean },
): Promise<number> {
  const dir = ensureStatusDir();
  const [{ counts, ok }, ghostty] = await Promise.all([
    countsOverride ? Promise.resolve(countsOverride) : runningClaudeCounts(),
    ghosttyOverride ? Promise.resolve(ghosttyOverride) : ghosttyTerminals(),
  ]);

  const cands: Candidate[] = [];
  if (deriveCache.size > 200) deriveCache.clear();
  for (const file of await freshTranscripts(now, freshMs)) {
    try {
      const mtime = (await stat(file)).mtimeMs;
      const cached = deriveCache.get(file);
      let base: AgentStatus | null;
      if (cached && cached.mtime === mtime) {
        base = cached.base; // unchanged transcript — reuse, no re-read/parse
      } else {
        base = deriveStatusFromTranscript(await tailLines(file), now);
        if (base) deriveCache.set(file, { mtime, base });
      }
      if (!base) continue;
      const derived: AgentStatus = { ...base, updatedAt: now }; // refresh liveness
      const subs = await countActiveSubagents(file, now);
      if (subs > 0) {
        derived.subagents = subs;
        // A parent delegating to subagents isn't "idle" — its work is happening.
        if (derived.state === "idle") {
          derived.state = "working";
          derived.doing = `${subs} subagent${subs > 1 ? "s" : ""} working`;
        }
      }
      cands.push({ derived, mtime });
    } catch { /* skip */ }
  }

  const chosen = chooseLive(cands, counts, ok, ghostty);
  const chosenIds = new Set(chosen.map((c) => c.sessionId));

  for (const status of chosen) {
    const target = join(dir, `${status.sessionId}.json`);
    let existing: AgentStatus | null = null;
    try { existing = parseStatus(JSON.parse(await readFile(target, "utf8"))); } catch { existing = null; }
    const final = mergeForWrite(existing, status, now);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(final));
    await rename(tmp, target); // atomic
  }

  // Remove scanner-written status files (no pid — hooks set pid) that are no longer live.
  let names: string[] = [];
  try { names = await readdir(dir); } catch { /* none */ }
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const sid = name.slice(0, -5);
    if (chosenIds.has(sid)) continue;
    try {
      const st = parseStatus(JSON.parse(await readFile(join(dir, name), "utf8")));
      if (st && st.pid === undefined) await unlink(join(dir, name)); // scanner-origin phantom
    } catch { /* leave unreadable files for the reader to skip */ }
  }

  return chosen.length;
}

if (import.meta.main) {
  scanLiveSessions(Date.now()).then((n) => console.log(`scanned ${n} live session(s) into ${ensureStatusDir()}`));
}

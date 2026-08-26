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
import { parseConversation, type ChatMessage } from "./lib/conversation";

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
  for (const pid of pids) {
    let cwd = "";
    try {
      const l = await run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"]);
      const nline = l.split("\n").find((x) => x.startsWith("n"));
      cwd = nline ? nline.slice(1) : "";
    } catch { /* skip this pid */ }
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

/** Find a session's transcript and parse it into a chat log (last ~maxBytes). */
export async function readConversation(sessionId: string, maxBytes = 512 * 1024): Promise<ChatMessage[]> {
  const root = projectsDir();
  let projects: import("node:fs").Dirent[];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return []; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const file = join(root, proj.name, `${sessionId}.jsonl`);
    try {
      const lines = await tailLinesOf(file, maxBytes);
      return parseConversation(lines);
    } catch { /* not in this project dir */ }
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

/**
 * Choose which sessions to surface: only cwds with a running claude process,
 * capped at the number of processes there (newest transcripts win). When process
 * info is unavailable, fall back to all fresh non-ephemeral transcripts.
 */
export function chooseLive(cands: Candidate[], counts: Map<string, number>, ok: boolean): AgentStatus[] {
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
    list.sort((a, b) => b.mtime - a.mtime);
    for (const c of list.slice(0, n)) chosen.push(c.derived);
  }
  return chosen;
}

/** One scan pass: derive open sessions from fresh transcripts, keep only those with a
 *  running process, write their status files, and clean up scanner-written phantoms. */
export async function scanLiveSessions(
  now: number,
  freshMs = FRESH_MS,
  countsOverride?: { counts: Map<string, number>; ok: boolean },
): Promise<number> {
  const dir = ensureStatusDir();
  const { counts, ok } = countsOverride ?? (await runningClaudeCounts());

  const cands: Candidate[] = [];
  for (const file of await freshTranscripts(now, freshMs)) {
    try {
      const derived = deriveStatusFromTranscript(await tailLines(file), now);
      if (!derived) continue;
      cands.push({ derived, mtime: (await stat(file)).mtimeMs });
    } catch { /* skip */ }
  }

  const chosen = chooseLive(cands, counts, ok);
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

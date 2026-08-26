// Scan Claude Code session transcripts and surface currently-open sessions as
// status files, so already-running windows appear on the dashboard without
// waiting for each to fire a hook. Runs periodically alongside the hooks;
// hooks remain the real-time authority (they alone see permission prompts).
//
// Async throughout so a scan pass never blocks the server's event loop.
import { homedir } from "node:os";
import { join } from "node:path";
import { open, stat, readdir, readFile, writeFile, rename } from "node:fs/promises";
import type { AgentStatus } from "./schema";
import { parseStatus } from "./schema";
import { ensureStatusDir } from "./lib/paths";
import { deriveStatusFromTranscript } from "./lib/transcript";

const FRESH_MS = Number(process.env.AGENT_SCAN_FRESH_MS ?? 15 * 60_000);
const TAIL_BYTES = 64 * 1024;

export function projectsDir(): string {
  return process.env.AGENT_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** Read the last ~TAIL_BYTES of a file and return its lines (bounded, for large transcripts). */
async function tailLines(file: string): Promise<string[]> {
  const { size } = await stat(file);
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fh = await open(file, "r");
  try { await fh.read(buf, 0, len, start); } finally { await fh.close(); }
  return buf.toString("utf8").split("\n");
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
  return derived;
}

/** One scan pass: derive open sessions from fresh transcripts and write their status files. */
export async function scanLiveSessions(now: number, freshMs = FRESH_MS): Promise<number> {
  const dir = ensureStatusDir();
  let written = 0;
  for (const file of await freshTranscripts(now, freshMs)) {
    let derived: AgentStatus | null;
    try { derived = deriveStatusFromTranscript(await tailLines(file), now); } catch { continue; }
    if (!derived) continue;
    const target = join(dir, `${derived.sessionId}.json`);
    let existing: AgentStatus | null = null;
    try { existing = parseStatus(JSON.parse(await readFile(target, "utf8"))); } catch { existing = null; }
    const final = mergeForWrite(existing, derived, now);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(final));
    await rename(tmp, target); // atomic
    written++;
  }
  return written;
}

if (import.meta.main) {
  scanLiveSessions(Date.now()).then((n) => console.log(`scanned ${n} live session(s) into ${ensureStatusDir()}`));
}

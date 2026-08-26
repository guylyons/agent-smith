// Scan Claude Code session transcripts and surface currently-open sessions as
// status files, so already-running windows appear on the dashboard without
// waiting for each to fire a hook. Runs periodically alongside the hooks;
// hooks remain the real-time authority (they alone see permission prompts).
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readdirSync, statSync, openSync, readSync, closeSync,
  writeFileSync, renameSync, existsSync, readFileSync,
} from "node:fs";
import type { AgentStatus } from "./schema";
import { parseStatus } from "./schema";
import { ensureStatusDir } from "./lib/paths";
import { deriveStatusFromTranscript } from "./lib/transcript";

const FRESH_MS = Number(process.env.AGENT_SCAN_FRESH_MS ?? 15 * 60_000);
const TAIL_BYTES = 64 * 1024;
// A permission "needs-you" set by a hook is invisible in the transcript; keep it
// sticky briefly so a scan tick can't overwrite it with a staler idle/working.
const PERMISSION_STICKY_MS = 120_000;

export function projectsDir(): string {
  return process.env.AGENT_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** Read the last ~TAIL_BYTES of a file and return its lines (bounded, for large transcripts). */
function tailLines(file: string): string[] {
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  return buf.toString("utf8").split("\n");
}

/** Top-level transcript files modified within FRESH_MS (excludes subagent sidechains, which live in subdirs). */
export function freshTranscripts(now: number, freshMs = FRESH_MS): string[] {
  const root = projectsDir();
  const out: string[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(root); } catch { return out; }
  for (const proj of projects) {
    const dir = join(root, proj);
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue; // subdirs (subagents/) skipped
      const file = join(dir, ent.name);
      try { if (now - statSync(file).mtimeMs <= freshMs) out.push(file); } catch { /* skip */ }
    }
  }
  return out;
}

/** Should the scanner's candidate replace what's already on disk for this session? */
export function shouldWrite(existing: AgentStatus | null, now: number): boolean {
  if (!existing) return true;
  // Preserve a fresh, hook-set permission prompt the transcript can't see.
  if (existing.waitingReason === "permission" && now - existing.updatedAt < PERMISSION_STICKY_MS) return false;
  return true;
}

/** One scan pass: derive open sessions from fresh transcripts and write their status files. */
export function scanLiveSessions(now: number, freshMs = FRESH_MS): number {
  const dir = ensureStatusDir();
  let written = 0;
  for (const file of freshTranscripts(now, freshMs)) {
    let status: AgentStatus | null;
    try { status = deriveStatusFromTranscript(tailLines(file), now); } catch { continue; }
    if (!status) continue;
    const target = join(dir, `${status.sessionId}.json`);
    let existing: AgentStatus | null = null;
    if (existsSync(target)) {
      try { existing = parseStatus(JSON.parse(readFileSync(target, "utf8"))); } catch { existing = null; }
    }
    if (!shouldWrite(existing, now)) continue;
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(status));
    renameSync(tmp, target); // atomic
    written++;
  }
  return written;
}

if (import.meta.main) {
  const n = scanLiveSessions(Date.now());
  console.log(`scanned ${n} live session(s) into ${ensureStatusDir()}`);
}

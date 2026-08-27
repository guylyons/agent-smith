// hooks/status.ts
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import type { AgentStatus } from "../src/schema";
import { parseStatus } from "../src/schema";
import { parseTicket } from "../src/lib/ticket";
import { identify } from "../src/lib/identity";
import { humanizeTool } from "../src/lib/humanize";
import { ensureStatusDir } from "../src/lib/paths";

export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  branch: string | null;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  last_assistant_message?: string; // real Claude Code field on Stop
  last_message?: string;           // back-compat alias
};

function seed(e: HookEvent, now: number): AgentStatus {
  const { role, name } = identify(e.session_id, e.branch, e.cwd);
  return {
    sessionId: e.session_id, name, role,
    ticket: parseTicket(e.branch), state: "working",
    doing: "starting up", cwd: e.cwd, branch: e.branch, updatedAt: now,
  };
}

export function applyEvent(prev: AgentStatus | null, e: HookEvent, now: number): AgentStatus | null {
  const base = prev ?? seed(e, now);
  switch (e.hook_event_name) {
    case "SessionStart":
      return seed(e, now);
    case "PreToolUse":
      return { ...base, state: "working", waitingReason: undefined,
        doing: humanizeTool(e.tool_name ?? "", e.tool_input), updatedAt: now };
    case "Notification":
      return { ...base, state: "waiting", waitingReason: "permission", updatedAt: now };
    case "Stop":
      // A finished turn is idle. A genuine question (AskUserQuestion) blocks the
      // turn — it doesn't reach Stop — and the transcript scanner surfaces it as
      // waiting/question. A rhetorical '?' in the final message is not a question.
      return { ...base, state: "idle", waitingReason: undefined, updatedAt: now };
    case "SessionEnd":
      return null;
    default:
      return { ...base, updatedAt: now };
  }
}

// --- I/O glue (not unit-tested; exercised in the integration smoke test) ---
function resolveBranch(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"]);
    const out = proc.stdout.toString("utf8").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // not a git repo, git missing, etc.
  }
}

// The Claude process that spawned this hook is our parent; capture it and its
// controlling terminal so the dashboard can focus/interrupt the real session.
function resolveProcess(): { pid?: number; tty?: string } {
  const pid = process.ppid;
  if (!pid) return {};
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]);
    const t = proc.stdout.toString("utf8").trim(); // e.g. "ttys006" or "??"
    const tty = t && t !== "??" ? `/dev/${t}` : undefined;
    return { pid, tty };
  } catch {
    return { pid };
  }
}

async function main() {
  const raw = await Bun.stdin.text();
  let e: HookEvent;
  try {
    e = JSON.parse(raw) as HookEvent;
  } catch {
    return; // malformed event on stdin; never crash the hook
  }
  if (e.branch === undefined || e.branch === null) {
    e = { ...e, branch: resolveBranch(e.cwd) };
  }
  const dir = ensureStatusDir();
  const file = join(dir, `${e.session_id}.json`);
  let prev: AgentStatus | null = null;
  if (existsSync(file)) {
    try {
      prev = parseStatus(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      prev = null; // corrupt/partial prior status file; treat as fresh
    }
  }
  const next = applyEvent(prev, e, Date.now());
  if (next === null) { rmSync(file, { force: true }); return; }
  const { pid, tty } = resolveProcess();
  if (pid) next.pid = pid;
  if (tty) next.tty = tty;
  // Unique per-process tmp so concurrent hook invocations for the same session
  // never write and rename the same tmp file (which races to ENOENT).
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  try {
    renameSync(tmp, file); // atomic within the same directory
  } catch (err) {
    rmSync(tmp, { force: true }); // don't leak our tmp if the rename fails
    throw err;
  }
}

if (import.meta.main) void main();

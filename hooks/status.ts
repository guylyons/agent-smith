// hooks/status.ts
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import type { AgentStatus } from "../src/schema";
import { parseStatus } from "../src/schema";
import { parseTicket } from "../src/lib/ticket";
import { inferRole } from "../src/lib/role";
import { humanizeTool } from "../src/lib/humanize";
import { ensureStatusDir } from "../src/lib/paths";

export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  branch: string | null;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  last_message?: string;
};

function seed(e: HookEvent, now: number): AgentStatus {
  const { role, name } = inferRole(e.branch, e.cwd);
  return {
    sessionId: e.session_id, name, role,
    ticket: parseTicket(e.branch), state: "working",
    doing: "starting up", cwd: e.cwd, branch: e.branch, updatedAt: now,
  };
}

const QUESTION = /\?\s*$/;

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
    case "Stop": {
      const asking = !!e.last_message && QUESTION.test(e.last_message.trim());
      return { ...base, state: asking ? "waiting" : "idle",
        waitingReason: asking ? "question" : undefined, updatedAt: now };
    }
    case "SessionEnd":
      return null;
    default:
      return { ...base, updatedAt: now };
  }
}

// --- I/O glue (not unit-tested; exercised in the integration smoke test) ---
async function main() {
  const raw = await Bun.stdin.text();
  const e = JSON.parse(raw) as HookEvent;
  const dir = ensureStatusDir();
  const file = join(dir, `${e.session_id}.json`);
  const prev = existsSync(file) ? parseStatus(JSON.parse(readFileSync(file, "utf8"))) : null;
  const next = applyEvent(prev, e, Date.now());
  if (next === null) { rmSync(file, { force: true }); return; }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file); // atomic
}

if (import.meta.main) void main();

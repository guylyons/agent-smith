// hooks/status.ts
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import type { AgentStatus } from "../src/schema";
import { parseStatus } from "../src/schema";
import { parseTicket } from "../src/lib/ticket";
import { identify } from "../src/lib/identity";
import { humanizeTool } from "../src/lib/humanize";
import { ensureStatusDir } from "../src/lib/paths";

// Mirrors PERSONA_ID_RE in src/lib/personas.ts. Duplicated deliberately: the
// hook stores the id and nothing else, so it never loads the registry.
const PERSONA_ID_RE = /^[a-z0-9-]{1,64}$/;

export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  branch: string | null;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

function seed(e: HookEvent, now: number, persona?: string): AgentStatus {
  const { role, name } = identify(e.session_id, e.branch, e.cwd);
  return {
    sessionId: e.session_id, name, role,
    ticket: parseTicket(e.branch), state: "working",
    doing: "starting up", cwd: e.cwd, branch: e.branch, updatedAt: now,
    // Set at launch by the dashboard and inherited by this hook from the claude
    // process. Only the id is stored; the server resolves the rest.
    ...(persona && PERSONA_ID_RE.test(persona) ? { persona } : {}),
  };
}

/**
 * Pull the questions+options out of an AskUserQuestion's tool_input so the pane can
 * render them. This is the ONLY live source for a pending question: Claude Code does
 * not flush a blocked AskUserQuestion to the transcript (it lands only once answered,
 * backdated), so the scanner can never see one. Shape-checked defensively — a payload
 * we don't recognise yields undefined rather than a malformed status file.
 */
function parseQuestions(input: Record<string, unknown> | undefined): AgentStatus["pendingQuestion"] {
  const raw = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw)) return undefined;
  const questions = raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    if (typeof o.question !== "string") return [];
    const opts = Array.isArray(o.options) ? o.options : [];
    return [{
      ...(typeof o.header === "string" ? { header: o.header } : {}),
      question: o.question,
      ...(typeof o.multiSelect === "boolean" ? { multiSelect: o.multiSelect } : {}),
      options: opts.flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const oo = x as Record<string, unknown>;
        if (typeof oo.label !== "string") return [];
        return [{ label: oo.label, ...(typeof oo.description === "string" ? { description: oo.description } : {}) }];
      }),
    }];
  });
  return questions.length ? { questions } : undefined;
}

export function applyEvent(prev: AgentStatus | null, e: HookEvent, now: number, persona?: string): AgentStatus | null {
  const next = applyEventInner(prev, e, now, persona);
  // Re-stamp the persona on EVERY event, not just the seed: a scanner pass can
  // write this session's file before (or between) hook events, and a prev
  // without the persona would otherwise carry that loss forward for the whole
  // session — stripping the agent's name/sprite and dropping it out of the
  // scrum-master notification fan-out.
  if (next && next.persona === undefined && persona && PERSONA_ID_RE.test(persona)) {
    return { ...next, persona };
  }
  return next;
}

function applyEventInner(prev: AgentStatus | null, e: HookEvent, now: number, persona?: string): AgentStatus | null {
  const base = prev ?? seed(e, now, persona);
  switch (e.hook_event_name) {
    case "SessionStart":
      return seed(e, now, persona);
    case "PreToolUse": {
      // These tools BLOCK on the user. PreToolUse fires the instant they begin,
      // which is the earliest any signal exists — the transcript scanner would
      // only notice on its next pass, up to 20s later.
      const blocking = e.tool_name === "AskUserQuestion"
        ? { waitingReason: "question" as const, doing: "waiting on your answer",
            pendingQuestion: parseQuestions(e.tool_input) }
        : e.tool_name === "ExitPlanMode"
        ? { waitingReason: "plan" as const, doing: "waiting on plan approval",
            pendingQuestion: undefined }
        : null;
      if (blocking) return { ...base, state: "waiting", ...blocking, updatedAt: now };
      return { ...base, state: "working", waitingReason: undefined, pendingQuestion: undefined,
        doing: humanizeTool(e.tool_name ?? "", e.tool_input), updatedAt: now };
    }
    case "Notification":
      // Also set `doing`: without it the card strands the previous tool's line
      // ("running rm -rf build") while the session actually sits on a prompt.
      return { ...base, state: "waiting", waitingReason: "permission",
        doing: "needs permission", pendingQuestion: undefined, updatedAt: now };
    case "Stop":
      // A finished turn is idle. A genuine question (AskUserQuestion) blocks the
      // turn — it doesn't reach Stop — and the transcript scanner surfaces it as
      // waiting/question. A rhetorical '?' in the final message is not a question.
      return { ...base, state: "idle", waitingReason: undefined, pendingQuestion: undefined, updatedAt: now };
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
  const next = applyEvent(prev, e, Date.now(), process.env.AGENT_PERSONA);
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

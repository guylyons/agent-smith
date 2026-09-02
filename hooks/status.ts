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
  let next = applyEventInner(prev, e, now, persona);
  if (next) {
    // Track when the current state began: reset on every transition (and on
    // SessionStart, which is a fresh session even if the state string matches),
    // carry through otherwise. The scanner mirrors this rule in mergeForWrite.
    const carried = prev && prev.state === next.state && e.hook_event_name !== "SessionStart"
      ? prev.stateSince ?? now
      : now;
    next = { ...next, stateSince: carried };
  }
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

// --- Stop: drain the board inbox -------------------------------------------

/** What the hook answers Claude Code with on Stop, given the board events that
 *  queued up while the session was busy. Nothing queued: null, the turn ends
 *  as normal. Otherwise a block decision whose reason is the batch, so the
 *  agent reads them as its next instruction — the same effect as a queued
 *  message, without typing into the pty (which can't reach a session at a
 *  dialog, and mangles anything non-ASCII). */
export function stopDecision(items: string[]): { decision: "block"; reason: string } | null {
  if (items.length === 0) return null;
  const reason = [
    "Board notifications arrived while you were working. Read them and act on",
    "any that expect a reply; the ones marked no reply needed are FYI.",
    "",
    items.join("\n\n"),
  ].join("\n");
  return { decision: "block", reason };
}

/** Collect this session's queued board events from the dashboard. Best-effort
 *  and quick: a dashboard that is down, slow, or answers badly yields nothing,
 *  and the turn ends normally — the events are on the board regardless. */
export async function drainInbox(base: string, sessionId: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchFn(`${base}/action/inbox-drain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: unknown };
    return Array.isArray(body.items) ? body.items.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const DASHBOARD_URL = () => process.env.AGENT_WORKSHOP_URL || "http://localhost:4173";

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
  let next = applyEvent(prev, e, Date.now(), process.env.AGENT_PERSONA);
  if (next === null) { rmSync(file, { force: true }); return; }
  // A turn that is about to end may have board events waiting for it. Fetch
  // them BEFORE writing the status, so a session that is sent back to work
  // isn't recorded as idle in between.
  const decision = e.hook_event_name === "Stop" ? stopDecision(await drainInbox(DASHBOARD_URL(), e.session_id)) : null;
  if (decision) next = { ...next, state: "working", doing: "reading board notifications" };
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

  // Self-assign the card this session was spawned for. A "new agent for this
  // card" spawn can't set the assignee at launch — the session id is minted
  // here, inside the new terminal — so the dashboard passes the card id in the
  // env and we bind it now, once the status file above exists for the server to
  // resolve our display name from. SessionStart only, best-effort: a failure
  // must never break the hook.
  if (e.hook_event_name === "SessionStart" && process.env.AGENT_CARD) {
    await assignCardOnStart(process.env.AGENT_CARD, e.session_id);
  }
  // Last, because stdout is the hook's answer: block the stop with the queued
  // board events as the reason. Nothing printed means "carry on as normal".
  if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
}

/** POST the card-assign the dashboard couldn't do at spawn time. Fire-and-await
 *  (so the request lands before this short-lived hook process exits) but never
 *  throw — an unreachable dashboard just leaves the card unassigned, the same
 *  state as before. */
async function assignCardOnStart(cardId: string, sessionId: string): Promise<void> {
  const base = DASHBOARD_URL();
  // Retry a few times: a brand-new session can beat the dashboard to the punch
  // (server still starting, or our status file not yet surfaced). One swallowed
  // failure used to leave the card unassigned for the whole session — the
  // "spawned via card, no chip" bug. The server also self-heals by reading our
  // status file directly, so this only needs to cover the moments it's unreachable.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/action/card-assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardId, sessionId }),
      });
      if (res.ok) return;
    } catch { /* not reachable yet — fall through to a short wait and retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

if (import.meta.main) void main();

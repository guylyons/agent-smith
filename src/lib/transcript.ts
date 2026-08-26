// Derive an AgentStatus from a Claude Code session transcript (.jsonl).
// Pure: given the transcript's tail lines, produce the status the dashboard shows.
// This is what surfaces an already-open session as a "person" without waiting
// for it to fire a hook. Keyed by the real sessionId so it never duplicates
// what hooks/status.ts writes for the same session.
import type { AgentStatus } from "../schema";
import { parseTicket } from "./ticket";
import { identify } from "./identity";
import { humanizeTool } from "./humanize";

const QUESTION = /\?\s*$/;

type Content = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };

function contentArray(entry: Record<string, unknown>): Content[] {
  const msg = entry.message as Record<string, unknown> | undefined;
  const c = msg?.content;
  return Array.isArray(c) ? (c as Content[]) : [];
}

/**
 * Reduce a transcript's tail into an AgentStatus, or null if the lines carry no
 * usable session. `updatedAt` is set by the caller (freshness), not the
 * transcript timestamp, so an open session stays alive on the dashboard.
 */
export function deriveStatusFromTranscript(lines: string[], updatedAt: number): AgentStatus | null {
  let sessionId: string | null = null;
  let cwd = "";
  let branch: string | null = null;
  let lastToolUse: { name: string; input?: Record<string, unknown> } | null = null;
  let lastAssistantText: string | null = null;
  let lastSubstantiveType: string | null = null; // "assistant" | "user" | "tool"

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }

    if (e.isSidechain === true || e.isMeta === true) continue; // subagents / meta noise
    if (typeof e.sessionId === "string") sessionId = e.sessionId;
    if (typeof e.cwd === "string") cwd = e.cwd;
    if (typeof e.gitBranch === "string") branch = e.gitBranch.length ? e.gitBranch : null;

    const type = e.type;
    if (type === "assistant") {
      for (const c of contentArray(e)) {
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          lastAssistantText = c.text.trim();
          lastSubstantiveType = "assistant";
        }
        if (c.type === "tool_use" && typeof c.name === "string") {
          lastToolUse = { name: c.name, input: c.input };
          lastSubstantiveType = "tool";
        }
      }
    } else if (type === "user") {
      // a tool_result comes back as a user entry; a real prompt does too.
      const hasToolResult = contentArray(e).some((c) => c.type === "tool_result");
      lastSubstantiveType = hasToolResult ? "tool" : "user";
    }
  }

  if (!sessionId) return null;

  // State: assistant finished the turn -> idle, unless it ended on a question.
  // Anything else (user just prompted, mid-tool) -> working.
  let state: AgentStatus["state"];
  let waitingReason: AgentStatus["waitingReason"];
  let doing: string;

  if (lastSubstantiveType === "assistant") {
    const asking = !!lastAssistantText && QUESTION.test(lastAssistantText);
    state = asking ? "waiting" : "idle";
    waitingReason = asking ? "question" : undefined;
    doing = asking ? "waiting on your answer" : "idle";
  } else {
    state = "working";
    doing = lastToolUse ? humanizeTool(lastToolUse.name, lastToolUse.input) : "thinking";
  }

  const { role, name } = identify(sessionId, branch, cwd);
  return {
    sessionId, name, role,
    ticket: parseTicket(branch), state, waitingReason,
    doing, cwd, branch, updatedAt,
  };
}

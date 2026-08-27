// Derive an AgentStatus from a Claude Code session transcript (.jsonl).
// Pure: given the transcript's tail lines, produce the status the dashboard shows.
// This is what surfaces an already-open session as a "person" without waiting
// for it to fire a hook. Keyed by the real sessionId so it never duplicates
// what hooks/status.ts writes for the same session.
import type { AgentStatus } from "../schema";
import { parseTicket } from "./ticket";
import { identify } from "./identity";
import { humanizeTool } from "./humanize";
import { findPendingQuestion } from "./conversation";

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
  let title: string | undefined;
  let lastToolUse: { name: string; input?: Record<string, unknown> } | null = null;
  // Did the session end its turn on assistant text (turn complete), or is it
  // still active (a user prompt or a tool in flight came last)?
  let endedOnAssistantText = false;
  // True when the newest content block is a thinking block — so the card shows
  // "thinking" instead of a leftover tool action from earlier in the turn.
  let thinkingLast = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }

    if (e.isSidechain === true || e.isMeta === true) continue; // subagents / meta noise
    if (typeof e.sessionId === "string") sessionId = e.sessionId;
    if (typeof e.cwd === "string") cwd = e.cwd;
    if (typeof e.gitBranch === "string") branch = e.gitBranch.length ? e.gitBranch : null;
    if (typeof e.aiTitle === "string" && e.aiTitle.trim()) title = e.aiTitle.trim();

    const type = e.type;
    if (type === "assistant") {
      for (const c of contentArray(e)) {
        if (c.type === "thinking") { thinkingLast = true; endedOnAssistantText = false; }
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          endedOnAssistantText = true;
          thinkingLast = false;
        }
        if (c.type === "tool_use" && typeof c.name === "string") {
          lastToolUse = { name: c.name, input: c.input };
          endedOnAssistantText = false; // a tool_use after text means the turn continued
          thinkingLast = false;
        }
      }
    } else if (type === "user") {
      // Both a real prompt and a tool_result arrive as user-type entries; either
      // way the assistant is now the one who should act next -> still active.
      endedOnAssistantText = false;
      thinkingLast = false;
    }
  }

  if (!sessionId) return null;

  // "Needs you / question" comes ONLY from a genuinely-pending AskUserQuestion —
  // the same reliable signal the conversation panel uses. A rhetorical or
  // mid-stream '?' in prose is NOT a question (that heuristic caused the card to
  // say NEEDS-YOU while the pane had nothing to answer). Otherwise: a completed
  // turn -> idle; anything mid-flight -> working.
  let state: AgentStatus["state"];
  let waitingReason: AgentStatus["waitingReason"];
  let doing: string;

  if (findPendingQuestion(lines) !== null) {
    state = "waiting";
    waitingReason = "question";
    doing = "waiting on your answer";
  } else if (endedOnAssistantText) {
    state = "idle";
    doing = "idle";
  } else {
    state = "working";
    doing = thinkingLast || !lastToolUse ? "thinking" : humanizeTool(lastToolUse.name, lastToolUse.input);
  }

  const { role, name } = identify(sessionId, branch, cwd);
  return {
    sessionId, name, role,
    ticket: parseTicket(branch), state, waitingReason,
    doing, cwd, branch, updatedAt, title,
  };
}

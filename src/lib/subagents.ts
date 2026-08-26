// A Claude session can spawn subagents (Task tool). Their transcripts live at
// <project>/<sessionId>/subagents/agent-<id>.jsonl with a .meta.json sidecar
// ({agentType, description, model}). This derives a compact view of one subagent.
import { humanizeTool } from "./humanize";

export type SubagentMeta = { agentType?: string; description?: string; model?: string };
export type Subagent = {
  agentId: string;
  description: string;
  agentType: string;
  model?: string;
  doing: string;
  active: boolean;   // writing to its transcript in the last ~90s
  updatedAt: number; // transcript mtime (ms)
};

type Content = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };

function contentArray(entry: Record<string, unknown>): Content[] {
  const msg = entry.message as Record<string, unknown> | undefined;
  const c = msg?.content;
  return Array.isArray(c) ? (c as Content[]) : [];
}

const ACTIVE_MS = 90_000;

/** Derive a subagent's current activity from its transcript tail. Unlike the main
 *  transcript parser, this does NOT skip isSidechain entries — a subagent's whole
 *  transcript is sidechain. */
export function deriveSubagent(agentId: string, meta: SubagentMeta, lines: string[], mtimeMs: number, now: number): Subagent {
  let lastTool: { name: string; input?: Record<string, unknown> } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant") continue;
    for (const c of contentArray(e)) {
      if (c.type === "tool_use" && typeof c.name === "string") lastTool = { name: c.name, input: c.input };
    }
  }
  const active = now - mtimeMs < ACTIVE_MS;
  const doing = lastTool ? humanizeTool(lastTool.name, lastTool.input) : active ? "thinking" : "done";
  return {
    agentId,
    description: meta.description?.trim() || "subagent",
    agentType: meta.agentType || "claude",
    model: meta.model,
    doing,
    active,
    updatedAt: mtimeMs,
  };
}

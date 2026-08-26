// Parse a Claude Code session transcript (.jsonl) into a readable chat log:
// user prompts, assistant replies, and compact tool-activity lines. Pure.
import { humanizeTool } from "./humanize";

export type ChatMessage = { role: "user" | "assistant" | "tool"; text: string };

type Content = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };

function contentArray(entry: Record<string, unknown>): Content[] {
  const msg = entry.message as Record<string, unknown> | undefined;
  const c = msg?.content;
  if (Array.isArray(c)) return c as Content[];
  if (typeof c === "string") return [{ type: "text", text: c }]; // user prompts can be a bare string
  return [];
}

function clip(s: string, max = 4000): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** Reduce transcript lines into an ordered chat log, keeping the last `max` messages. */
export function parseConversation(lines: string[], max = 200): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain === true || e.isMeta === true) continue;

    if (e.type === "user") {
      const parts = contentArray(e);
      // a tool_result comes back as a user entry — don't render it as a user prompt
      if (parts.some((c) => c.type === "tool_result")) continue;
      const text = parts.filter((c) => c.type === "text" || c.text).map((c) => c.text ?? "").join("").trim();
      if (text) out.push({ role: "user", text: clip(text) });
    } else if (e.type === "assistant") {
      for (const c of contentArray(e)) {
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          out.push({ role: "assistant", text: clip(c.text) });
        } else if (c.type === "tool_use" && typeof c.name === "string") {
          out.push({ role: "tool", text: humanizeTool(c.name, c.input) });
        }
      }
    }
  }
  return out.length > max ? out.slice(out.length - max) : out;
}

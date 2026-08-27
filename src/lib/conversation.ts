// Parse a Claude Code session transcript (.jsonl) into a readable chat log:
// user prompts, assistant replies, and compact tool-activity lines. Pure.
import { humanizeTool } from "./humanize";

export type ChatMessage = { role: "user" | "assistant" | "tool"; text: string };

export type QuestionOption = { label: string; description?: string };
export type Question = { header?: string; question: string; multiSelect: boolean; options: QuestionOption[] };
export type PendingQuestion = { questions: Question[] };

export type BlockingTool = { name: string; summary: string };

type ToolUse = { id: string; name: string; input?: Record<string, unknown> };

/** One pass over the transcript: every tool_use, and the ids that came back.
 *  Sidechain (subagent) and meta entries are skipped — they are not this
 *  session's blocking state. */
function walkTools(lines: string[]): { resolved: Set<string>; uses: ToolUse[] } {
  const resolved = new Set<string>();
  const uses: ToolUse[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain === true || e.isMeta === true) continue;
    for (const c of contentArray(e)) {
      if (c.type === "tool_result" && typeof (c as { tool_use_id?: string }).tool_use_id === "string") {
        resolved.add((c as { tool_use_id: string }).tool_use_id);
      }
      if (c.type === "tool_use" && typeof c.name === "string" && typeof (c as { id?: string }).id === "string") {
        uses.push({ id: (c as { id: string }).id, name: c.name, input: c.input });
      }
    }
  }
  return { resolved, uses };
}

/**
 * Find an AskUserQuestion the session is still waiting on — a tool_use with that
 * name whose tool_use_id has no matching tool_result yet. Lets the dashboard show
 * the options and answer them, instead of forcing the user to the terminal.
 */
export function findPendingQuestion(lines: string[]): PendingQuestion | null {
  const { resolved, uses } = walkTools(lines);
  let last: ToolUse | null = null;
  for (const u of uses) {
    if (u.name !== "AskUserQuestion") continue;
    const qs = (u.input as { questions?: Question[] } | undefined)?.questions;
    if (Array.isArray(qs) && qs.length) last = u;
  }
  if (!last || resolved.has(last.id)) return null;
  const questions = (last.input as { questions: Question[] }).questions;
  return {
    questions: questions.map((q) => ({
      header: q.header, question: q.question, multiSelect: !!q.multiSelect,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    })),
  };
}

/**
 * The newest tool_use with no tool_result yet — i.e. what the session is sitting
 * on right now. This is how the pane can always name what blocks an agent
 * (a permission prompt, a plan approval, anything future) rather than rendering
 * an empty panel for everything that isn't an AskUserQuestion.
 */
export function findBlockingTool(lines: string[]): BlockingTool | null {
  const { resolved, uses } = walkTools(lines);
  for (let i = uses.length - 1; i >= 0; i--) {
    const u = uses[i];
    if (resolved.has(u.id)) continue;
    return { name: u.name, summary: humanizeTool(u.name, u.input) };
  }
  return null;
}

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

/**
 * Some `type: "user"` entries aren't real prompts — the harness injects slash
 * commands, their output, and background-task notifications as user messages with
 * no isMeta flag. Render those as a compact activity line, or drop them, instead
 * of showing raw XML in a "YOU" bubble. Returns a replacement message, `null` to
 * drop, or `undefined` when the text is a genuine user prompt.
 */
function systemActivity(text: string): ChatMessage | null | undefined {
  const t = text.trim();
  // A slash command invocation: <command-name>/clear</command-name> (+ message/args).
  const cmd = t.match(/^<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const name = cmd[1].trim();
    return name ? { role: "tool", text: name } : null;
  }
  // Output echoed back from a slash/local command — noise in the chat view.
  if (t.startsWith("<local-command-stdout>")) return null;
  // A background task finished or was stopped while the user was away.
  if (t.startsWith("<task-notification>")) {
    const status = t.match(/<status>([^<]*)<\/status>/)?.[1]?.trim();
    const summary = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    return { role: "tool", text: summary || (status ? `background task ${status}` : "background task update") };
  }
  return undefined;
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
      if (!text) continue;
      const sys = systemActivity(text);
      if (sys === null) continue;              // harness noise — drop it
      out.push(sys ?? { role: "user", text: clip(text) });
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

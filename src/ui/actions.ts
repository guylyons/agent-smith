// Send a command to the server about a real session. Errors surface as toasts,
// never blocking dialogs. Confirmation/rename UX lives in the components.
import { toast } from "./toast";

type Result = { ok: boolean; error?: string };

async function post(action: string, body: object): Promise<Result> {
  try {
    const res = await fetch(`/action/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Result;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function act(action: string, body: object): Promise<boolean> {
  const r = await post(action, body);
  if (!r.ok) toast(r.error ?? `${action} failed`);
  return r.ok;
}

export function focusSession(sessionId: string): void {
  void act("focus", { sessionId });
}

export function pauseSession(sessionId: string): void {
  void act("pause", { sessionId });
}

export function killAgent(sessionId: string): void {
  void act("kill", { sessionId });
}

export function renameSession(sessionId: string, name: string): void {
  void act("rename", { sessionId, name });
}

export function setSprite(sessionId: string, palette: number, gear: string, body: string): void {
  void act("sprite", { sessionId, palette, gear, body });
}

/** Designate where a crate sits on THE LINE. "review"/"merged" pin it there;
 *  "done" (or any live stage) clears your designation. Persisted server-side so
 *  agents can read it. */
export function setLineStage(key: string, stage: "done" | "review" | "merged", label?: string, sessionId?: string): void {
  void act("line-stage", { key, stage, label, sessionId });
}

export function sendPromptTo(sessionId: string, text: string): Promise<boolean> {
  return act("prompt", { sessionId, text });
}

/** Launch a new Claude agent in `cwd` with `task` as its opening prompt.
 *  `opts.model` and `opts.permissionMode` are forwarded to the server, which
 *  allowlist-checks them again before building the launch command. */
export async function spawnAgent(cwd: string, task: string, opts?: { model?: string; permissionMode?: string; worktree?: string }): Promise<boolean> {
  const r = await post("spawn", { cwd, text: task, model: opts?.model, permissionMode: opts?.permissionMode, worktree: opts?.worktree });
  if (!r.ok) toast(r.error ?? "could not launch");
  return r.ok;
}

export type ChatMessage = { role: "user" | "assistant" | "tool"; text: string };
export type QuestionOption = { label: string; description?: string };
export type Question = { header?: string; question: string; multiSelect: boolean; options: QuestionOption[] };
export type PendingQuestion = { questions: Question[] };
export type Conversation = { messages: ChatMessage[]; question: PendingQuestion | null };

export async function fetchConversation(sessionId: string): Promise<Conversation> {
  try {
    const res = await fetch(`/conversation?sessionId=${encodeURIComponent(sessionId)}`);
    const body = (await res.json()) as Partial<Conversation>;
    return { messages: body.messages ?? [], question: body.question ?? null };
  } catch {
    return { messages: [], question: null };
  }
}

export type Subagent = {
  agentId: string; description: string; agentType: string; model?: string;
  doing: string; active: boolean; updatedAt: number;
};

export async function fetchSubagents(sessionId: string): Promise<Subagent[]> {
  try {
    const res = await fetch(`/subagents?sessionId=${encodeURIComponent(sessionId)}`);
    const body = (await res.json()) as { subagents?: Subagent[] };
    return body.subagents ?? [];
  } catch {
    return [];
  }
}

export type RepoInfo = {
  cwd: string; branch: string;
  commits: { hash: string; subject: string }[];
  status: { code: string; file: string }[];
};

export async function fetchRepo(sessionId: string): Promise<RepoInfo | null> {
  try {
    const res = await fetch(`/repo?sessionId=${encodeURIComponent(sessionId)}`);
    const body = (await res.json()) as RepoInfo & { error?: string };
    if (body.error) return null;
    return body;
  } catch {
    return null;
  }
}

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

export function renameSession(sessionId: string, name: string): void {
  void act("rename", { sessionId, name });
}

export function sendPromptTo(sessionId: string, text: string): Promise<boolean> {
  return act("prompt", { sessionId, text });
}

/** Launch a new Claude agent in `cwd` with `task` as its opening prompt. */
export async function spawnAgent(cwd: string, task: string): Promise<boolean> {
  const r = await post("spawn", { cwd, text: task });
  if (!r.ok) toast(r.error ?? "could not launch");
  return r.ok;
}

export type ChatMessage = { role: "user" | "assistant" | "tool"; text: string };

export async function fetchConversation(sessionId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(`/conversation?sessionId=${encodeURIComponent(sessionId)}`);
    const body = (await res.json()) as { messages?: ChatMessage[] };
    return body.messages ?? [];
  } catch {
    return [];
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

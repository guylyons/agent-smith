// Send a command to the server about a real session. Errors surface as toasts,
// never blocking dialogs. Confirmation/rename UX lives in the components.
import { toast } from "./toast";

type Result = { ok: boolean; error?: string; path?: string };

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

/** Upload an image dropped/pasted into a chat. The server saves it to a temp
 *  file and returns the path, which the caller prepends to the prompt so the
 *  agent reads the image by path. Returns null (and toasts) on any failure. */
export async function uploadImage(file: File): Promise<string | null> {
  try {
    const buf = await file.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const r = await post("upload", { name: file.name || "image", type: file.type, dataBase64: btoa(bin) });
    if (!r.ok || !r.path) { toast(r.error ?? "upload failed"); return null; }
    return r.path;
  } catch (e) {
    toast(`upload failed: ${String(e)}`);
    return null;
  }
}

/** Launch a new Claude agent in `cwd` with `task` as its opening prompt.
 *  `opts.model` and `opts.permissionMode` are forwarded to the server, which
 *  allowlist-checks them again before building the launch command. */
export async function spawnAgent(cwd: string, task: string, opts?: { model?: string; permissionMode?: string; worktree?: string; persona?: string }): Promise<boolean> {
  const r = await post("spawn", { cwd, text: task, model: opts?.model, permissionMode: opts?.permissionMode, worktree: opts?.worktree, persona: opts?.persona });
  if (!r.ok) toast(r.error ?? "could not launch");
  return r.ok;
}

export type PersonaInfo = { id: string; name: string; role: string; skills: string[] };

/** The personas the server offers. Returns [] on any failure so a blip degrades
 *  to "no persona choice" rather than a broken modal. */
export async function fetchPersonas(): Promise<PersonaInfo[]> {
  try {
    const res = await fetch("/personas");
    if (!res.ok) return [];
    return (await res.json()) as PersonaInfo[];
  } catch {
    return [];
  }
}

export type ChatMessage = { role: "user" | "assistant" | "tool"; text: string };
export type QuestionOption = { label: string; description?: string };
export type Question = { header?: string; question: string; multiSelect: boolean; options: QuestionOption[] };
export type PendingQuestion = { questions: Question[] };
export type BlockingTool = { name: string; summary: string };
export type Conversation = { messages: ChatMessage[]; question: PendingQuestion | null; blocked: BlockingTool | null };

// Returns null on any failure (network error, non-2xx, unparseable body) so a
// transient blip doesn't blank an open chat. Callers keep their prior state.
export async function fetchConversation(sessionId: string): Promise<Conversation | null> {
  try {
    const res = await fetch(`/conversation?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Conversation>;
    return { messages: body.messages ?? [], question: body.question ?? null, blocked: body.blocked ?? null };
  } catch {
    return null;
  }
}

export type Subagent = {
  agentId: string; description: string; agentType: string; model?: string;
  doing: string; active: boolean; updatedAt: number;
};

// null on failure (see fetchConversation) so a failed poll leaves the current
// subagent list in place rather than clearing it.
export async function fetchSubagents(sessionId: string): Promise<Subagent[] | null> {
  try {
    const res = await fetch(`/subagents?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { subagents?: Subagent[] };
    return body.subagents ?? [];
  } catch {
    return null;
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

// Send a command to the server about a real session. Errors surface as toasts,
// never blocking dialogs. Confirmation/rename UX lives in the components.
import { toast } from "./toast";
import { flashSend } from "./flash";
import { playSubmit } from "./sounds";
import type { Board } from "../lib/board";
// Shared with the UI as types only — nothing server-side is bundled into the browser.
import type { ChatMessage, QuestionOption, Question, PendingQuestion, BlockingTool } from "../lib/conversation";
import type { Subagent } from "../lib/subagents";
import type { RepoInfo } from "../repo";

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

/** Bring the session's terminal window to the front. Returns whether it
 *  succeeded so callers can give feedback (a failed focus — no Ghostty, session
 *  gone — otherwise looks like nothing happened). */
export function focusSession(sessionId: string): Promise<boolean> {
  return act("focus", { sessionId });
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

/** Persist the whole kanban board (THE LINE). The client owns board edits and
 *  sends the full board; the server sanitizes and stores it to `.line.json`, which
 *  any Claude session can read. */
export function updateBoard(board: Board): void {
  void act("board", { board });
}

/** Send a card's task (with the board protocol footer) to its assigned live
 *  agent. Composed and delivered server-side — one code path whether the send
 *  comes from this UI or from an orchestrating agent — and the server drops the
 *  "Sent task to …" trace comment itself. */
export function sendCardTask(cardId: string, assigneeSessionId: string): Promise<boolean> {
  playSubmit();
  flashSend(assigneeSessionId);
  return act("send-task", { cardId });
}

export function sendPromptTo(sessionId: string, text: string): Promise<boolean> {
  // Immediate feedback for the user's send (a direct gesture, so it's always on
  // — not gated by the alerts toggle): a submit blip plus a green pulse on the
  // agent's grid card.
  playSubmit();
  flashSend(sessionId);
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
export async function spawnAgent(cwd: string, task: string, opts?: { model?: string; permissionMode?: string; worktree?: string; persona?: string; cardId?: string }): Promise<boolean> {
  playSubmit();
  const r = await post("spawn", { cwd, text: task, model: opts?.model, permissionMode: opts?.permissionMode, worktree: opts?.worktree, persona: opts?.persona, cardId: opts?.cardId });
  if (!r.ok) toast(r.error ?? "could not launch");
  return r.ok;
}

export type PersonaInfo = { id: string; name: string; role: string; skills: string[] };

// Re-exported (imported at the top) so components keep importing them from "./actions".
export type { ChatMessage, QuestionOption, Question, PendingQuestion, BlockingTool, Subagent, RepoInfo };
export type Conversation = { messages: ChatMessage[]; question: PendingQuestion | null; blocked: BlockingTool | null };

// GET a JSON endpoint, returning null on any failure (network error, non-2xx, or
// unparseable body) so a transient blip leaves the caller's current state intact
// rather than blanking it. A non-2xx (e.g. /repo's 404) reads as null too.
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** The personas the server offers. [] on any failure so a blip degrades to "no
 *  persona choice" rather than a broken modal. */
export async function fetchPersonas(): Promise<PersonaInfo[]> {
  return (await getJson<PersonaInfo[]>("/personas")) ?? [];
}

export async function fetchConversation(sessionId: string): Promise<Conversation | null> {
  const body = await getJson<Partial<Conversation>>(`/conversation?sessionId=${encodeURIComponent(sessionId)}`);
  if (!body) return null;
  return { messages: body.messages ?? [], question: body.question ?? null, blocked: body.blocked ?? null };
}

export async function fetchSubagents(sessionId: string): Promise<Subagent[] | null> {
  const body = await getJson<{ subagents?: Subagent[] }>(`/subagents?sessionId=${encodeURIComponent(sessionId)}`);
  return body ? body.subagents ?? [] : null;
}

export async function fetchRepo(sessionId: string): Promise<RepoInfo | null> {
  return getJson<RepoInfo>(`/repo?sessionId=${encodeURIComponent(sessionId)}`);
}

export type ChatHit = { sessionId: string; name: string; role: string; snippet: string; hitRole: ChatMessage["role"] };

/** Quick-find's chat half: transcript snippets from live sessions mentioning the
 *  query. [] on a blank query or any failure — the palette's card/agent results
 *  still stand without it. */
export async function fetchChatSearch(q: string): Promise<ChatHit[]> {
  if (!q.trim()) return [];
  const body = await getJson<{ chats?: ChatHit[] }>(`/search?q=${encodeURIComponent(q)}`);
  return body?.chats ?? [];
}

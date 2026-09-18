// Send a command to the server about a real session. Errors surface as toasts,
// never blocking dialogs. Confirmation/rename UX lives in the components.
import { toastError } from "./toast";
import { flashSend } from "./flash";
import { signalDying } from "./dying";
import { playSubmit } from "./sounds";
import type { Board, Card, Column, Stage } from "../lib/board";
// Shared with the UI as types only — nothing server-side is bundled into the browser.
import type { ChatMessage, QuestionOption, Question, PendingQuestion, BlockingTool } from "../lib/conversation";
import type { Subagent } from "../lib/subagents";
import type { RepoInfo } from "../repo";
import type { MergeState, MergeResult } from "../lib/merge";

/** Where a card event went: typed into an idle agent's terminal now, or queued
 *  for a busy one's Stop hook to collect when its turn ends. */
export type Delivery = { sessionId: string; name: string; via: "typed" | "queued" };

type Result = { ok: boolean; error?: string; path?: string; url?: string; cancelled?: boolean; branch?: string; base?: string; delivery?: Delivery[] };

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
  if (!r.ok) toastError(r.error ?? `${action} failed`);
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
  // Announce it before the POST, not after: the death animation is the feedback
  // that the click landed, and the kill itself takes a beat to reach Ghostty.
  signalDying(sessionId);
  void act("kill", { sessionId });
}

export function renameSession(sessionId: string, name: string): void {
  void act("rename", { sessionId, name });
}

export function setSprite(sessionId: string, palette: number, gear: string, body: string): void {
  void act("sprite", { sessionId, palette, gear, body });
}

// ---- THE LINE: one scoped call per edit ------------------------------------
// The UI used to POST the ENTIRE board on every keystroke-commit and drag. That
// write overwrites `.line.json` wholesale, so anything an agent posted between
// the browser's last snapshot and its next edit — a comment, a move, a new card
// — was silently erased. Each function below names the one thing it changes;
// the server applies it against a fresh read, so concurrent writers compose
// instead of clobbering. Nothing here sends a whole board.

export function addColumnAction(name: string): void { void act("column-add", { name }); }
export function renameColumnAction(columnId: string, name: string): void { void act("column-update", { columnId, name }); }
export function setInstructionAction(columnId: string, instruction: string): void { void act("column-update", { columnId, instruction }); }
export function setColumnStageAction(columnId: string, stage: Stage | null): void { void act("column-update", { columnId, stage }); }
export function deleteColumnAction(columnId: string): void { void act("column-delete", { columnId }); }
export function reorderColumnAction(columnId: string, toIndex: number): void { void act("column-reorder", { columnId, toIndex }); }
export function restoreColumnAction(column: Column, index: number, cards: Card[]): void {
  void act("column-restore", { column, index, cards });
}

export function addCardAction(columnId: string, title: string): void { void act("card-add", { columnId, title }); }
export function renameCardAction(cardId: string, title: string): void { void act("card-update", { cardId, title }); }
export function setCardDescriptionAction(cardId: string, description: string): void { void act("card-update", { cardId, description }); }
/** Replace the card's file claim — the paths/globs it is expected to change.
 *  An empty list clears it. */
export function setCardTouchesAction(cardId: string, touches: string[]): void { void act("card-update", { cardId, touches }); }
/** Label the card with its repo by hand; a blank name clears it. */
export function setCardRepoAction(cardId: string, repo: string): void { void act("card-update", { cardId, repo }); }
export function moveCardAction(cardId: string, toColumnId: string, toIndex?: number): void {
  void act("card-move", { cardId, toColumnId, author: ME, ...(toIndex === undefined ? {} : { toIndex }) });
}
export function deleteCardAction(cardId: string): void { void act("card-delete", { cardId }); }
export function restoreCardAction(card: Card, index: number): void { void act("card-restore", { card, index }); }
export function assignCardAction(cardId: string, sessionId: string | null): void { void act("card-assign", { cardId, sessionId }); }
/** Post a comment as the human. The server delivers it to the card's assignee
 *  (and any scrum master) itself; the returned delivery says how each got it,
 *  so the modal can toast "Notified" vs "Queued" truthfully. */
export async function addCommentAction(cardId: string, text: string): Promise<Delivery[]> {
  const r = await post("card-comment", { cardId, author: ME, text });
  if (!r.ok) { toastError(r.error ?? "card-comment failed"); return []; }
  return r.delivery ?? [];
}
export function deleteCommentAction(cardId: string, commentId: string): void { void act("comment-delete", { cardId, commentId }); }

/** The human's byline on comments and moves they make. Agents append with their
 *  own persona name, so a thread reads clearly as a human<->agent exchange. */
export const ME = "You";

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

/** A saved upload: `path` is the absolute file an agent can read, `url` is the
 *  dashboard route the browser renders it from. */
export type Upload = { path: string; url: string };

/** Upload an image dropped/pasted into a chat or onto a ticket. The server saves
 *  it to a temp file and returns both its path (prepended to a prompt so the
 *  agent reads the image by path) and its URL (so the browser can show it).
 *  Returns null (and toasts) on any failure. */
export async function uploadImage(file: File): Promise<Upload | null> {
  try {
    const buf = await file.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const r = await post("upload", { name: file.name || "image", type: file.type, dataBase64: btoa(bin) });
    if (!r.ok || !r.path || !r.url) { toastError(r.error ?? "upload failed"); return null; }
    return { path: r.path, url: r.url };
  } catch (e) {
    toastError(`upload failed: ${String(e)}`);
    return null;
  }
}

/** Launch a new Claude agent in `cwd` with `task` as its opening prompt.
 *  `opts.model` and `opts.permissionMode` are forwarded to the server, which
 *  allowlist-checks them again before building the launch command. */
export async function spawnAgent(cwd: string, task: string, opts?: { model?: string; permissionMode?: string; worktree?: string; branch?: string; persona?: string; cardId?: string }): Promise<boolean> {
  playSubmit();
  const r = await post("spawn", { cwd, text: task, model: opts?.model, permissionMode: opts?.permissionMode, worktree: opts?.worktree, branch: opts?.branch, persona: opts?.persona, cardId: opts?.cardId });
  if (!r.ok) toastError(r.error ?? "could not launch");
  return r.ok;
}

/** Ask the server to open the real macOS folder chooser, starting in `startIn`.
 *  Returns the chosen absolute path, or null when the user cancelled (silent —
 *  backing out of a dialog is not an error) or the picker couldn't open (which
 *  does toast, so a broken picker doesn't look like a dead button). */
export async function pickFolder(startIn?: string): Promise<string | null> {
  const r = await post("pick-folder", { cwd: startIn });
  if (r.ok && r.path) return r.path;
  if (!r.cancelled) toastError(r.error ?? "could not open the folder picker");
  return null;
}

export type PersonaInfo = { id: string; name?: string; role: string; skills: string[] };

// Re-exported (imported at the top) so components keep importing them from "./actions".
export type { ChatMessage, QuestionOption, Question, PendingQuestion, BlockingTool, Subagent, RepoInfo, MergeState, MergeResult };
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

/** Whether a card's work is committed and can be landed on the trunk. null on
 *  any failure (no assignee, no status file, a blip) — the key simply doesn't
 *  appear, which is the same as "nothing to merge yet". */
export async function fetchMergeState(cardId: string): Promise<MergeState | null> {
  return getJson<MergeState>(`/merge-state?cardId=${encodeURIComponent(cardId)}`);
}

/** Land this card's branch on the trunk. Real `git merge --no-ff`, run in the
 *  main checkout; the server refuses (and reports) anything it can't do
 *  cleanly, so a failure is never a half-finished merge. No toast here: the
 *  MERGE key words a refusal itself, since one caused by the branch moving
 *  since the key lit up reads differently from a conflict (src/lib/mergeRace.ts). */
export async function mergeCard(cardId: string): Promise<MergeResult> {
  return (await post("card-merge", { cardId, author: ME })) as MergeResult;
}

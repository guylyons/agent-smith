// THE LINE's kanban board — a simple, fully user-editable board of columns and
// cards. Everything is renamable, draggable, and each column carries an
// `instruction` describing what to do with work that sits in it (e.g. "once
// done, ensure the worktree is clean and committed, share a report in the
// ticket"). Persisted to `.line.json` next to the status files so a designation
// survives restarts AND is readable by any Claude session — that's how an agent
// becomes aware of the board and what each stage expects.
//
// All mutations here are PURE (Board -> Board, never mutating the input); the UI
// and the server share them, and they're unit-tested without a browser.
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

/** A single comment on a card. `author` is a free label ("You" for the human;
 *  an agent appends with its own persona name). `at` is a Unix ms timestamp. */
export type Comment = { id: string; author: string; text: string; at: number };
/** A card's assignee — a live agent session from the grid: its `id` is that
 *  session's id, plus a display name so the label survives after the session
 *  ends. Never a persona: a persona isn't a running session, so it could never
 *  be sent the card's task. */
export type Assignee = { id: string; name: string };
export type Card = {
  id: string;
  title: string;
  columnId: string;
  // Optional detail (added in VERSION 3). Absent on cards that have none, so the
  // on-disk format stays minimal and older boards keep working untouched.
  description?: string;
  assignee?: Assignee | null;
  comments?: Comment[];
};
export type Column = { id: string; name: string; instruction: string };
export type Board = { columns: Column[]; cards: Card[] };

const VERSION = 3;

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** A sensible starting board. The Done column ships with an example instruction
 *  so the on-disk format is self-documenting to an agent reading it. */
export function defaultBoard(): Board {
  return {
    columns: [
      { id: "backlog", name: "Backlog", instruction: "" },
      { id: "in-progress", name: "In Progress", instruction: "" },
      { id: "review", name: "Review", instruction: "" },
      {
        id: "done",
        name: "Done",
        instruction:
          "Once done, ensure the worktree is clean and committed, then share a report in the ticket.",
      },
    ],
    cards: [],
  };
}

// ---- pure mutations -------------------------------------------------------

export function addColumn(board: Board, name: string): Board {
  const col: Column = { id: genId("col"), name, instruction: "" };
  return { ...board, columns: [...board.columns, col] };
}

export function renameColumn(board: Board, id: string, name: string): Board {
  return { ...board, columns: board.columns.map((c) => (c.id === id ? { ...c, name } : c)) };
}

export function setInstruction(board: Board, id: string, instruction: string): Board {
  return { ...board, columns: board.columns.map((c) => (c.id === id ? { ...c, instruction } : c)) };
}

export function deleteColumn(board: Board, id: string): Board {
  return {
    columns: board.columns.filter((c) => c.id !== id),
    cards: board.cards.filter((k) => k.columnId !== id),
  };
}

export function reorderColumn(board: Board, id: string, toIndex: number): Board {
  const from = board.columns.findIndex((c) => c.id === id);
  if (from === -1) return board;
  const columns = [...board.columns];
  const [col] = columns.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, columns.length));
  columns.splice(clamped, 0, col!);
  return { ...board, columns };
}

export function addCard(board: Board, columnId: string, title: string): Board {
  if (!board.columns.some((c) => c.id === columnId)) return board;
  const card: Card = { id: genId("card"), title, columnId };
  return { ...board, cards: [...board.cards, card] };
}

export function renameCard(board: Board, id: string, title: string): Board {
  return { ...board, cards: board.cards.map((k) => (k.id === id ? { ...k, title } : k)) };
}

export function deleteCard(board: Board, id: string): Board {
  return { ...board, cards: board.cards.filter((k) => k.id !== id) };
}

/** Map a single card by id to a new card. Shared by the detail mutations. */
function mapCard(board: Board, id: string, fn: (card: Card) => Card): Board {
  return { ...board, cards: board.cards.map((k) => (k.id === id ? fn(k) : k)) };
}

export function setCardDescription(board: Board, id: string, description: string): Board {
  return mapCard(board, id, (k) => ({ ...k, description }));
}

/** Assign the card to a live agent session, or clear it with `null`. */
export function assignCard(board: Board, id: string, assignee: Assignee | null): Board {
  return mapCard(board, id, (k) => ({ ...k, assignee }));
}

/** Append a comment authored by `author`. No-op on empty/whitespace text so a
 *  stray Enter can't post a blank note. */
export function addComment(board: Board, id: string, author: string, text: string): Board {
  const body = text.trim();
  if (!body) return board;
  const comment: Comment = { id: genId("cmt"), author, text: body, at: Date.now() };
  return mapCard(board, id, (k) => ({ ...k, comments: [...(k.comments ?? []), comment] }));
}

export function deleteComment(board: Board, id: string, commentId: string): Board {
  return mapCard(board, id, (k) => ({
    ...k,
    comments: (k.comments ?? []).filter((m) => m.id !== commentId),
  }));
}

/** The task text handed to an agent when a card is assigned/sent: the card
 *  title, then its description, then its column's instruction — each on its own
 *  block, empties skipped. So a card in a column instructed "start a worktree,
 *  TDD" arrives as one combined task. Empty string for an unknown card. */
export function cardTaskText(board: Board, id: string): string {
  const card = board.cards.find((k) => k.id === id);
  if (!card) return "";
  const instr = board.columns.find((c) => c.id === card.columnId)?.instruction ?? "";
  return [card.title, card.description ?? "", instr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The full prompt handed to an assigned agent: the card's task text, then a
 *  protocol footer telling it which card it is on, where the board lives, and
 *  how to drive its own ticket — move to the next column, comment as it goes.
 *  `agentName` is the codename the board shows it under, so its comments are
 *  attributable to the right desk; omitted when spawning (no session yet).
 *  Without this an agent receives a task with no idea it came from a card, so
 *  it can never move itself into In Progress or report back in the thread.
 *  Empty string for an unknown card (nothing to send). */
export function cardTaskPrompt(board: Board, id: string, boardPath: string, agentName?: string): string {
  const card = board.cards.find((k) => k.id === id);
  if (!card) return "";
  const flow = board.columns.map((c) => c.id).join(" → ");
  const here = board.columns.find((c) => c.id === card.columnId);
  // Columns are user-editable, so "where next" is positional: the column after
  // this one is where the work happens, the one after that is where it lands.
  const at = board.columns.findIndex((c) => c.id === card.columnId);
  const start = board.columns[at + 1] ?? here;
  const finish = board.columns[at + 2] ?? start;
  // The board shows the agent under its own codename, so comments should carry
  // that name to line up with the desk. Only SEND TASK knows it — a card being
  // spawned for has no session yet, so that case falls back to the agent's own.
  const who = agentName ? `, ${agentName}` : "";
  const author = agentName ? `"${agentName}"` : '"<your agent name>"';

  const footer = [
    "— THE LINE —",
    `card: ${card.id}`,
    `board: ${boardPath}`,
    `columns: ${flow}   (you are in: "${here?.id ?? card.columnId}")`,
    "",
    `You are the assigned agent on this card${who}. The board is how your progress`,
    "is watched, so it has to be updated as you go — not in one write at the end.",
    "",
    `STEP 1, before any other work: open the board file, set this card's columnId`,
    `to "${start?.id ?? card.columnId}", and append a comment saying you've picked it up. Do this`,
    "first, as its own write, so the card is seen moving while you work on it.",
    "STEP 2: do the work, appending a comment whenever you find or decide",
    "something worth knowing.",
    `STEP 3, when the work is done: append a final comment, then set columnId to`,
    `"${finish?.id ?? card.columnId}". Each column's own instruction says what that stage expects.`,
    "",
    "Read the board file before you edit it, then edit it by read-modify-write of",
    `the JSON: change only this card's "columnId", and append to its "comments"`,
    `array entries shaped { "id": "cmt_<8 hex>", "author": ${author}, "text": "…",`,
    '"at": <unix ms> }. Keep "version" and every other column and card as they are.',
  ].join("\n");

  return [cardTaskText(board, id), footer].filter(Boolean).join("\n\n");
}

/** Move a card into `toColumnId`. Without `toIndex` it appends; with one it
 *  inserts at that position among the target column's cards. No-op if the card
 *  or the target column is unknown. */
export function moveCard(board: Board, id: string, toColumnId: string, toIndex?: number): Board {
  const card = board.cards.find((k) => k.id === id);
  if (!card || !board.columns.some((c) => c.id === toColumnId)) return board;

  const rest = board.cards.filter((k) => k.id !== id);
  const moved: Card = { ...card, columnId: toColumnId };
  if (toIndex === undefined) return { ...board, cards: [...rest, moved] };

  // Insert relative to the target column's cards, preserving other columns' order.
  const out: Card[] = [];
  let placed = false;
  let seen = 0;
  for (const k of rest) {
    if (k.columnId === toColumnId) {
      if (seen === toIndex) { out.push(moved); placed = true; }
      seen++;
    }
    out.push(k);
  }
  if (!placed) out.push(moved);
  return { ...board, cards: out };
}

// ---- validation & persistence --------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** A Claude Code session id — the only thing that can be an assignee. Persona
 *  ids (`backend-dev`, `frontend-ux`, …) deliberately fail this. */
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Repair an assignee: needs a name and an id that is a real session id, else
 *  the card is unassigned. Cards were once assigned to a persona; that legacy
 *  shape is dropped here rather than left on the card looking assignable, since
 *  a persona has no session to send the task to. */
function sanitizeAssignee(v: unknown): Assignee | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name);
  if (id === null || name === null || !SESSION_ID.test(id)) return null;
  return { id, name };
}

/** Repair a comment list, dropping any entry missing a valid id/author/text/at.
 *  The file is one an agent may hand-edit, so a bad comment is skipped rather
 *  than allowed to break the card. */
function sanitizeComments(v: unknown): Comment[] {
  if (!Array.isArray(v)) return [];
  const out: Comment[] = [];
  const ids = new Set<string>();
  for (const c of v) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const id = str(o.id);
    const author = str(o.author);
    const text = str(o.text);
    const at = typeof o.at === "number" ? o.at : null;
    if (id === null || author === null || text === null || at === null || ids.has(id)) continue;
    ids.add(id);
    out.push({ id, author, text, at });
  }
  return out;
}

/** Validate/repair arbitrary input into a Board. The file is documented as one
 *  any Claude session may write, so bad columns/cards are dropped here rather
 *  than crash consumers. Falls back to the default board when unusable. */
export function sanitizeBoard(input: unknown): Board {
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaultBoard();
  const raw = input as { columns?: unknown; cards?: unknown };

  const columns: Column[] = [];
  const colIds = new Set<string>();
  if (Array.isArray(raw.columns)) {
    for (const c of raw.columns) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const id = str(o.id);
      const name = str(o.name);
      if (id === null || name === null || colIds.has(id)) continue;
      colIds.add(id);
      columns.push({ id, name, instruction: str(o.instruction) ?? "" });
    }
  }
  if (columns.length === 0) return defaultBoard();

  const cards: Card[] = [];
  const cardIds = new Set<string>();
  if (Array.isArray(raw.cards)) {
    for (const k of raw.cards) {
      if (!k || typeof k !== "object") continue;
      const o = k as Record<string, unknown>;
      const id = str(o.id);
      const title = str(o.title);
      const columnId = str(o.columnId);
      if (id === null || title === null || columnId === null) continue;
      if (cardIds.has(id) || !colIds.has(columnId)) continue;
      cardIds.add(id);

      // Optional detail — included only when present, so a bare card stays bare.
      const card: Card = { id, title, columnId };
      const description = str(o.description);
      if (description !== null) card.description = description;
      const assignee = sanitizeAssignee(o.assignee);
      if (assignee) card.assignee = assignee;
      const comments = sanitizeComments(o.comments);
      if (comments.length) card.comments = comments;
      cards.push(card);
    }
  }

  return { columns, cards };
}

/** Where the board lives inside a status dir. Exported so the server can tell
 *  the browser (and, through it, an assigned agent) the real path. */
export function boardFile(dir: string): string {
  return join(dir, ".line.json");
}

export function readBoard(dir: string): Board {
  try {
    return sanitizeBoard(JSON.parse(readFileSync(boardFile(dir), "utf8")));
  } catch {
    return defaultBoard(); // missing or corrupt
  }
}

export function writeBoard(dir: string, board: Board): void {
  const clean = sanitizeBoard(board);
  const tmp = boardFile(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: VERSION, ...clean }));
  renameSync(tmp, boardFile(dir));
}

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
 *  ends, plus the session's crew id when it has one (see src/lib/crew.ts): a
 *  /clear mints a new session id, and the crew id is how the card follows the
 *  same agent into it. Never a persona: a persona isn't a running session, so
 *  it could never be sent the card's task. */
export type Assignee = { id: string; name: string; crew?: string };
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
/** What a column MEANS to the protocol, independent of where it sits. `todo`
 *  is where new cards wait, `doing` is where an agent works, `review` is where
 *  finished work lands for a human, `done` is finished. A column with no stage
 *  (a user's "Merged", "Archived") is just a place cards can be put. */
export type Stage = "todo" | "doing" | "review" | "done";
export const STAGES: readonly Stage[] = ["todo", "doing", "review", "done"];
export type Column = { id: string; name: string; instruction: string; stage?: Stage };
export type Board = { columns: Column[]; cards: Card[] };

// The stock Done column's id. Kept for the default board; anything deciding
// whether a column is "done" should ask isDoneColumn, which keys off the stage.
export const DONE_COLUMN_ID = "done";

/** The stage a stock column id implies, for boards written before stages
 *  existed. Only the four ids defaultBoard mints are recognised. */
const LEGACY_STAGE: Record<string, Stage> = { backlog: "todo", "in-progress": "doing", review: "review", done: "done" };

const VERSION = 3;

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** A sensible starting board. The Done column ships with an example instruction
 *  so the on-disk format is self-documenting to an agent reading it. */
export function defaultBoard(): Board {
  return {
    columns: [
      { id: "backlog", name: "Backlog", instruction: "", stage: "todo" },
      { id: "in-progress", name: "In Progress", instruction: "", stage: "doing" },
      { id: "review", name: "Review", instruction: "", stage: "review" },
      {
        id: DONE_COLUMN_ID,
        name: "Done",
        instruction:
          "Once done, ensure the worktree is clean and committed, then share a report in the ticket.",
        stage: "done",
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

/** Set what a column means to the protocol, or clear it with `null`. */
export function setColumnStage(board: Board, id: string, stage: Stage | null): Board {
  return {
    ...board,
    columns: board.columns.map((c) => {
      if (c.id !== id) return c;
      const { stage: _old, ...rest } = c;
      return stage ? { ...rest, stage } : rest;
    }),
  };
}

/** A column's stage: explicit, or implied by a stock id (so a board built by
 *  hand from the four stock columns behaves like one that went through
 *  sanitizeColumn). */
export function columnStage(col: Column): Stage | undefined {
  return col.stage ?? LEGACY_STAGE[col.id];
}

/** The first column carrying `stage`, if the board has one. */
export function stageColumn(board: Board, stage: Stage): Column | undefined {
  return board.columns.find((c) => columnStage(c) === stage);
}

/** Is a move INTO this column what finishes a task? */
export function isDoneColumn(board: Board, columnId: string): boolean {
  const col = board.columns.find((c) => c.id === columnId);
  return !!col && columnStage(col) === "done";
}

export function deleteColumn(board: Board, id: string): Board {
  return {
    columns: board.columns.filter((c) => c.id !== id),
    cards: board.cards.filter((k) => k.columnId !== id),
  };
}

/** Put a deleted column back at `index`, along with the cards that went down
 *  with it — the undo half of deleteColumn. No-op if that column id is already
 *  back. Cards keep their own ids and comments; any whose column is not this one
 *  is ignored. */
export function restoreColumn(board: Board, column: Column, index: number, cards: Card[]): Board {
  if (board.columns.some((c) => c.id === column.id)) return board;
  const columns = [...board.columns];
  columns.splice(Math.max(0, Math.min(index, columns.length)), 0, column);
  const mine = cards.filter((k) => k.columnId === column.id && !board.cards.some((x) => x.id === k.id));
  return { columns, cards: [...board.cards, ...mine] };
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

/** Put a deleted card back where it was — the undo half of deleteCard. Keeps
 *  the card's own identity (id, comments, assignee), so undoing a delete does
 *  not resurrect it as a fresh empty card. No-op if that id is already on the
 *  board (a double undo), and silently drops the card if its column has since
 *  been deleted — there is nowhere to put it. */
export function restoreCard(board: Board, card: Card, index: number): Board {
  if (board.cards.some((k) => k.id === card.id)) return board;
  if (!board.columns.some((c) => c.id === card.columnId)) return board;
  return { ...board, cards: insertInColumn(board.cards, card, index) };
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
 *  protocol footer telling it which card it is on and how to drive its own
 *  ticket over the dashboard's HTTP API — move to the next column, comment as
 *  it goes. `server` is the dashboard's base URL (the browser passes its own
 *  origin; the server passes its localhost address). `agentName` is the
 *  codename the board shows the agent under, so its comments line up with its
 *  desk; omitted when spawning (no session yet).
 *
 *  Two hard-won rules are baked in. The footer is PURE ASCII: text crosses the
 *  pty into the session through a path known to mangle non-ASCII, so no em
 *  dashes, arrows, or emoji. And updates go through card-scoped API calls, not
 *  by editing the board file: the server applies each against the latest board,
 *  so two agents (or an agent and the UI) can never clobber each other's write.
 *
 *  Empty string for an unknown card (nothing to send). */
export function cardTaskPrompt(board: Board, id: string, server: string, agentName?: string, opts: { workedBefore?: boolean } = {}): string {
  const card = board.cards.find((k) => k.id === id);
  if (!card) return "";
  const flow = board.columns.map((c) => c.id).join(" -> ");
  const here = board.columns.find((c) => c.id === card.columnId);
  const { work, land } = taskColumns(board, card);
  // The board shows the agent under its own codename; the identity line carries
  // it when known. Writes are signed `"as":"assignee"` regardless: the server
  // resolves that to the card's assignee at write time, so a renamed desk or a
  // persona whose name differs from its desk can never mis-sign a comment.
  const who = agentName ? `, ${agentName}` : "";
  const post = (path: string, json: string) =>
    `  curl -s -X POST ${server}${path} -H 'content-type: application/json' -d '${json}'`;
  const comment = (text: string) => post("/action/card-comment", `{"cardId":"${card.id}","as":"assignee","text":"${text}"}`);

  // STEP 1 is a move only when the card isn't already where work happens — a
  // task re-sent to a card in progress must not push it forward before starting.
  const step1 = work.id === card.columnId
    ? [
        `STEP 1, before any other work: this card is already in "${work.id}", so leave it`,
        "there and say you picked it up (or resumed it):",
        comment("Picked this up. <one line on your plan>"),
      ]
    : [
        `STEP 1, before any other work, move this card to "${work.id}" and say you`,
        "picked it up:",
        post("/action/card-move", `{"cardId":"${card.id}","as":"assignee","toColumnId":"${work.id}"}`),
        comment("Picked this up. <one line on your plan>"),
      ];

  const footer = [
    "-- THE LINE --",
    `card: ${card.id}`,
    `columns: ${flow}   (you are in: "${here?.id ?? card.columnId}")`,
    "",
    `You are the assigned agent on this card${who}. This task replaces anything`,
    "you were told before it. The board is how your progress is watched, so",
    ...(opts.workedBefore ? [
      "You have worked this card before and your earlier comments are on it:",
      "read them first (curl the board, below) and carry on from where you left off.",
    ] : []),
    "update it as you go, not in one write at the end. Update it ONLY with the",
    "curl commands below; never edit the board file directly.",
    "If you have the-line MCP tools (mcp__the-line__card_move, card_comment,",
    "board_read, ...), use those instead -- same board, same effect, no curl.",
    "",
    ...step1,
    "STEP 2: do the work. Whenever you find or decide something worth knowing,",
    "post it as a card-comment (same shape as above). Keep comments plain and",
    "short -- write like a quick note to a busy teammate, no jargon or filler,",
    "unless this card asks for more detail.",
    "STEP 3, when the work is done: post a final card-comment saying what you did",
    `and how you verified it, then move the card to "${land.id}" (card-move with`,
    `{"toColumnId":"${land.id}"}). Each column's instruction says what that stage`,
    "expects of work landing in it.",
    "",
    'A message starting with "[THE LINE]" is a board notification. One that says',
    "a reply is expected: answer it on the card with a card-comment. One marked",
    "no reply needed: read it and carry on; comment only if it changes your work.",
    "",
    "Scope: work ONLY this card. Never touch other cards or columns, and follow",
    "this card's constraints exactly (if it says do not commit, do not commit).",
    `To re-read your card, its comments, and every column's instruction:`,
    `  curl -s ${server}/board`,
    "If any text above looks garbled (encoding damage in transit), treat the",
    "server's copy from /board as canonical.",
  ].join("\n");

  return [cardTaskText(board, id), footer].filter(Boolean).join("\n\n");
}

/** Where a card's work happens and where it lands when finished. Keyed off the
 *  column stages when the board has them: work in `doing`, land in `review`
 *  (or `done` when there is no review stage). A board with no stages at all
 *  falls back to the old positional rule: the column after this one, then the
 *  one after that, clamped at the end. */
function taskColumns(board: Board, card: Card): { work: Column; land: Column } {
  const here = board.columns.find((c) => c.id === card.columnId) ?? board.columns[0]!;
  const doing = stageColumn(board, "doing");
  const review = stageColumn(board, "review");
  const done = stageColumn(board, "done");
  if (doing || review || done) {
    const work = doing ?? here;
    const land = review ?? done ?? work;
    return { work, land };
  }
  const at = board.columns.findIndex((c) => c.id === card.columnId);
  const work = board.columns[at + 1] ?? here;
  const land = board.columns[at + 2] ?? work;
  return { work, land };
}

/** Move a card into the column where its work happens (the board's `doing`
 *  stage, else the positional fallback from `taskColumns`), unless it is
 *  already there. The server calls this when a task is delivered to an agent,
 *  so a card reaches in-progress deterministically instead of depending on the
 *  agent running its STEP 1 card-move — which it often skips, batches, or has
 *  silently rejected. No-op (returns the same board) for an unknown card or one
 *  already in its work column. */
export function progressCard(board: Board, id: string): Board {
  const card = board.cards.find((k) => k.id === id);
  if (!card) return board;
  const { work } = taskColumns(board, card);
  if (work.id === card.columnId) return board;
  return moveCard(board, id, work.id);
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
  return { ...board, cards: insertInColumn(rest, moved, toIndex) };
}

/** Splice `card` into `cards` at `index` counted among the cards already in its
 *  own column, leaving every other column's order untouched. Past the end (or a
 *  column with no cards yet) it appends. Shared by moveCard and restoreCard. */
function insertInColumn(cards: Card[], card: Card, index: number): Card[] {
  const out: Card[] = [];
  let placed = false;
  let seen = 0;
  for (const k of cards) {
    if (k.columnId === card.columnId) {
      if (seen === index) { out.push(card); placed = true; }
      seen++;
    }
    out.push(k);
  }
  if (!placed) out.push(card);
  return out;
}

/** Where a card lands when it is moved by keyboard rather than dragged.
 *  "left"/"right" step it a column at a time, keeping its row where the target
 *  is long enough and clamping to the end where it is not; "up"/"down" reorder
 *  it inside its own column. Null when there is nowhere to go — the edge of the
 *  board, the end of a column, or an id that isn't here — so a caller can just
 *  do nothing rather than special-case every boundary. */
export function cardMoveTarget(
  board: Board,
  id: string,
  dir: "left" | "right" | "up" | "down",
): { toColumnId: string; toIndex: number } | null {
  const card = board.cards.find((k) => k.id === id);
  if (!card) return null;
  const colAt = board.columns.findIndex((c) => c.id === card.columnId);
  if (colAt === -1) return null;
  const inColumn = board.cards.filter((k) => k.columnId === card.columnId);
  const row = inColumn.findIndex((k) => k.id === id);

  if (dir === "up" || dir === "down") {
    const to = row + (dir === "down" ? 1 : -1);
    if (to < 0 || to >= inColumn.length) return null;
    return { toColumnId: card.columnId, toIndex: to };
  }

  const toCol = board.columns[colAt + (dir === "right" ? 1 : -1)];
  if (!toCol) return null;
  const target = board.cards.filter((k) => k.columnId === toCol.id).length;
  return { toColumnId: toCol.id, toIndex: Math.min(row, target) };
}

// ---- validation & persistence --------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** A Claude Code session id — the only thing that can be an assignee. Persona
 *  ids (`backend-dev`, `frontend-ux`, …) deliberately fail this. */
/** Mirrors CREW_ID_RE in src/lib/crew.ts (kept local: board.ts is imported by
 *  the browser bundle, crew.ts touches the filesystem). */
const CREW_ID = /^[a-z0-9-]{1,64}$/;
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
  const crew = str(o.crew);
  return crew !== null && CREW_ID.test(crew) ? { id, name, crew } : { id, name };
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

/** Repair one column: needs a string id and name; a missing instruction is "".
 *  Exported so a single column can be validated on its own — the restore
 *  endpoints take one back from a client rather than a whole board. */
export function sanitizeColumn(v: unknown): Column | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name);
  if (id === null || name === null) return null;
  const col: Column = { id, name, instruction: str(o.instruction) ?? "" };
  // An explicit stage wins; a stock id from before stages existed implies one,
  // so an old board picks up the protocol without anyone editing it.
  const stage = (STAGES as readonly string[]).includes(o.stage as string) ? (o.stage as Stage) : LEGACY_STAGE[id];
  if (stage) col.stage = stage;
  return col;
}

/** Repair one card: needs a string id, title and columnId; optional detail is
 *  carried through only when present, so a bare card stays bare. Whether that
 *  columnId actually exists is the board's business, not the card's. */
export function sanitizeCard(v: unknown): Card | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const title = str(o.title);
  const columnId = str(o.columnId);
  if (id === null || title === null || columnId === null) return null;
  const card: Card = { id, title, columnId };
  const description = str(o.description);
  if (description !== null) card.description = description;
  const assignee = sanitizeAssignee(o.assignee);
  if (assignee) card.assignee = assignee;
  const comments = sanitizeComments(o.comments);
  if (comments.length) card.comments = comments;
  return card;
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
      const col = sanitizeColumn(c);
      if (!col || colIds.has(col.id)) continue;
      colIds.add(col.id);
      columns.push(col);
    }
  }
  if (columns.length === 0) return defaultBoard();

  const cards: Card[] = [];
  const cardIds = new Set<string>();
  if (Array.isArray(raw.cards)) {
    for (const k of raw.cards) {
      const card = sanitizeCard(k);
      if (!card) continue;
      // Board-level rules the card can't judge for itself: no duplicate ids, and
      // no orphans pointing at a column that isn't here.
      if (cardIds.has(card.id) || !colIds.has(card.columnId)) continue;
      cardIds.add(card.id);
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

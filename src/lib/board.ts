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
  // The card's number, shown as "#42" (added in VERSION 5): the short label
  // people and agents point at. `id` stays the key every API uses; this is only
  // a label. Handed out once from the board's counter and never reused, even
  // after the card is deleted or archived. Absent only on a card from an older
  // board that numberCards hasn't reached yet.
  num?: number;
  // Optional detail (added in VERSION 3). Absent on cards that have none, so the
  // on-disk format stays minimal and older boards keep working untouched.
  description?: string;
  assignee?: Assignee | null;
  comments?: Comment[];
  // The files this card is expected to change — literal paths or globs, relative
  // to the repo root (added in VERSION 4). Its FILE CLAIM: while the card is
  // staffed and unmerged, no second card touching the same files may be staffed
  // (see overlappingClaims). Opt-in: absent on cards nobody has filled it in for,
  // and a card with none is never blocked and never blocks.
  touches?: string[];
  // Which project the card belongs to: a short display name (the repo folder's
  // basename, or whatever a person typed) and, when known, the main checkout's
  // full path. One board holds cards for several repos, so this is how a card
  // says which one before anyone is assigned. Filled in when an agent is spawned
  // for the card; editable by hand. Optional like the rest: an old card without
  // one loads bare and simply shows no chip.
  repo?: string;
  repoPath?: string;
  // What sort of card this is. Absent on an ordinary work card; "scrum" marks
  // the one card per project that briefs a scrum master (see scrumBrief). The
  // board draws it in its own colour so it never reads as just another ticket.
  kind?: CardKind;
  // The one comment pinned as the card's handoff note (usually the worker's
  // last: what changed, how it was verified, what wasn't). Shown above the
  // description. Absent when nothing is pinned; dropped on load when it names a
  // comment the card no longer has.
  pinnedCommentId?: string;
};
export type CardKind = "scrum";
/** What a column MEANS to the protocol, independent of where it sits. `todo`
 *  is where new cards wait, `doing` is where an agent works, `review` is where
 *  finished work lands for a human, `done` is finished. A column with no stage
 *  (a user's "Merged", "Archived") is just a place cards can be put. */
export type Stage = "todo" | "doing" | "review" | "done";
export const STAGES: readonly Stage[] = ["todo", "doing", "review", "done"];
export type Column = { id: string; name: string; instruction: string; stage?: Stage };
// `nextNum` is the next card number to hand out (see Card.num). Optional so a
// board written before numbers loads unchanged.
export type Board = { columns: Column[]; cards: Card[]; nextNum?: number };

// The stock Done column's id. Kept for the default board; anything deciding
// whether a column is "done" should ask isDoneColumn, which keys off the stage.
export const DONE_COLUMN_ID = "done";

/** The stage a stock column id implies, for boards written before stages
 *  existed. Only the four ids defaultBoard mints are recognised. */
const LEGACY_STAGE: Record<string, Stage> = { backlog: "todo", "in-progress": "doing", review: "review", done: "done" };

const VERSION = 5;

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
    ...board,
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
  return { ...board, columns, cards: [...board.cards, ...mine] };
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
  const num = nextCardNum(board);
  const card: Card = { id: genId("card"), num, title, columnId };
  return { ...board, cards: [...board.cards, card], nextNum: num + 1 };
}

/** The number the next new card gets: the board's counter, but never one a
 *  card on the board already holds (a hand-edited file could lag). */
export function nextCardNum(board: Board): number {
  const top = Math.max(0, ...board.cards.map((k) => k.num ?? 0));
  return Math.max(board.nextNum ?? 1, top + 1);
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

/** Replace the card's file claim — the paths/globs it is expected to change.
 *  Entries are trimmed and de-duplicated, blanks dropped; an empty result drops
 *  the field entirely rather than storing `[]`, so a card nobody has filled in
 *  stays bare on disk (and is never blocked -- see overlappingClaims). */
export function setCardTouches(board: Board, id: string, touches: string[]): Board {
  const clean = cleanTouches(touches);
  return mapCard(board, id, (k) => {
    const { touches: _old, ...rest } = k;
    return clean.length ? { ...rest, touches: clean } : rest;
  });
}

/** Trim, drop blanks, de-duplicate — shared by setCardTouches and sanitizeCard
 *  so a hand-edited board file and a UI edit end up with the same list. */
function cleanTouches(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A folder path's last segment, trailing slashes ignored: the repo name the
 *  board shows for a checkout. Pure string work — this module is in the
 *  browser bundle, so no node:path. Empty for an empty path or `/`. */
export function repoName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Label the card with its repo, or clear it with a blank/null name. The path
 *  is kept only when given: a name typed by hand says nothing about where the
 *  old path pointed, so it drops rather than goes stale. */
export function setCardRepo(board: Board, id: string, repo: string | null, path?: string): Board {
  const name = (repo ?? "").trim();
  const where = (path ?? "").trim();
  return mapCard(board, id, (k) => {
    const { repo: _r, repoPath: _p, ...rest } = k;
    if (!name) return rest;
    return where ? { ...rest, repo: name, repoPath: where } : { ...rest, repo: name };
  });
}

/** Mark what sort of card this is; `null` makes it an ordinary card again. */
export function setCardKind(board: Board, id: string, kind: CardKind | null): Board {
  return mapCard(board, id, (k) => {
    const { kind: _k, ...rest } = k;
    return kind ? { ...rest, kind } : rest;
  });
}

/** The scrum master card already on the board for this project, if any. A card
 *  with no repo only matches a request with none, so "no project yet" is its
 *  own slot rather than a wildcard. */
export function findScrumCard(board: Board, repo: string | undefined): Card | undefined {
  const want = (repo ?? "").trim();
  return board.cards.find((k) => k.kind === "scrum" && (k.repo ?? "") === want);
}

/** The starter brief for a scrum master card. Deliberately short and plain: it
 *  is a draft the human edits before any scrum master is put on it. */
export function scrumBrief(repo: string | undefined, repoPath?: string): string {
  const name = (repo ?? "").trim();
  const where = (repoPath ?? "").trim();
  const project = name
    ? `**${name}**${where ? ` (\`${where}\`)` : ""}`
    : "**(name the project here)**";
  return [
    `You are the scrum master for ${project}.`,
    "",
    "Your job:",
    "- Read the board and pick the next cards for this project from the backlog.",
    "- Hand each card to a fresh agent: spawn one per card, with the persona that fits the work.",
    "- Do not write code yourself. Keep the board truthful and tell me what is blocked on me.",
    "",
    "Notes for this project:",
    "- (add priorities, constraints or cards to skip here)",
  ].join("\n");
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
  return mapCard(board, id, (k) => {
    const next = { ...k, comments: (k.comments ?? []).filter((m) => m.id !== commentId) };
    if (next.pinnedCommentId === commentId) delete next.pinnedCommentId;
    return next;
  });
}

/** Pin one of the card's comments as its handoff note, replacing any earlier
 *  pin, or clear the pin with `null`. A comment the card doesn't have is a
 *  no-op. */
export function pinComment(board: Board, id: string, commentId: string | null): Board {
  return mapCard(board, id, (k) => {
    if (commentId === null) {
      const { pinnedCommentId: _old, ...rest } = k;
      return rest;
    }
    return (k.comments ?? []).some((m) => m.id === commentId) ? { ...k, pinnedCommentId: commentId } : k;
  });
}

/** The card's pinned comment, if it has one. */
export function pinnedComment(card: Pick<Card, "comments" | "pinnedCommentId">): Comment | undefined {
  return card.pinnedCommentId ? card.comments?.find((m) => m.id === card.pinnedCommentId) : undefined;
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

/** One card and the board's columns, with no other cards: what an agent needs
 *  to re-read its own ticket (GET /card, and the MCP card_read) without pulling
 *  the whole board. Undefined for an unknown card. */
export function cardView(board: Board, id: string): { card: Card; columns: Column[] } | undefined {
  const card = board.cards.find((c) => c.id === id);
  return card ? { card, columns: board.columns } : undefined;
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
export function cardTaskPrompt(board: Board, id: string, server: string, agentName?: string, opts: FooterOpts = {}): string {
  return [cardTaskText(board, id), cardTaskFooter(board, id, server, agentName, opts)].filter(Boolean).join("\n\n");
}

/** The "-- THE LINE --" protocol footer on its own, for a caller that already
 *  has the task text (a spawn by curl sends plain text; see spawnSession). */
export type FooterOpts = {
  workedBefore?: boolean;
  /** The agent's crew id, when known. Rides along with "as":"assignee" so the
   *  server can refuse a write from an agent taken off the card, rather than
   *  sign it with the new assignee's name. */
  crew?: string;
};

export function cardTaskFooter(board: Board, id: string, server: string, agentName?: string, opts: FooterOpts = {}): string {
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
  const sign = opts.crew ? `"as":"assignee","crew":"${opts.crew}"` : `"as":"assignee"`;
  const comment = (text: string, pin = false) =>
    post("/action/card-comment", `{"cardId":"${card.id}",${sign},"text":"${text}"${pin ? `,"pin":true` : ""}}`);

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
        post("/action/card-move", `{"cardId":"${card.id}",${sign},"toColumnId":"${work.id}"}`),
        comment("Picked this up. <one line on your plan>"),
      ];

  return [
    "-- THE LINE --",
    `card: ${card.id}${card.num ? ` (#${card.num})` : ""}`,
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
    // The assignee can lag the task: a spawn binds itself only once its
    // SessionStart hook's card-assign lands, and that can fail or be refused.
    // Until then the server turns "as":"assignee" away; say what to do instead.
    // A placeholder, not agentName, for the same reason the commands use "as":
    // a baked-in name goes stale when the desk is renamed.
    'If a call signed "as":"assignee" is rejected with "card has no',
    'assignee to sign as", resend the same call with "author":"<your name>"',
    'in place of "as":"assignee".',
    'If a call is rejected with "you are no longer assigned to this card", you',
    "were taken off it: stop work on it and do not write to it again.",
    "Before you plan, search the team memory (memory_search) for past gotchas.",
    "STEP 2: do the work. Whenever you find or decide something worth knowing,",
    "post it as a card-comment (same shape as above). Keep comments plain and",
    "short -- write like a quick note to a busy teammate, no jargon or filler,",
    "unless this card asks for more detail.",
    "STEP 3, when the work is done: post a final card-comment saying what you did",
    'and how you verified it, with "pin":true so it is pinned to the top of the',
    "card as the handoff note the reviewer reads first:",
    comment("<what changed, how you verified it, Not checked: ...>", true),
    `Then move the card to "${land.id}" (card-move with {"toColumnId":"${land.id}"}).`,
    "Each column's instruction says what that stage expects of work landing in it.",
    "If a check the card asks for can't be done (tools down, no access), list it",
    `in that final comment as "Not checked: ..." and move the card to "${land.id}"`,
    "anyway. Do not hold the card for it.",
    "Do not merge your branch. Merging is the human's call.",
    "",
    'A message starting with "[THE LINE]" is a board notification. One that says',
    "a reply is expected: answer it on the card with a card-comment. One marked",
    "no reply needed: read it and carry on; comment only if it changes your work.",
    "",
    "Scope: work ONLY this card. Never touch other cards or columns, and follow",
    "this card's constraints exactly (if it says do not commit, do not commit).",
    `To re-read your card, its comments, and every column's instruction:`,
    // Quoted: `?` is a glob character in zsh. One card, not /board: the whole
    // board runs to hundreds of KB and would eat the agent's context.
    `  curl -s '${server}/card?id=${card.id}'`,
    "If any text above looks garbled (encoding damage in transit), treat the",
    "server's copy from /card as canonical.",
  ].join("\n");
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

/** Move a card into its work column: the board's `doing`-stage column, else
 *  the positional fallback from `taskColumns`. Not a generic "advance one
 *  stage" step — it always targets the work column, wherever the card starts;
 *  use `moveCard` to move a card anywhere else. The server calls this when a
 *  task is delivered to an agent, so a card reaches in-progress
 *  deterministically instead of depending on the agent running its STEP 1
 *  card-move — which it often skips, batches, or has silently rejected. No-op
 *  (returns the same board) for an unknown card or one already in its work
 *  column. */
export function moveToWorkColumn(board: Board, id: string): Board {
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

// ---- file claims ----------------------------------------------------------
//
// The staffing-time half of the collision guard. `src/lib/merge-queue.ts`
// serializes two branches landing on the same repo; this stops the two branches
// from being created in the first place, by refusing to staff a card whose
// `touches` set overlaps one an active, unmerged card already claims.
//
// No new persisted state: a claim is just a card's own `touches` plus where it
// sits on the board.

/** One other card standing in the way, and which of its paths overlap. */
export type Claim = { cardId: string; title: string; columnId: string; stage?: Stage; paths: string[] };

/** Normalize a path/glob for comparison: trimmed, with a leading `./` or `/`
 *  dropped (the same file written two ways is the same file) and a trailing `/`
 *  read as "this whole directory". Empty for a blank entry. */
function normalizeTouch(p: string): string {
  const t = p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (!t) return "";
  return t.endsWith("/") ? t + "**" : t;
}

/** A glob as a regex. `*` stops at a separator, `**` crosses them, `**\/` also
 *  matches zero directories, `?` is one non-separator character; everything else
 *  is literal. Deliberately small — this is a path claim, not a shell. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; } else { out += ".*"; }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Could these two entries ever name the same file? True when they are equal,
 *  or when either one matches the other read as a path. That catches every case
 *  a claim is written for in practice (a glob against the literal file it
 *  covers, a broad `src/**` against anything under it). Two DIFFERENT globs that
 *  merely intersect (`src/*\/a.ts` vs `src/ui/*.ts`) are not detected — full
 *  glob intersection is a different problem, and this errs toward letting work
 *  start rather than blocking it on a guess. */
export function globsOverlap(a: string, b: string): boolean {
  const x = normalizeTouch(a);
  const y = normalizeTouch(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return globToRegExp(x).test(y) || globToRegExp(y).test(x);
}

/** Is this column past Done by position alone? A `done` column, or a stageless
 *  one placed after a `done` column — the user's own "Merged" or "Archived" past
 *  Done is where finished work goes next, so nobody should have to stage it by
 *  hand. A stageless column before Done (or on a board with no Done) is not. */
function isPastDone(board: Board, at: number): boolean {
  const stage = columnStage(board.columns[at]!);
  if (stage) return stage === "done";
  return board.columns.slice(0, at).some((c) => columnStage(c) === "done");
}

/** Does the done-stage column hold work that is accepted but not merged yet?
 *  True when a landed column (a "Merged") comes after it: merged cards go
 *  there, so Done is a waiting room and its cards keep their claims and their
 *  place in the merge line. False on a board with nothing landed past Done,
 *  where Done is the end of the line. The one place this rule lives. */
function doneAwaitsMerge(board: Board): boolean {
  const done = stageColumn(board, "done");
  if (!done) return false;
  const at = board.columns.indexOf(done);
  return board.columns.some((_, i) => i > at && isPastDone(board, i));
}

/** Has a card in this column landed? Past Done (see isPastDone), except the
 *  done-stage column itself when it awaits merge (see doneAwaitsMerge). */
export function isLandedColumn(board: Board, columnId: string): boolean {
  const at = board.columns.findIndex((c) => c.id === columnId);
  if (at < 0) return LEGACY_STAGE[columnId] === "done";
  if (!isPastDone(board, at)) return false;
  return !(board.columns[at] === stageColumn(board, "done") && doneAwaitsMerge(board));
}

/** Does moving a card from `fromColumnId` to `toColumnId` finish it? True when
 *  it lands in Done or a column after it (a merge can skip Done) from a column
 *  before Done. A card already finished, shuffling among those columns, is not
 *  finished again. Its assignee's session is ended on a finish. By position
 *  (isPastDone), not claims: a card waiting in Done to merge keeps its claims
 *  (see doneAwaitsMerge) but its agent's work is over. */
export function finishesCard(board: Board, fromColumnId: string, toColumnId: string): boolean {
  const to = board.columns.findIndex((c) => c.id === toColumnId);
  if (to < 0) return false;
  const from = board.columns.findIndex((c) => c.id === fromColumnId);
  const fromFinished = from < 0 ? LEGACY_STAGE[fromColumnId] === "done" : isPastDone(board, from);
  return isPastDone(board, to) && !fromFinished;
}

/** Is this card holding its claim right now? Two things have to be true: it has
 *  been STAFFED (an agent is bound to it, or it sits where work happens, waits
 *  for review, or waits in Done to merge), and it has not landed yet (see isLandedColumn).
 *  A card merely planned in the backlog claims nothing — otherwise a groomed
 *  backlog would block its own cards from ever being picked up. */
function isClaiming(board: Board, card: Card): boolean {
  if (!card.touches?.length) return false;
  if (isLandedColumn(board, card.columnId)) return false;
  const stage = columnStage(board.columns.find((c) => c.id === card.columnId) ?? { id: card.columnId, name: "", instruction: "" });
  // Not landed and in a done-stage column means Done awaits merge: the work
  // was staffed to get there, so it holds its claim with or without an agent.
  return !!card.assignee || stage === "doing" || stage === "review" || stage === "done";
}

/** Every other card actively claiming a file this card also touches. Empty when
 *  the card is unknown, has no `touches`, or nothing overlaps — so a card with
 *  no claim set is never blocked. Pure: the board is the only input. */
export function overlappingClaims(board: Board, cardId: string): Claim[] {
  const card = board.cards.find((k) => k.id === cardId);
  const mine = card?.touches ?? [];
  if (!mine.length) return [];
  const out: Claim[] = [];
  for (const other of board.cards) {
    if (other.id === card!.id || !isClaiming(board, other)) continue;
    const paths = (other.touches ?? []).filter((p) => mine.some((m) => globsOverlap(m, p)));
    if (!paths.length) continue;
    const col = board.columns.find((c) => c.id === other.columnId);
    out.push({
      cardId: other.id,
      title: other.title,
      columnId: other.columnId,
      ...(col && columnStage(col) ? { stage: columnStage(col) } : {}),
      paths,
    });
  }
  return out;
}

/** One line saying why this card cannot be staffed, or null when it can. Pure
 *  ASCII: it is shown in the UI, returned from the HTTP actions, and read back
 *  by an agent through a pty that mangles anything else. */
export function claimBlockReason(board: Board, cardId: string): string | null {
  const claims = overlappingClaims(board, cardId);
  if (!claims.length) return null;
  const held = claims
    .map((c) => `${c.cardId} already claims ${c.paths.join(", ")} (in ${c.stage ?? c.columnId})`)
    .join(", ");
  const them = claims.length === 1 ? "it" : "them";
  return `${held} - wait for ${them} to merge, or edit touches to remove the overlap`;
}

// ---- merge order ------------------------------------------------------------
//
// The merge-time half. The staffing gate above keeps overlapping cards from
// being staffed together, but they still can be (touches edited after the
// fact, a forced assign). Those land one at a time, in board order: a card
// further right goes first, and within a column the one higher up. Only cards
// AHEAD hold a card back, so two overlapping cards never wait on each other.
// This is the visible queue; merge-queue.ts still serializes the git merge.

/** Where a card stands in the merge line: its column's index, then its row in
 *  that column. Compare with `isAhead`. */
function mergeRank(board: Board, card: Card): [number, number] {
  const col = board.columns.findIndex((c) => c.id === card.columnId);
  const row = board.cards.filter((k) => k.columnId === card.columnId).indexOf(card);
  return [col, row];
}

function isAhead(board: Board, a: Card, b: Card): boolean {
  const [ac, ar] = mergeRank(board, a);
  const [bc, br] = mergeRank(board, b);
  return ac !== bc ? ac > bc : ar < br;
}

/** The overlapping, unmerged cards this one has to wait for before it can
 *  merge: every active claim (see overlappingClaims) that sits ahead of it.
 *  Empty when the card isn't holding a claim itself — unstaffed, landed, or no
 *  `touches` — since then it has nothing in the line to wait for. */
export function mergeBlockers(board: Board, cardId: string): Claim[] {
  const card = board.cards.find((k) => k.id === cardId);
  if (!card || !isClaiming(board, card)) return [];
  return overlappingClaims(board, cardId).filter((c) => {
    const other = board.cards.find((k) => k.id === c.cardId);
    return !!other && isAhead(board, other, card);
  });
}

function blockedOn(claims: Claim[]): string {
  return claims.map((c) => `${c.cardId} (${c.paths.join(", ")})`).join(", ");
}

/** One line saying which card(s) to merge first, or null when this card is
 *  clear to land. ASCII only, like claimBlockReason. */
export function mergeBlockReason(board: Board, cardId: string): string | null {
  const claims = mergeBlockers(board, cardId);
  if (!claims.length) return null;
  return `blocked on ${blockedOn(claims)} - merge ${claims.length === 1 ? "that" : "those"} first`;
}

/** Where a card goes once its branch has really merged: the last landed column
 *  after the done-stage one (a user's "Merged" or "Archived", see
 *  isLandedColumn), else the done-stage column itself. Undefined on a board
 *  with no done column. The one place this rule lives, so it can change. */
export function mergedColumn(board: Board): Column | undefined {
  const done = stageColumn(board, "done");
  if (!done) return undefined;
  const after = board.columns.slice(board.columns.indexOf(done) + 1).filter((c) => isLandedColumn(board, c.id));
  return after[after.length - 1] ?? done;
}

/** A card whose branch just merged, moved to mergedColumn so its claim is
 *  released. Unchanged (same board) when it has already landed or the board
 *  has nowhere to put it. */
export function landMergedCard(board: Board, cardId: string): Board {
  const card = board.cards.find((k) => k.id === cardId);
  const to = mergedColumn(board);
  if (!card || !to || isLandedColumn(board, card.columnId)) return board;
  return moveCard(board, cardId, to.id);
}

/** The comment to post on each card that was waiting on `mergedId`, given the
 *  board just before and just after that card merged. A card with nothing left
 *  ahead of it is told it is clear; one still behind another is told which. */
export function mergeReleaseNotes(before: Board, after: Board, mergedId: string): { cardId: string; text: string }[] {
  const out: { cardId: string; text: string }[] = [];
  for (const card of before.cards) {
    if (card.id === mergedId) continue;
    if (!mergeBlockers(before, card.id).some((c) => c.cardId === mergedId)) continue;
    const left = mergeBlockers(after, card.id).filter((c) => c.cardId !== mergedId);
    const text = left.length
      ? `${mergedId} merged - you are still blocked on ${blockedOn(left)}. Merge that first.`
      : `${mergedId} merged - you're clear to land now.`;
    out.push({ cardId: card.id, text });
  }
  return out;
}

// ---- validation & persistence --------------------------------------------
//
// Why these sanitizers are hand-rolled rather than zod schemas: zod is this
// codebase's validation idiom (src/schema.ts, and the /action/* body schemas
// in src/lib/actionBodies.ts), but board.ts is bundled into the browser, and
// pulling zod in here would ship it to the page for a handful of "keep the
// field if it's a string" checks. So the split is deliberate: server-only
// input is validated with zod, anything that must also run in the browser
// uses these plain functions. A rule fixed on one side (duplicate ids, blank
// titles, what counts as a session id) should be looked for on the other.

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
  if (Number.isSafeInteger(o.num) && (o.num as number) > 0) card.num = o.num as number;
  const description = str(o.description);
  if (description !== null) card.description = description;
  const assignee = sanitizeAssignee(o.assignee);
  if (assignee) card.assignee = assignee;
  const comments = sanitizeComments(o.comments);
  if (comments.length) card.comments = comments;
  const touches = cleanTouches(o.touches);
  if (touches.length) card.touches = touches;
  // A repo needs a name to show; a path on its own is dropped.
  const repo = str(o.repo)?.trim();
  if (repo) {
    card.repo = repo;
    const repoPath = str(o.repoPath)?.trim();
    if (repoPath) card.repoPath = repoPath;
  }
  if (o.kind === "scrum") card.kind = "scrum";
  const pinned = str(o.pinnedCommentId);
  if (pinned && comments.some((m) => m.id === pinned)) card.pinnedCommentId = pinned;
  return card;
}

/** Validate/repair arbitrary input into a Board. The file is documented as one
 *  any Claude session may write, so bad columns/cards are dropped here rather
 *  than crash consumers. Falls back to the default board when unusable. */
export function sanitizeBoard(input: unknown): Board {
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaultBoard();
  const raw = input as { columns?: unknown; cards?: unknown; nextNum?: unknown };

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

  const board: Board = { columns, cards };
  if (Number.isSafeInteger(raw.nextNum) && (raw.nextNum as number) > 0) board.nextNum = raw.nextNum as number;
  return board;
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

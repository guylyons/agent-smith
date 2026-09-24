import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultBoard,
  sanitizeBoard,
  addColumn,
  renameColumn,
  setInstruction,
  deleteColumn,
  restoreColumn,
  reorderColumn,
  addCard,
  renameCard,
  deleteCard,
  restoreCard,
  moveCard,
  moveToWorkColumn,
  cardMoveTarget,
  setCardDescription,
  assignCard,
  addComment,
  deleteComment,
  cardTaskText,
  cardTaskPrompt,
  sanitizeColumn,
  setColumnStage,
  stageColumn,
  isDoneColumn,
  readBoard,
  writeBoard,
  type Board,
  sanitizeCard, setCardRepo, setCardKind, findScrumCard, scrumBrief,
} from "../src/lib/board";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "board-"));
}

test("defaultBoard seeds four columns and no cards", () => {
  const b = defaultBoard();
  expect(b.columns.map((c) => c.name)).toEqual(["Backlog", "In Progress", "Review", "Done"]);
  expect(b.cards).toEqual([]);
  // The Done column carries an example instruction so the format documents itself.
  expect(b.columns[3]!.instruction).toContain("worktree");
});

test("defaultBoard column ids are unique", () => {
  const ids = defaultBoard().columns.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("addColumn appends a column with a unique id and empty instruction", () => {
  const b = addColumn(defaultBoard(), "Blocked");
  const col = b.columns.at(-1)!;
  expect(b.columns).toHaveLength(5);
  expect(col.name).toBe("Blocked");
  expect(col.instruction).toBe("");
  expect(col.id).toBeTruthy();
  expect(new Set(b.columns.map((c) => c.id)).size).toBe(5);
});

test("addColumn does not mutate the input board", () => {
  const before = defaultBoard();
  addColumn(before, "Blocked");
  expect(before.columns).toHaveLength(4);
});

test("renameColumn changes only the named column", () => {
  const b0 = defaultBoard();
  const id = b0.columns[0]!.id;
  const b = renameColumn(b0, id, "Icebox");
  expect(b.columns[0]!.name).toBe("Icebox");
  expect(b.columns[1]!.name).toBe("In Progress");
});

test("setInstruction sets a column's instruction", () => {
  const b0 = defaultBoard();
  const id = b0.columns[0]!.id;
  const b = setInstruction(b0, id, "Pick the top ticket and start.");
  expect(b.columns[0]!.instruction).toBe("Pick the top ticket and start.");
});

test("deleteColumn removes the column and its cards", () => {
  let b = defaultBoard();
  const target = b.columns[0]!.id;
  const keep = b.columns[1]!.id;
  b = addCard(b, target, "in target");
  b = addCard(b, keep, "in keep");
  b = deleteColumn(b, target);
  expect(b.columns.map((c) => c.id)).not.toContain(target);
  expect(b.cards.map((c) => c.title)).toEqual(["in keep"]);
});

test("reorderColumn moves a column to a new index", () => {
  const b0 = defaultBoard(); // Backlog, In Progress, Review, Done
  const done = b0.columns[3]!.id;
  const b = reorderColumn(b0, done, 0);
  expect(b.columns.map((c) => c.name)).toEqual(["Done", "Backlog", "In Progress", "Review"]);
});

test("reorderColumn clamps an out-of-range index to the end", () => {
  const b0 = defaultBoard();
  const backlog = b0.columns[0]!.id;
  const b = reorderColumn(b0, backlog, 99);
  expect(b.columns.map((c) => c.name)).toEqual(["In Progress", "Review", "Done", "Backlog"]);
});

test("addCard adds a card to a column with a unique id", () => {
  const b0 = defaultBoard();
  const col = b0.columns[0]!.id;
  const b = addCard(b0, col, "Fix login bug");
  const card = b.cards.at(-1)!;
  expect(card.title).toBe("Fix login bug");
  expect(card.columnId).toBe(col);
  expect(card.id).toBeTruthy();
});

test("addCard to an unknown column is a no-op", () => {
  const b = addCard(defaultBoard(), "nope", "orphan");
  expect(b.cards).toHaveLength(0);
});

test("renameCard changes only the named card", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = addCard(b, col, "old");
  const id = b.cards[0]!.id;
  b = renameCard(b, id, "new");
  expect(b.cards[0]!.title).toBe("new");
});

test("deleteCard removes the card", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = addCard(b, col, "doomed");
  const id = b.cards[0]!.id;
  b = deleteCard(b, id);
  expect(b.cards).toHaveLength(0);
});

test("moveCard moves a card to another column, appended at the end", () => {
  let b = defaultBoard();
  const from = b.columns[0]!.id;
  const to = b.columns[1]!.id;
  b = addCard(b, to, "already there");
  b = addCard(b, from, "mover");
  const id = b.cards.find((c) => c.title === "mover")!.id;
  b = moveCard(b, id, to);
  const inTo = b.cards.filter((c) => c.columnId === to).map((c) => c.title);
  expect(inTo).toEqual(["already there", "mover"]);
});

test("moveCard can insert at a specific index within the target column", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = addCard(b, col, "a");
  b = addCard(b, col, "b");
  b = addCard(b, col, "c");
  const c = b.cards.find((x) => x.title === "c")!.id;
  b = moveCard(b, c, col, 0);
  expect(b.cards.filter((x) => x.columnId === col).map((x) => x.title)).toEqual(["c", "a", "b"]);
});

test("moveToWorkColumn moves a card into the board's work (doing) column", () => {
  let b = defaultBoard();
  const backlog = b.columns[0]!.id;
  b = addCard(b, backlog, "task");
  const id = b.cards[0]!.id;
  b = moveToWorkColumn(b, id);
  expect(b.cards[0]!.columnId).toBe(stageColumn(b, "doing")!.id);
});

test("moveToWorkColumn is a no-op (same board) for a card already in its work column", () => {
  let b = defaultBoard();
  const doing = stageColumn(b, "doing")!.id;
  b = addCard(b, doing, "task");
  const id = b.cards[0]!.id;
  expect(moveToWorkColumn(b, id)).toBe(b);
});

test("moveToWorkColumn is a no-op (same board) for an unknown card", () => {
  const b = defaultBoard();
  expect(moveToWorkColumn(b, "card_nope")).toBe(b);
});

test("moveCard to an unknown column is a no-op", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = addCard(b, col, "stay");
  const id = b.cards[0]!.id;
  b = moveCard(b, id, "nope");
  expect(b.cards[0]!.columnId).toBe(col);
});

test("sanitizeBoard returns the default board for non-object input", () => {
  expect(sanitizeBoard(null)).toEqual(defaultBoard());
  expect(sanitizeBoard("garbage")).toEqual(defaultBoard());
  expect(sanitizeBoard(42)).toEqual(defaultBoard());
});

test("sanitizeBoard falls back to default when there are no valid columns", () => {
  expect(sanitizeBoard({ columns: [], cards: [] })).toEqual(defaultBoard());
  expect(sanitizeBoard({ columns: [{ id: 1 }], cards: [] })).toEqual(defaultBoard());
});

test("sanitizeBoard keeps valid columns and coerces missing fields", () => {
  const b = sanitizeBoard({ columns: [{ id: "c1", name: "Todo" }], cards: [] });
  expect(b.columns).toEqual([{ id: "c1", name: "Todo", instruction: "" }]);
});

test("sanitizeBoard drops cards that reference an unknown column", () => {
  const b = sanitizeBoard({
    columns: [{ id: "c1", name: "Todo", instruction: "" }],
    cards: [
      { id: "k1", title: "keep", columnId: "c1" },
      { id: "k2", title: "orphan", columnId: "ghost" },
    ],
  });
  expect(b.cards).toEqual([{ id: "k1", title: "keep", columnId: "c1" }]);
});

test("sanitizeBoard drops malformed cards", () => {
  const b = sanitizeBoard({
    columns: [{ id: "c1", name: "Todo", instruction: "" }],
    cards: [{ id: "k1", columnId: "c1" }, "junk", { title: "no id", columnId: "c1" }],
  });
  expect(b.cards).toEqual([]);
});

test("sanitizeBoard drops duplicate column and card ids", () => {
  const b = sanitizeBoard({
    columns: [
      { id: "c1", name: "A", instruction: "" },
      { id: "c1", name: "dup", instruction: "" },
    ],
    cards: [
      { id: "k1", title: "one", columnId: "c1" },
      { id: "k1", title: "dup", columnId: "c1" },
    ],
  });
  expect(b.columns).toEqual([{ id: "c1", name: "A", instruction: "" }]);
  expect(b.cards).toEqual([{ id: "k1", title: "one", columnId: "c1" }]);
});

test("readBoard returns the default board when the file is missing", () => {
  expect(readBoard(tmp())).toEqual(defaultBoard());
});

test("readBoard returns the default board when the file is corrupt", () => {
  const dir = tmp();
  writeFileSync(join(dir, ".line.json"), "{not json");
  expect(readBoard(dir)).toEqual(defaultBoard());
});

test("writeBoard then readBoard round-trips the board", () => {
  const dir = tmp();
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "round trip");
  writeBoard(dir, b);
  expect(readBoard(dir)).toEqual(b);
});

test("writeBoard persists a version field on disk", () => {
  const dir = tmp();
  writeBoard(dir, defaultBoard());
  const raw = JSON.parse(readFileSync(join(dir, ".line.json"), "utf8")) as { version?: number };
  expect(raw.version).toBe(4);
});

// ---- card detail: description, assignee, comments -------------------------

test("setCardDescription stores the description on the card", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "task");
  const id = b.cards[0]!.id;
  b = setCardDescription(b, id, "the full story");
  expect(b.cards[0]!.description).toBe("the full story");
});

test("assignCard sets an assignee, and null clears it", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "task");
  const id = b.cards[0]!.id;
  b = assignCard(b, id, { id: "502d0e8c-8790-4804-b767-0549edfc959c", name: "NOVA" });
  expect(b.cards[0]!.assignee).toEqual({ id: "502d0e8c-8790-4804-b767-0549edfc959c", name: "NOVA" });
  b = assignCard(b, id, null);
  expect(b.cards[0]!.assignee).toBeNull();
});

test("addComment appends a comment with author, text, id, and timestamp", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "task");
  const id = b.cards[0]!.id;
  b = addComment(b, id, "You", "first note");
  const comments = b.cards[0]!.comments!;
  expect(comments.length).toBe(1);
  expect(comments[0]!.author).toBe("You");
  expect(comments[0]!.text).toBe("first note");
  expect(typeof comments[0]!.id).toBe("string");
  expect(typeof comments[0]!.at).toBe("number");
});

test("addComment ignores empty text", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "task");
  const id = b.cards[0]!.id;
  b = addComment(b, id, "You", "   ");
  expect(b.cards[0]!.comments ?? []).toEqual([]);
});

test("deleteComment removes a comment by id", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "task");
  const id = b.cards[0]!.id;
  b = addComment(b, id, "You", "keep");
  b = addComment(b, id, "You", "drop");
  const dropId = b.cards[0]!.comments![1]!.id;
  b = deleteComment(b, id, dropId);
  expect(b.cards[0]!.comments!.map((c) => c.text)).toEqual(["keep"]);
});

test("sanitizeBoard preserves valid description, assignee, and comments", () => {
  const b = sanitizeBoard({
    columns: [{ id: "c1", name: "A", instruction: "" }],
    cards: [{
      id: "k1", title: "one", columnId: "c1",
      description: "desc",
      assignee: { id: "502d0e8c-8790-4804-b767-0549edfc959c", name: "NOVA" },
      comments: [{ id: "m1", author: "You", text: "hi", at: 123 }],
    }],
  });
  expect(b.cards[0]).toEqual({
    id: "k1", title: "one", columnId: "c1",
    description: "desc",
    assignee: { id: "502d0e8c-8790-4804-b767-0549edfc959c", name: "NOVA" },
    comments: [{ id: "m1", author: "You", text: "hi", at: 123 }],
  });
});

test("sanitizeBoard drops malformed comments but keeps the card", () => {
  const b = sanitizeBoard({
    columns: [{ id: "c1", name: "A", instruction: "" }],
    cards: [{
      id: "k1", title: "one", columnId: "c1",
      comments: [{ id: "m1", author: "You", text: "ok", at: 1 }, { text: "no id" }, "garbage"],
    }],
  });
  expect(b.cards[0]!.comments).toEqual([{ id: "m1", author: "You", text: "ok", at: 1 }]);
});

test("writeBoard then readBoard round-trips a fully detailed card", () => {
  const dir = tmp();
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "detailed");
  const id = b.cards[0]!.id;
  b = setCardDescription(b, id, "a description");
  b = assignCard(b, id, { id: "502d0e8c-8790-4804-b767-0549edfc959c", name: "NOVA" });
  b = addComment(b, id, "You", "a comment");
  writeBoard(dir, b);
  expect(readBoard(dir)).toEqual(b);
});

// ---- cardTaskText: the prompt sent to an assigned agent -------------------

test("cardTaskText combines title, description, and column instruction", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = setInstruction(b, col, "Start a worktree and TDD.");
  b = addCard(b, col, "Fix login bug");
  const id = b.cards[0]!.id;
  b = setCardDescription(b, id, "Users are locked out after reset.");
  expect(cardTaskText(b, id)).toBe(
    "Fix login bug\n\nUsers are locked out after reset.\n\nStart a worktree and TDD.",
  );
});

test("cardTaskText is just the title when there's no description or instruction", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "Fix login bug");
  const id = b.cards[0]!.id;
  expect(cardTaskText(b, id)).toBe("Fix login bug");
});

test("cardTaskText includes the instruction but skips an empty description", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = setInstruction(b, col, "Ship it.");
  b = addCard(b, col, "Fix login bug");
  const id = b.cards[0]!.id;
  expect(cardTaskText(b, id)).toBe("Fix login bug\n\nShip it.");
});

test("cardTaskText returns empty string for an unknown card", () => {
  expect(cardTaskText(defaultBoard(), "nope")).toBe("");
});







// ---- assignee must be a live agent session, never a persona ---------------
// Cards used to be assigned to a persona (`backend-dev`, `frontend-ux`, …).
// They're assigned to a live grid session now, so a persona-shaped assignee is
// legacy data that can never be sent a task — it's dropped on read.

const SESSION = "502d0e8c-8790-4804-b767-0549edfc959c";

test("sanitizeBoard drops a legacy persona assignee but keeps the card", () => {
  const b = sanitizeBoard({
    columns: [{ id: "c1", name: "A", instruction: "" }],
    cards: [{ id: "k1", title: "one", columnId: "c1", assignee: { id: "backend-dev", name: "ANVIL" } }],
  });
  expect(b.cards.length).toBe(1);
  expect(b.cards[0]!.assignee).toBeUndefined();
});

test("sanitizeBoard keeps an assignee whose id is a real session id", () => {
  const b = sanitizeBoard({
    columns: [{ id: "c1", name: "A", instruction: "" }],
    cards: [{ id: "k1", title: "one", columnId: "c1", assignee: { id: SESSION, name: "NOVA" } }],
  });
  expect(b.cards[0]!.assignee).toEqual({ id: SESSION, name: "NOVA" });
});

test("readBoard heals a board file that still holds a persona assignee", () => {
  const dir = tmp();
  writeFileSync(join(dir, ".line.json"), JSON.stringify({
    version: 3,
    columns: [{ id: "c1", name: "A", instruction: "" }],
    cards: [{ id: "k1", title: "one", columnId: "c1", assignee: { id: "frontend-ux", name: "PIXEL" } }],
  }));
  expect(readBoard(dir).cards[0]!.assignee).toBeUndefined();
});

// ---- cardTaskPrompt: the task PLUS the board protocol --------------------

const SRV = "http://localhost:4173";

test("cardTaskPrompt starts with the plain task text", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  expect(cardTaskPrompt(b, id, SRV).startsWith(cardTaskText(b, id))).toBe(true);
});

test("cardTaskPrompt names the card, the server, and the column flow", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  const p = cardTaskPrompt(b, id, SRV);
  expect(p).toContain(id);
  expect(p).toContain(`${SRV}/board`);
  expect(p).toContain("backlog -> in-progress -> review -> done");
  expect(p).toContain('you are in: "backlog"');
});

test("cardTaskPrompt is pure ASCII outside the card's own text", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  // the pty path mangles non-ASCII, so the protocol itself must never carry any
  expect(/^[\x00-\x7f]*$/.test(p)).toBe(true);
});

test("cardTaskPrompt reflects the card's current column", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  b = moveCard(b, id, "review");
  expect(cardTaskPrompt(b, id, SRV)).toContain('you are in: "review"');
});

test("cardTaskPrompt returns empty string for an unknown card", () => {
  expect(cardTaskPrompt(defaultBoard(), "nope", SRV)).toBe("");
});

test("cardTaskPrompt names where to start and where to land, positionally", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  const p = cardTaskPrompt(b, id, SRV);
  expect(p).toContain(`move this card to "in-progress"`);
  expect(p).toContain('{"toColumnId":"review"}');
});

test("cardTaskPrompt clamps to the last column when a stageless board has nowhere further", () => {
  const b: Board = {
    columns: [{ id: "a", name: "A", instruction: "" }, { id: "z", name: "Z", instruction: "" }],
    cards: [{ id: "k", title: "T", columnId: "z" }],
  };
  const p = cardTaskPrompt(b, "k", SRV);
  // last column: both the start and the finish clamp to where it already is
  expect(p).toContain(`already in "z"`);
  expect(p).toContain('{"toColumnId":"z"}');
});

test("cardTaskPrompt gives runnable curl calls for move and comment", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  const p = cardTaskPrompt(b, id, SRV);
  expect(p).toContain(`curl -s -X POST ${SRV}/action/card-move`);
  expect(p).toContain(`curl -s -X POST ${SRV}/action/card-comment`);
  expect(p).toContain(`"cardId":"${id}"`);
  expect(p).toContain('"toColumnId":"in-progress"');
});

test("cardTaskPrompt says how to recover when the card has no assignee yet", () => {
  // A spawn's self-assign can fail or lag, so an "as":"assignee" write can be
  // refused with 400 "card has no assignee to sign as". The footer must say
  // what to do instead of leaving the agent to reverse-engineer the error.
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  const expected = [
    'If a call signed "as":"assignee" is rejected with "card has no',
    'assignee to sign as", resend the same call with "author":"<your name>"',
    'in place of "as":"assignee".',
  ].join("\n");
  // A placeholder even when the name is known: a baked-in name goes stale on
  // a rename, the same reason the commands sign "as":"assignee".
  expect(cardTaskPrompt(b, id, SRV, "MORROW")).toContain(expected);
  expect(cardTaskPrompt(b, id, SRV, "MORROW")).not.toContain('"author":"MORROW"');
  expect(cardTaskPrompt(b, id, SRV)).toContain(expected);
});

test("cardTaskPrompt forbids editing the board file directly", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  expect(p).toContain("never edit the board file directly");
});

test("cardTaskPrompt names the agent so its comments match its desk", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV, "VOLT");
  expect(p).toContain("assigned agent on this card, VOLT");
});

test("cardTaskPrompt without a name (spawning) still signs as the assignee", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  expect(p).toContain("assigned agent on this card.");
  expect(p).toContain('"as":"assignee"');
});

test("cardTaskPrompt demands the move happen first and comments along the way", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  expect(p).toContain("STEP 1, before any other work");
  expect(p).toContain("not in one write at the end");
});

test("cardTaskPrompt scopes the agent to its own card and constraints", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  expect(p).toContain("work ONLY this card");
  expect(p).toContain("This task replaces anything");
  expect(p).toContain("do not commit");
});

test("cardTaskPrompt offers the MCP tools as an alternative to the curls", () => {
  const b = addCard(defaultBoard(), "backlog", "Fix it");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  expect(p).toContain("mcp__the-line__");
  // still ASCII-safe for the trip through the pty
  expect(/^[\x00-\x7f]*$/.test(p)).toBe(true);
});

test("restoreCard puts a deleted card back at its old position, comments intact", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = addCard(b, col, "a");
  b = addCard(b, col, "b");
  b = addCard(b, col, "c");
  const b2 = b.cards.find((x) => x.title === "b")!;
  b = addComment(b, b2.id, "PROBE", "worth keeping");
  const doomed = b.cards.find((x) => x.id === b2.id)!;
  const index = b.cards.filter((x) => x.columnId === col).findIndex((x) => x.id === doomed.id);

  b = deleteCard(b, doomed.id);
  b = restoreCard(b, doomed, index);

  expect(b.cards.filter((x) => x.columnId === col).map((x) => x.title)).toEqual(["a", "b", "c"]);
  expect(b.cards.find((x) => x.id === doomed.id)!.comments).toHaveLength(1);
});

test("restoreCard is a no-op when the card id is already on the board", () => {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = addCard(b, col, "only");
  const card = b.cards[0]!;
  b = restoreCard(b, card, 0);
  expect(b.cards).toHaveLength(1);
});

test("restoreCard drops a card whose column has since been deleted", () => {
  let b = defaultBoard();
  const col = b.columns[1]!.id;
  b = addCard(b, col, "orphan");
  const card = b.cards[0]!;
  b = deleteCard(b, card.id);
  b = deleteColumn(b, col);
  b = restoreCard(b, card, 0);
  expect(b.cards).toHaveLength(0);
});

test("restoreColumn puts a deleted column back at its index with its cards", () => {
  let b = defaultBoard();
  const col = b.columns[1]!;
  b = addCard(b, col.id, "one");
  b = addCard(b, col.id, "two");
  const cards = b.cards.filter((c) => c.columnId === col.id);

  b = deleteColumn(b, col.id);
  expect(b.cards).toHaveLength(0);

  b = restoreColumn(b, col, 1, cards);
  expect(b.columns.map((c) => c.id)).toEqual(defaultBoard().columns.map((c) => c.id));
  expect(b.cards.map((c) => c.title)).toEqual(["one", "two"]);
});

test("restoreColumn is a no-op when that column id is back already", () => {
  const b = defaultBoard();
  const col = b.columns[0]!;
  const out = restoreColumn(b, col, 0, []);
  expect(out.columns).toHaveLength(b.columns.length);
});

// cardMoveTarget: where a card goes when someone moves it with the keyboard.
// Drag-and-drop is mouse-only, so this is the path for keyboard and touch users.

function threeColumnBoard(): { b: Board; col: string; next: string } {
  let b = defaultBoard();
  const col = b.columns[0]!.id;
  b = addCard(b, col, "a");
  b = addCard(b, col, "b");
  b = addCard(b, col, "c");
  return { b, col, next: b.columns[1]!.id };
}

test("cardMoveTarget moves a card to the next column, keeping its row when it fits", () => {
  let { b, next } = threeColumnBoard();
  // Give the target column two rows, so row 1 is a real position there.
  b = addCard(b, next, "n0");
  b = addCard(b, next, "n1");
  const mid = b.cards.find((c) => c.title === "b")!.id;
  expect(cardMoveTarget(b, mid, "right")).toEqual({ toColumnId: next, toIndex: 1 });
  expect(cardMoveTarget(b, mid, "left")).toBeNull(); // already in the first column
});

test("cardMoveTarget reorders within a column and stops at the ends", () => {
  const { b, col } = threeColumnBoard();
  const first = b.cards.find((c) => c.title === "a")!.id;
  const last = b.cards.find((c) => c.title === "c")!.id;
  expect(cardMoveTarget(b, first, "down")).toEqual({ toColumnId: col, toIndex: 1 });
  expect(cardMoveTarget(b, first, "up")).toBeNull();   // already at the top
  expect(cardMoveTarget(b, last, "down")).toBeNull();  // already at the bottom
});

test("cardMoveTarget lands past the end of a shorter column rather than vanishing", () => {
  let b = defaultBoard();
  const from = b.columns[0]!.id;
  const to = b.columns[1]!.id;
  b = addCard(b, from, "x");
  b = addCard(b, from, "y");
  b = addCard(b, from, "z");
  const third = b.cards.find((c) => c.title === "z")!.id;
  // Row 2 of an empty target column: clamped to the end, not left dangling.
  expect(cardMoveTarget(b, third, "right")).toEqual({ toColumnId: to, toIndex: 0 });
});

test("cardMoveTarget returns null for an unknown card", () => {
  const { b } = threeColumnBoard();
  expect(cardMoveTarget(b, "card_nope", "right")).toBeNull();
});

// ---- column stages: what a column MEANS, not where it sits ---------------
// The footer used to be positional (the column after this one is where work
// happens, the one after that is where it lands). A card re-sent from In
// Progress was therefore told to move to Review before starting, and a board
// with columns added after Done broke every "the one before last" rule. Each
// column now carries an explicit stage the protocol keys off.

test("defaultBoard marks its columns with the four stages", () => {
  expect(defaultBoard().columns.map((c) => c.stage)).toEqual(["todo", "doing", "review", "done"]);
});

test("sanitizeColumn keeps a valid stage and drops an unknown one", () => {
  expect(sanitizeColumn({ id: "x", name: "X", stage: "doing" })!.stage).toBe("doing");
  expect(sanitizeColumn({ id: "x", name: "X", stage: "bogus" })!.stage).toBeUndefined();
});

test("sanitizeColumn infers a stage from the stock column ids (migrates old boards)", () => {
  expect(sanitizeColumn({ id: "backlog", name: "B" })!.stage).toBe("todo");
  expect(sanitizeColumn({ id: "in-progress", name: "B" })!.stage).toBe("doing");
  expect(sanitizeColumn({ id: "review", name: "B" })!.stage).toBe("review");
  expect(sanitizeColumn({ id: "done", name: "B" })!.stage).toBe("done");
  expect(sanitizeColumn({ id: "col_abc", name: "Merged" })!.stage).toBeUndefined();
});

test("setColumnStage sets or clears a column's stage", () => {
  let b = addColumn(defaultBoard(), "Merged");
  const id = b.columns[4]!.id;
  b = setColumnStage(b, id, "done");
  expect(b.columns[4]!.stage).toBe("done");
  b = setColumnStage(b, id, null);
  expect(b.columns[4]!.stage).toBeUndefined();
});

test("stageColumn finds the first column of a stage, and isDoneColumn keys off the stage", () => {
  let b = addColumn(defaultBoard(), "Merged");
  const merged = b.columns[4]!.id;
  expect(stageColumn(b, "done")!.id).toBe("done");
  expect(isDoneColumn(b, "done")).toBe(true);
  expect(isDoneColumn(b, merged)).toBe(false);
  b = setColumnStage(b, merged, "done");
  expect(isDoneColumn(b, merged)).toBe(true);
});

test("cardTaskPrompt keys start and finish off the stages, not the positions", () => {
  // A Triage column wedged in after Backlog: positionally it would be "start".
  let b = defaultBoard();
  b = { ...b, columns: [b.columns[0]!, { id: "triage", name: "Triage", instruction: "" }, ...b.columns.slice(1)] };
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  expect(p).toContain('move this card to "in-progress"');
  expect(p).toContain('{"toColumnId":"review"}');
  expect(p).not.toContain('"triage"');
});

test("cardTaskPrompt re-sent to a card already in the doing stage tells it to stay put", () => {
  let b = addCard(defaultBoard(), "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  b = moveCard(b, id, "in-progress");
  const p = cardTaskPrompt(b, id, SRV);
  expect(p).not.toContain('move this card to "review"');
  expect(p).toContain('already in "in-progress"');
  expect(p).toContain('{"toColumnId":"review"}'); // finishing still lands in review
});

test("cardTaskPrompt re-sent to a card in review sends it back to the doing stage", () => {
  let b = addCard(defaultBoard(), "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  b = moveCard(b, id, "review");
  const p = cardTaskPrompt(b, id, SRV);
  expect(p).toContain('move this card to "in-progress"');
});

test("cardTaskPrompt lands in done when the board has no review stage", () => {
  let b = defaultBoard();
  b = deleteColumn(b, "review");
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV);
  expect(p).toContain('{"toColumnId":"done"}');
});

test("cardTaskPrompt falls back to positions on a board with no stages at all", () => {
  const b: Board = {
    columns: [{ id: "a", name: "A", instruction: "" }, { id: "b", name: "B", instruction: "" }, { id: "c", name: "C", instruction: "" }],
    cards: [{ id: "k", title: "T", columnId: "a" }],
  };
  const p = cardTaskPrompt(b, "k", SRV);
  expect(p).toContain('move this card to "b"');
  expect(p).toContain('{"toColumnId":"c"}');
});

test("cardTaskPrompt signs writes as the card's assignee, never a typed name", () => {
  const b = addCard(defaultBoard(), "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, SRV, "VOLT");
  expect(p).toContain('"as":"assignee"');
  expect(p).not.toContain('"author":"VOLT"');
  // The commands themselves carry no typed name or placeholder; only the
  // no-assignee fallback line mentions "author".
  for (const cmd of p.split("\n").filter((l) => l.includes("curl -s -X POST"))) {
    expect(cmd).not.toContain('"author"');
    expect(cmd).not.toContain("<your name>");
  }
  expect(p).toContain("assigned agent on this card, VOLT");
});

// ---- crew on the assignee, and the footer for a returning agent -------------

test("sanitizeBoard keeps a well-formed crew id on an assignee and drops a bad one", () => {
  const sid = "502d0e8c-8790-4804-b767-0549edfc959c";
  const b = sanitizeBoard({
    columns: [{ id: "c", name: "C", instruction: "" }],
    cards: [
      { id: "k1", title: "a", columnId: "c", assignee: { id: sid, name: "RIPLEY", crew: "ripley-3f2a" } },
      { id: "k2", title: "b", columnId: "c", assignee: { id: sid, name: "RIPLEY", crew: "../x" } },
      { id: "k3", title: "c", columnId: "c", assignee: { id: sid, name: "RIPLEY" } },
    ],
  });
  expect(b.cards[0]!.assignee).toEqual({ id: sid, name: "RIPLEY", crew: "ripley-3f2a" });
  expect(b.cards[1]!.assignee).toEqual({ id: sid, name: "RIPLEY" });
  expect(b.cards[2]!.assignee).toEqual({ id: sid, name: "RIPLEY" });
});

test("cardTaskPrompt sends a returning agent to its own comments first, and only then", () => {
  const b = { columns: [{ id: "todo", name: "Todo", instruction: "" }], cards: [{ id: "k1", title: "T", columnId: "todo" }] };
  const again = cardTaskPrompt(b, "k1", "http://x", "RIPLEY", { workedBefore: true });
  expect(again).toContain("You have worked this card before");
  expect(/^[\x00-\x7f]*$/.test(again)).toBe(true);
  expect(cardTaskPrompt(b, "k1", "http://x", "RIPLEY")).not.toContain("worked this card before");
});

test("scrum cards: kind survives sanitizing, one per project is findable", () => {
  expect(sanitizeCard({ id: "k", title: "S", columnId: "backlog", kind: "scrum" })?.kind).toBe("scrum");
  expect(sanitizeCard({ id: "k", title: "S", columnId: "backlog", kind: "boss" })).toEqual({ id: "k", title: "S", columnId: "backlog" });
  let b = addCard(defaultBoard(), "backlog", "Scrum");
  const id = b.cards[0]!.id;
  b = setCardRepo(setCardKind(b, id, "scrum"), id, "shop");
  expect(findScrumCard(b, "shop")?.id).toBe(id);
  expect(findScrumCard(b, "blog")).toBeUndefined();
  expect(findScrumCard(b, undefined)).toBeUndefined();
  expect(setCardKind(b, id, null).cards[0]!.kind).toBeUndefined();
});

test("scrumBrief names the project, or asks for one", () => {
  expect(scrumBrief("shop", "/src/shop")).toContain("You are the scrum master for **shop** (`/src/shop`).");
  expect(scrumBrief("shop")).toContain("for **shop**.");
  expect(scrumBrief(undefined)).toContain("(name the project here)");
  expect(scrumBrief("shop")).toContain("backlog");
});

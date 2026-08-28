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
  reorderColumn,
  addCard,
  renameCard,
  deleteCard,
  moveCard,
  setCardDescription,
  assignCard,
  addComment,
  deleteComment,
  cardTaskText,
  commentNotifyText,
  cardTaskPrompt,
  readBoard,
  writeBoard,
  type Board,
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
  expect(raw.version).toBe(3);
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

// ---- commentNotifyText: the message pushed to a card's assigned agent ------

test("commentNotifyText labels the comment with the card title", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "Fix login bug");
  const id = b.cards[0]!.id;
  expect(commentNotifyText(b, id, "please cover the SSO case")).toBe(
    '💬 New comment on "Fix login bug":\nplease cover the SSO case',
  );
});

test("commentNotifyText trims the comment body", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "Card A");
  const id = b.cards[0]!.id;
  expect(commentNotifyText(b, id, "  hi  ")).toBe('💬 New comment on "Card A":\nhi');
});

test("commentNotifyText returns empty string for a blank comment", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "Card A");
  expect(commentNotifyText(b, b.cards[0]!.id, "   ")).toBe("");
});

test("commentNotifyText returns empty string for an unknown card", () => {
  expect(commentNotifyText(defaultBoard(), "nope", "hello")).toBe("");
});

test("commentNotifyText falls back to a placeholder for an untitled card", () => {
  let b = defaultBoard();
  b = addCard(b, b.columns[0]!.id, "temp");
  const id = b.cards[0]!.id;
  b = renameCard(b, id, "   ");
  expect(commentNotifyText(b, id, "note")).toBe('💬 New comment on "(untitled card)":\nnote');
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

test("cardTaskPrompt starts with the plain task text", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  expect(cardTaskPrompt(b, id, "/tmp/.line.json").startsWith(cardTaskText(b, id))).toBe(true);
});

test("cardTaskPrompt names the card, the board file, and the column flow", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  const p = cardTaskPrompt(b, id, "/Users/me/.agent-status/.line.json");
  expect(p).toContain(id);
  expect(p).toContain("/Users/me/.agent-status/.line.json");
  expect(p).toContain("backlog → in-progress → review → done");
  expect(p).toContain('you are in: "backlog"');
});

test("cardTaskPrompt reflects the card's current column", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  b = moveCard(b, id, "review");
  expect(cardTaskPrompt(b, id, "/tmp/.line.json")).toContain('you are in: "review"');
});

test("cardTaskPrompt returns empty string for an unknown card", () => {
  expect(cardTaskPrompt(defaultBoard(), "nope", "/tmp/.line.json")).toBe("");
});

test("cardTaskPrompt names where to start and where to land, positionally", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const id = b.cards[0]!.id;
  const p = cardTaskPrompt(b, id, "/tmp/.line.json");
  expect(p).toContain('columnId\nto "in-progress"');
  expect(p).toContain('set columnId to\n"review"');
});

test("cardTaskPrompt clamps to the last column when there's nowhere further", () => {
  let b = defaultBoard();
  b = addCard(b, "done", "Fix login bug");
  const id = b.cards[0]!.id;
  const p = cardTaskPrompt(b, id, "/tmp/.line.json");
  // last column: both the start and the finish clamp to where it already is
  expect(p).toContain('columnId\nto "done"');
  expect(p).toContain('set columnId to\n"done"');
});

test("cardTaskPrompt names the agent so its comments match its desk", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, "/tmp/.line.json", "VOLT");
  expect(p).toContain("assigned agent on this card, VOLT");
  expect(p).toContain('"author": "VOLT"');
});

test("cardTaskPrompt falls back to a placeholder author when spawning", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, "/tmp/.line.json");
  expect(p).toContain('"author": "<your agent name>"');
});

test("cardTaskPrompt demands the move happen first, as its own write", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, "/tmp/.line.json");
  expect(p).toContain("STEP 1, before any other work");
  expect(p).toContain("as its own write");
  expect(p).toContain("not in one write at the end");
  // and it must Read before Edit, which is what tripped the first real run
  expect(p).toContain("Read the board file before you edit it");
});

test("cardTaskPrompt tells the agent how to write a comment", () => {
  let b = defaultBoard();
  b = addCard(b, "backlog", "Fix login bug");
  const p = cardTaskPrompt(b, b.cards[0]!.id, "/tmp/.line.json");
  expect(p).toContain('"comments"');
  expect(p).toContain('"author"');
  expect(p).toContain('"columnId"');
});

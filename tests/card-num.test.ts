// Card numbers ("#42"): handed out once from the board's counter, never reused,
// and given to cards from before numbers existed by numberCards.
import { test, expect } from "bun:test";
import { addCard, deleteCard, deleteColumn, restoreColumn, sanitizeBoard, defaultBoard, addComment, nextCardNum, cardTaskFooter } from "../src/lib/board";
import { numberCards } from "../src/lib/archive";

test("addCard numbers cards 1, 2, 3 and moves the counter on", () => {
  let b = addCard(defaultBoard(), "backlog", "a");
  b = addCard(b, "backlog", "b");
  expect(b.cards.map((k) => k.num)).toEqual([1, 2]);
  expect(b.nextNum).toBe(3);
});

test("a deleted card's number is not handed out again", () => {
  let b = addCard(addCard(defaultBoard(), "backlog", "a"), "backlog", "b");
  b = deleteCard(b, b.cards[1]!.id);
  b = addCard(b, "backlog", "c");
  expect(b.cards.map((k) => k.num)).toEqual([1, 3]);
});

test("deleting and restoring a column keeps the counter", () => {
  let b = addCard(defaultBoard(), "review", "a");
  const col = b.columns.find((c) => c.id === "review")!;
  const cards = b.cards;
  b = deleteColumn(b, "review");
  expect(b.nextNum).toBe(2);
  b = restoreColumn(b, col, 2, cards);
  expect(b.nextNum).toBe(2);
  expect(addCard(b, "backlog", "x").cards.at(-1)!.num).toBe(2);
});

test("the counter never falls behind a number already on the board", () => {
  const b = sanitizeBoard({ ...defaultBoard(), cards: [{ id: "card_x", title: "x", columnId: "backlog", num: 9 }], nextNum: 3 });
  expect(nextCardNum(b)).toBe(10);
});

test("sanitizeBoard keeps good numbers and drops bad ones", () => {
  const b = sanitizeBoard({
    ...defaultBoard(),
    nextNum: "7",
    cards: [
      { id: "card_a", title: "a", columnId: "backlog", num: 4 },
      { id: "card_b", title: "b", columnId: "backlog", num: -1 },
      { id: "card_c", title: "c", columnId: "backlog", num: 1.5 },
    ],
  });
  expect(b.cards.map((k) => k.num)).toEqual([4, undefined, undefined]);
  expect(b.nextNum).toBeUndefined();
});

test("numberCards numbers old cards once, archive included, in the order they were made", () => {
  const bare = (id: string, at?: number) => ({ id, title: id, columnId: "backlog", ...(at ? { comments: [{ id: `m${id}`, author: "x", text: "t", at }] } : {}) });
  const board = { ...defaultBoard(), cards: [bare("card_new", 300), bare("card_mid", 200)] };
  const archive = { cards: [{ ...bare("card_old", 100), archivedAt: 400 }] };
  const out = numberCards(board, archive);
  expect(out.changed).toBe(true);
  expect(out.archive.cards[0]!.num).toBe(1);
  expect(out.board.cards.map((k) => [k.id, k.num])).toEqual([["card_new", 3], ["card_mid", 2]]);
  expect(out.board.nextNum).toBe(4);
  // run again: nothing to do
  expect(numberCards(out.board, out.archive).changed).toBe(false);
});

test("numberCards never reuses a number an archived card holds", () => {
  // a board from before the counter: #1 on the board, #2 archived, one unnumbered
  const board = { ...defaultBoard(), cards: [
    { id: "card_a", title: "a", columnId: "backlog", num: 1 },
    { id: "card_z", title: "z", columnId: "backlog" },
  ] };
  const archive = { cards: [{ id: "card_b", title: "b", columnId: "done", num: 2, archivedAt: 1 }] };
  const out = numberCards(board, archive);
  expect(out.board.cards[1]!.num).toBe(3);
  expect(out.board.nextNum).toBe(4);
});

test("numberCards gives a card found in both files one number", () => {
  const card = { id: "card_dup", title: "d", columnId: "backlog" };
  const out = numberCards({ ...defaultBoard(), cards: [card] }, { cards: [{ ...card, archivedAt: 1 }] });
  expect(out.board.cards[0]!.num).toBe(out.archive.cards[0]!.num);
  expect(out.board.nextNum).toBe(2);
});

test("the task footer names the card's number next to its id", () => {
  const b = addComment(addCard(defaultBoard(), "backlog", "a"), "x", "y", "z");
  const id = b.cards[0]!.id;
  expect(cardTaskFooter(b, id, "http://localhost:4173")).toContain(`card: ${id} (#1)`);
});

test("the MCP board and card text show the number beside the id", async () => {
  const { formatBoard, formatCard } = await import("../src/lib/mcp");
  const b = addCard(defaultBoard(), "backlog", "a");
  const id = b.cards[0]!.id;
  expect(formatBoard(b)).toContain(`[${id}] #1 a`);
  expect(formatCard(b, id)).toContain(`[${id}] #1 a`);
});

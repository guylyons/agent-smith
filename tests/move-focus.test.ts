// tests/move-focus.test.ts — which card gets focus back after a keyboard move
// across columns, and when that stops. The DOM half (focusing its .card-open)
// was checked in the browser.
import { test, expect } from "bun:test";
import { refocusAfterMove, moveSettled, PENDING_FOCUS_MS } from "../src/ui/moveFocus";

const board = { cards: [{ id: "a", columnId: "doing" }, { id: "b", columnId: "todo" }] } as any;
const note = { cardId: "a", toColumnId: "doing", at: 1000 };

test("refocusAfterMove: the card you moved gets focus back once it lands", () => {
  expect(refocusAfterMove(note, board, true, 1100)).toBe("a");
});

test("refocusAfterMove: a render with no keyboard move of yours never takes focus", () => {
  // An agent's move arriving over SSE: nothing pending, even with focus on the page.
  expect(refocusAfterMove(null, board, true, 1100)).toBeNull();
});

test("refocusAfterMove: focus you still hold, or put elsewhere, is left alone", () => {
  // A refused move (edge column): the button never unmounted, so focus stayed.
  expect(refocusAfterMove(note, board, false, 1100)).toBeNull();
});

test("refocusAfterMove: a card that is gone (deleted meanwhile) gets nothing", () => {
  expect(refocusAfterMove({ ...note, cardId: "zzz" }, board, true, 1100)).toBeNull();
});

test("refocusAfterMove: an old note does nothing", () => {
  expect(refocusAfterMove(note, board, true, 1000 + PENDING_FOCUS_MS + 1)).toBeNull();
});

test("refocusAfterMove: a stale echo that puts the card back a column still refocuses it", () => {
  // Alt+Right twice fast: the first move's echo lands after the second painted.
  const stale = { cards: [{ id: "a", columnId: "todo" }] } as any;
  expect(refocusAfterMove(note, stale, true, 1100)).toBe("a");
  expect(moveSettled(note, stale, 1100)).toBe(false);
});

test("moveSettled: once the server has the card where it was sent, or it is gone, or too old", () => {
  expect(moveSettled(note, board, 1100)).toBe(true);
  expect(moveSettled({ ...note, cardId: "zzz" }, board, 1100)).toBe(true);
  expect(moveSettled({ ...note, toColumnId: "done" }, board, 1000 + PENDING_FOCUS_MS + 1)).toBe(true);
  expect(moveSettled(null, board, 1100)).toBe(true);
});

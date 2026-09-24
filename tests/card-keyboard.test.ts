// tests/card-keyboard.test.ts — a board card's keyboard rule and accessible
// name, DOM-free. The markup side (open button and ✕ as siblings, so Enter on
// the ✕ can't bubble into "open") was checked in the browser.
import { test, expect } from "bun:test";
import { cardKeyMove, cardName } from "../src/ui/TheLine";

const key = (k: string, o: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) =>
  ({ key: k, altKey: false, metaKey: false, ctrlKey: false, ...o });

test("cardKeyMove: Alt+arrows on the card move it", () => {
  expect(cardKeyMove(key("ArrowLeft", { altKey: true }), true)).toBe("left");
  expect(cardKeyMove(key("ArrowRight", { altKey: true }), true)).toBe("right");
  expect(cardKeyMove(key("ArrowUp", { altKey: true }), true)).toBe("up");
  expect(cardKeyMove(key("ArrowDown", { altKey: true }), true)).toBe("down");
});

test("cardKeyMove: a key that bubbled up from inside the card is left alone", () => {
  expect(cardKeyMove(key("ArrowLeft", { altKey: true }), false)).toBeNull();
});

test("cardKeyMove: Enter, Space, plain arrows and Cmd/Ctrl+Alt do nothing", () => {
  expect(cardKeyMove(key("Enter"), true)).toBeNull();
  expect(cardKeyMove(key(" "), true)).toBeNull();
  expect(cardKeyMove(key("ArrowLeft"), true)).toBeNull();
  expect(cardKeyMove(key("ArrowLeft", { altKey: true, metaKey: true }), true)).toBeNull();
  expect(cardKeyMove(key("ArrowLeft", { altKey: true, ctrlKey: true }), true)).toBeNull();
  expect(cardKeyMove(key("a", { altKey: true }), true)).toBeNull();
});

test("cardName: title and staffing, never the delete button", () => {
  const card = { title: "budget.el hardening", kind: undefined, assignee: { id: "s", name: "RIPLEY-2" } } as any;
  expect(cardName(card, "live", 0, 0)).toBe("budget.el hardening, RIPLEY-2");
  expect(cardName(card, "ended", 0, 0)).toBe("budget.el hardening, RIPLEY-2 (session ended)");
  expect(cardName({ ...card, assignee: null }, "none", 0, 0)).toBe("budget.el hardening, unassigned");
  expect(cardName(card, "live", 0, 1)).not.toContain("Delete");
});

test("cardName: says what's new, or how many comments there are", () => {
  const card = { title: "", kind: "scrum", assignee: null } as any;
  expect(cardName(card, "none", 2, 5)).toBe("Untitled, scrum master, unassigned, 2 new comments");
  expect(cardName(card, "none", 0, 1)).toBe("Untitled, scrum master, unassigned, 1 comment");
});

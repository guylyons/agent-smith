// tests/dialog-focus.test.ts — where Tab goes inside a modal dialog, DOM-free.
import { test, expect } from "bun:test";
import { escCloses, returnTarget, trapIndex } from "../src/ui/Backdrop";
import { paletteStatus } from "../src/ui/CommandPalette";

test("trapIndex: Tab on the last control wraps to the first", () => {
  expect(trapIndex(4, 3, false)).toBe(0);
});

test("trapIndex: Shift+Tab on the first control wraps to the last", () => {
  expect(trapIndex(4, 0, true)).toBe(3);
});

test("trapIndex: in the middle the browser moves focus as usual", () => {
  expect(trapIndex(4, 1, false)).toBeNull();
  expect(trapIndex(4, 2, true)).toBeNull();
});

test("trapIndex: focus on none of the controls goes to the first (or last on Shift+Tab)", () => {
  expect(trapIndex(4, -1, false)).toBe(0);
  expect(trapIndex(4, -1, true)).toBe(3);
});

test("trapIndex: a single control keeps focus on itself both ways", () => {
  expect(trapIndex(1, 0, false)).toBe(0);
  expect(trapIndex(1, 0, true)).toBe(0);
});

test("trapIndex: nothing tabbable -> leave it to the browser", () => {
  expect(trapIndex(0, -1, false)).toBeNull();
});

const esc = (over: Partial<{ key: string; defaultPrevented: boolean; isComposing: boolean }> = {}) =>
  ({ key: "Escape", defaultPrevented: false, isComposing: false, ...over });

test("escCloses: Esc closes the top dialog", () => {
  expect(escCloses(esc(), true)).toBe(true);
});

test("escCloses: a dialog underneath another stays open", () => {
  expect(escCloses(esc(), false)).toBe(false);
});

test("escCloses: other keys never close", () => {
  expect(escCloses(esc({ key: "Tab" }), true)).toBe(false);
  expect(escCloses(esc({ key: "Enter" }), true)).toBe(false);
});

test("escCloses: Esc already handled inside (e.g. an open picker) is left alone", () => {
  expect(escCloses(esc({ defaultPrevented: true }), true)).toBe(false);
});

test("escCloses: Esc that cancels an IME composition doesn't close", () => {
  expect(escCloses(esc({ isComposing: true }), true)).toBe(false);
});

// A stand-in for an element: returnTarget only asks whether it's still on the page.
const el = (name: string, isConnected = true) => ({ name, isConnected });

test("returnTarget: focus goes back to the opener when it's still there", () => {
  const opener = el("card button");
  expect(returnTarget(true, [opener, el("fallback")])).toBe(opener);
});

test("returnTarget: an opener that unmounted (a FIND row) falls back to the card's button", () => {
  const card = el("card button");
  expect(returnTarget(true, [el("palette input", false), card])).toBe(card);
});

test("returnTarget: a card that changed column is found by its fresh button", () => {
  const moved = el("button in new column");
  expect(returnTarget(true, [el("button in old column", false), moved, el("dialog below")])).toBe(moved);
});

test("returnTarget: with no opener and no card button, the dialog underneath gets focus", () => {
  const below = el("card modal's first control");
  expect(returnTarget(true, [null, undefined, below])).toBe(below);
  expect(returnTarget(true, [el("palette input", false), null, below])).toBe(below);
});

test("returnTarget: nothing left on the page -> leave focus alone", () => {
  expect(returnTarget(true, [el("gone", false), null, undefined])).toBeNull();
});

test("returnTarget: focus someone else already took (a dialog opening as this closes) stays put", () => {
  expect(returnTarget(false, [el("opener")])).toBeNull();
});

test("paletteStatus: silent while browsing, a count once there's a query", () => {
  expect(paletteStatus(12, "")).toBe("");
  expect(paletteStatus(12, "   ")).toBe("");
  expect(paletteStatus(1, "smith")).toBe("1 result");
  expect(paletteStatus(3, "smith")).toBe("3 results");
  expect(paletteStatus(0, "zzz")).toBe("Nothing found.");
});

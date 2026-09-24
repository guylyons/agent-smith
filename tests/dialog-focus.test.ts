// tests/dialog-focus.test.ts — where Tab goes inside a modal dialog, DOM-free.
import { test, expect } from "bun:test";
import { escCloses, trapIndex } from "../src/ui/Backdrop";

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

// tests/stack-cap.test.ts
import { test, expect } from "bun:test";
import { stackMaxHeight } from "../src/ui/stackCap";
import { loadLineRows, KEYS, LINE_ROWS_DEFAULT, LINE_ROWS_OFF } from "../src/ui/settings";

const same = (n: number, h: number) => Array.from({ length: n }, () => h);

test("a stack at or under the cap is left alone", () => {
  expect(stackMaxHeight(same(6, 44), 6, 6)).toBeNull();
  expect(stackMaxHeight(same(2, 44), 6, 6)).toBeNull();
  expect(stackMaxHeight([], 6, 6)).toBeNull();
});

test("a taller stack is cut after the Nth card, gaps included", () => {
  // 6 cards of 44 + 5 gaps of 6 = 294
  expect(stackMaxHeight(same(9, 44), 6, 6)).toBe(294);
});

test("the cut follows the real card heights, not an average", () => {
  // tall cards (a wrapped title, a meta row) first: 3x80 + 2x6 = 252
  expect(stackMaxHeight([80, 80, 80, 40, 40, 40], 3, 6)).toBe(252);
  // the same cards the other way up cut much shorter
  expect(stackMaxHeight([40, 40, 40, 80, 80, 80], 3, 6)).toBe(132);
});

test("the container's own padding is added, so N cards actually fit", () => {
  expect(stackMaxHeight(same(9, 44), 6, 6, 10)).toBe(304);
});

test("a peek leaves a sliver of the next card showing", () => {
  expect(stackMaxHeight(same(9, 44), 6, 6, 0, 10)).toBe(304);
  // ...but never more of it than there is: a 2px card under a 6px gap caps the
  // sliver at 8, not the 10 asked for.
  expect(stackMaxHeight([...same(6, 44), 2], 6, 6, 0, 10)).toBe(302);
});

test("no cap when rows is off or nonsense", () => {
  expect(stackMaxHeight(same(9, 44), 0, 6)).toBeNull();
  expect(stackMaxHeight(same(9, 44), -3, 6)).toBeNull();
  expect(stackMaxHeight(same(9, 44), NaN, 6)).toBeNull();
});

test("the saved setting is clamped, and junk falls back to off/default", () => {
  const store = new Map<string, string>();
  // @ts-expect-error minimal localStorage stand-in for the setting reader
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };

  expect(loadLineRows()).toBe(LINE_ROWS_DEFAULT); // unset
  store.set(KEYS.lineRows, "99");
  expect(loadLineRows()).toBe(12);
  store.set(KEYS.lineRows, "1");
  expect(loadLineRows()).toBe(3);                 // below the offered range
  store.set(KEYS.lineRows, "0");
  expect(loadLineRows()).toBe(LINE_ROWS_OFF);     // 0 is the OFF end of the slider
  store.set(KEYS.lineRows, "banana");
  expect(loadLineRows()).toBe(LINE_ROWS_DEFAULT);
});

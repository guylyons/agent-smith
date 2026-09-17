// tests/drawer-size.test.ts — the drawer's own width and text size: the values
// the resize handle and the A−/A+ buttons write, read back from localStorage.
import { test, expect } from "bun:test";
import {
  clampDrawerWidth, clampDrawerFont, loadDrawerWidth, loadDrawerFont, KEYS,
  DRAWER_W_MIN, DRAWER_W_MAX, DRAWER_W_DEFAULT,
  DRAWER_FONT_MIN, DRAWER_FONT_MAX, DRAWER_FONT_DEFAULT,
} from "../src/ui/settings";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage stand-in for the setting readers
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
};

test("a drag is clamped to a width the drawer stays usable at", () => {
  expect(clampDrawerWidth(700)).toBe(700);
  expect(clampDrawerWidth(10)).toBe(DRAWER_W_MIN);      // dragged off the right edge
  expect(clampDrawerWidth(99_999)).toBe(DRAWER_W_MAX);  // dragged past the left edge
  expect(clampDrawerWidth(612.4)).toBe(612);            // pointer coords are fractional
});

test("a nonsense width falls back to the default rather than the minimum", () => {
  expect(clampDrawerWidth(NaN)).toBe(DRAWER_W_DEFAULT);
  expect(clampDrawerWidth(Infinity)).toBe(DRAWER_W_DEFAULT);
});

test("the text size is clamped to the range the A−/A+ buttons offer", () => {
  expect(clampDrawerFont(18)).toBe(18);
  expect(clampDrawerFont(4)).toBe(DRAWER_FONT_MIN);
  expect(clampDrawerFont(400)).toBe(DRAWER_FONT_MAX);
  expect(clampDrawerFont(NaN)).toBe(DRAWER_FONT_DEFAULT);
});

test("unset, blank and junk all read as the shipped defaults", () => {
  store.clear();
  expect(loadDrawerWidth()).toBe(DRAWER_W_DEFAULT);
  expect(loadDrawerFont()).toBe(DRAWER_FONT_DEFAULT);
  // A blank value parses as 0, which must not clamp to the narrowest drawer.
  store.set(KEYS.drawerWidth, "");
  store.set(KEYS.drawerFont, "   ");
  expect(loadDrawerWidth()).toBe(DRAWER_W_DEFAULT);
  expect(loadDrawerFont()).toBe(DRAWER_FONT_DEFAULT);
  store.set(KEYS.drawerWidth, "banana");
  store.set(KEYS.drawerFont, "banana");
  expect(loadDrawerWidth()).toBe(DRAWER_W_DEFAULT);
  expect(loadDrawerFont()).toBe(DRAWER_FONT_DEFAULT);
});

test("a stored value out of range is pulled back in, not honoured", () => {
  store.set(KEYS.drawerWidth, "5000");
  store.set(KEYS.drawerFont, "2");
  expect(loadDrawerWidth()).toBe(DRAWER_W_MAX);
  expect(loadDrawerFont()).toBe(DRAWER_FONT_MIN);
});

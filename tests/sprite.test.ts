import { test, expect } from "bun:test";
import { spriteRects, paletteFor } from "../src/ui/sprite-data";

test("paletteFor is deterministic per sessionId", () => {
  expect(paletteFor("abc", "General")).toEqual(paletteFor("abc", "General"));
});
test("paletteFor returns a palette and a gear", () => {
  const p = paletteFor("aaa", "General");
  expect(typeof p.gear).toBe("string");
  expect(p.palette).toHaveProperty("O");
});
test("spriteRects returns pixels", () => {
  const { palette, gear } = paletteFor("abc", "Component build");
  const rects = spriteRects({ gear, palette });
  expect(rects.length).toBeGreaterThan(50);
  expect(rects[0]).toHaveProperty("fill");
});

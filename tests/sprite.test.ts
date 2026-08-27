import { test, expect } from "bun:test";
import { spriteRects, paletteFor, PALETTES, BODIES, BODY_IDS } from "../src/ui/sprite-data";

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

test("paletteFor defaults to the worker body", () => {
  expect(paletteFor("abc", "General").body).toBe("worker");
});

test("every body is a 24x16 grid", () => {
  for (const id of BODY_IDS) {
    const rows = BODIES[id].rows;
    expect(rows).toHaveLength(24);
    for (const row of rows) expect(row).toHaveLength(16);
  }
});

test("spriteRects draws pixels for every body", () => {
  for (const id of BODY_IDS) {
    const rects = spriteRects({ body: id, gear: "headset", palette: PALETTES[0] });
    expect(rects.length).toBeGreaterThan(50);
    expect(rects[0]).toHaveProperty("fill");
  }
});

test("gear only composites onto bodies that accept it", () => {
  // worker accepts gear; changing gear changes the pixels
  const a = spriteRects({ body: "worker", gear: "headset", palette: PALETTES[0] });
  const b = spriteRects({ body: "worker", gear: "hood", palette: PALETTES[0] });
  expect(a).not.toEqual(b);
  // cat ignores gear; the two are identical regardless of gear
  const c = spriteRects({ body: "cat", gear: "headset", palette: PALETTES[0] });
  const d = spriteRects({ body: "cat", gear: "hood", palette: PALETTES[0] });
  expect(c).toEqual(d);
});

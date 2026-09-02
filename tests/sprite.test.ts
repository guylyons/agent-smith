import { test, expect } from "bun:test";
import { spriteRects, paletteFor, PALETTES, BODIES, BODY_IDS, GEARS, DEFAULT_GEARS, GEAR, NONE_GEAR } from "../src/ui/sprite-data";

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

test("the new accessories are exposed as pickable gear", () => {
  for (const g of ["sunglasses", "spectacles", "laptop", "keyboard", "coffee",
                   "cap", "beanie", "necktie", "phone"]) {
    expect(GEARS).toContain(g);
  }
});

test("a NONE option is offered and renders the bare worker", () => {
  expect(GEARS).toContain(NONE_GEAR);
  // NONE has no overlay, so it must reproduce the plain body exactly.
  const bare = spriteRects({ body: "worker", gear: NONE_GEAR, palette: PALETTES[0] });
  const unknown = spriteRects({ body: "worker", gear: "__no_such_gear__", palette: PALETTES[0] });
  expect(bare).toEqual(unknown);
});

test("every gear id has an overlay definition and vice versa", () => {
  // NONE is deliberately overlay-less (the bare worker); every other gear draws.
  for (const g of GEARS) {
    if (g === NONE_GEAR) continue;
    expect(GEAR[g as keyof typeof GEAR]).toBeDefined();
  }
  for (const g of Object.keys(GEAR)) expect(GEARS).toContain(g);
});

test("every gear overlay row is 16 cells wide and stays on the grid", () => {
  for (const [id, layers] of Object.entries(GEAR)) {
    for (const layer of layers) {
      layer.rows.forEach((row, i) => {
        expect(row).toHaveLength(16);
        // must land within the 24-row body
        expect(layer.at + i).toBeGreaterThanOrEqual(0);
        expect(layer.at + i).toBeLessThan(24);
      });
    }
  }
});

test("each gear composites a visibly different sprite onto the worker", () => {
  const base = spriteRects({ body: "worker", gear: "__none__", palette: PALETTES[0] });
  const seen = new Set<string>();
  for (const g of GEARS) {
    if (g === NONE_GEAR) continue; // NONE is meant to equal the bare body
    const rects = spriteRects({ body: "worker", gear: g, palette: PALETTES[0] });
    const key = JSON.stringify(rects);
    // gear actually changes the sprite...
    expect(key).not.toEqual(JSON.stringify(base));
    // ...and each gear looks distinct from the others
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
});

test("default sprites only ever use the original gear (no drift)", () => {
  // paletteFor must never surface a newly-added accessory as a default,
  // so existing agents' sprites stay stable when the picker list grows.
  for (let i = 0; i < 200; i++) {
    const { gear } = paletteFor(`session-${i}`, "General");
    expect(DEFAULT_GEARS).toContain(gear);
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

// ---- the Alien cast (src/ui/sprite-alien.ts) ----
import { ALIEN_BODIES, BODY_FOR_NAME, bodyForName } from "../src/ui/sprite-alien";
import { ROSTER } from "../src/lib/crew";
import { hasFixedColors } from "../src/ui/sprite-data";

test("every Alien character is a pickable 24x16 body with its own colors", () => {
  for (const [id, body] of Object.entries(ALIEN_BODIES)) {
    expect(BODIES[id]).toBe(body);
    expect(BODY_IDS).toContain(id);
    expect(body.rows).toHaveLength(24);
    for (const row of body.rows) expect(row).toHaveLength(16);
    expect(hasFixedColors(id)).toBe(true);
    // every letter in the grid resolves to a color: nothing silently vanishes
    const rects = spriteRects({ body: id, gear: "none", palette: PALETTES[0] });
    const cells = body.rows.join("").replace(/\./g, "").length;
    expect(rects.length).toBe(cells);
  }
  expect(hasFixedColors("worker")).toBe(false);
});

test("the cast keeps its colors on every palette; the original bodies recolor", () => {
  const xeno = PALETTES.map((p) => JSON.stringify(spriteRects({ body: "xenomorph", gear: "none", palette: p })));
  expect(new Set(xeno).size).toBe(1);
  const worker = PALETTES.map((p) => JSON.stringify(spriteRects({ body: "worker", gear: "none", palette: p })));
  expect(new Set(worker).size).toBe(PALETTES.length);
});

test("every roster name wears a character, and every mapped body exists", () => {
  for (const name of ROSTER) expect(BODY_FOR_NAME[name], name).toBeDefined();
  for (const [name, body] of Object.entries(BODY_FOR_NAME)) expect(ALIEN_BODIES[body], `${name} -> ${body}`).toBeDefined();
});

test("bodyForName matches the first word, any case, and ignores the uniquifier", () => {
  expect(bodyForName("RIPLEY")).toBe("ripley");
  expect(bodyForName("ripley")).toBe("ripley");
  expect(bodyForName("RIPLEY 3f2a")).toBe("ripley");
  expect(bodyForName("  HICKS ")).toBe("marine");
  expect(bodyForName("FORGE")).toBeUndefined();
  expect(bodyForName("")).toBeUndefined();
  expect(bodyForName(undefined)).toBeUndefined();
});

test("paletteFor wears the crew name's character, and the worker without one", () => {
  expect(paletteFor("abc", "General", "VASQUEZ").body).toBe("vasquez");
  expect(paletteFor("abc", "General", "NOSTROMO").body).toBe("xenomorph");
  expect(paletteFor("abc", "General", "FORGE").body).toBe("worker");
  expect(paletteFor("abc", "General").body).toBe("worker");
  // the name changes the body, never the palette or gear
  const a = paletteFor("abc", "General"), b = paletteFor("abc", "General", "RIPLEY");
  expect(b.palette).toBe(a.palette);
  expect(b.gear).toBe(a.gear);
});

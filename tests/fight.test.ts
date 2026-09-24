import { test, expect } from "bun:test";
import {
  createFight, stepFight, resizeFight, stillFight, mulberry32, particleColor, gap, flameRange,
  SCENARIOS, type World,
} from "../src/ui/fight";
import { RIP_FRAMES, XENO_FRAMES, RIP_MUZZLE } from "../src/ui/fight-sprites";

const DT = 1 / 60;

/** Run until `done` or `secs` of fight time pass; returns whether it happened. */
function runUntil(w: World, done: (w: World) => boolean, secs = 60): boolean {
  for (let i = 0; i < secs / DT; i++) {
    stepFight(w, DT);
    if (done(w)) return true;
  }
  return false;
}

test("every sprite frame is a rectangle with a color for every letter", () => {
  for (const f of [...Object.values(RIP_FRAMES), ...Object.values(XENO_FRAMES)]) {
    expect(f.rows).toHaveLength(f.h);
    for (const row of f.rows) {
      expect(row).toHaveLength(f.w);
      for (const ch of row) if (ch !== ".") expect(f.colors[ch]).toBeDefined();
    }
  }
});

test("Ripley's frames share one height and the nozzle sits on her gun", () => {
  const hs = new Set(Object.values(RIP_FRAMES).map((f) => f.h));
  expect(hs.size).toBe(1);
  const f = RIP_FRAMES.stand;
  expect(f.rows[Math.floor(RIP_MUZZLE.y)][RIP_MUZZLE.x - 1]).not.toBe(".");
});

test("the PRNG is seeded and stays in [0,1)", () => {
  const a = mulberry32(7), b = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    expect(v).toBe(b());
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

for (const only of SCENARIOS) {
  test(`the ${only} round plays out and ends with the xenomorph gone`, () => {
    for (const seed of [1, 2, 3]) {
      const w = createFight(400, 32, mulberry32(seed), { only, quick: true });
      expect(runUntil(w, (w) => w.xeno.present, 20)).toBe(true);
      expect(runUntil(w, (w) => w.rip.firing, 20)).toBe(true);
      expect(runUntil(w, (w) => w.rounds === 1, 30)).toBe(true);
      expect(w.xeno.present).toBe(false);
    }
  });
}

test("the flame sets the xenomorph alight", () => {
  const w = createFight(400, 32, mulberry32(5), { only: "flee", quick: true });
  expect(runUntil(w, (w) => w.xeno.burn > 0, 20)).toBe(true);
});

test("rounds keep coming, picked at random, and everyone stays on the strip", () => {
  for (const width of [90, 170, 700]) {
    const w = createFight(width, 32, mulberry32(width), {});
    const seen = new Set<string>();
    runUntil(w, (w) => {
      seen.add(w.scenario);
      expect(w.rip.x).toBeGreaterThanOrEqual(0);
      expect(w.rip.x + RIP_FRAMES.stand.w).toBeLessThanOrEqual(width);
      expect(w.parts.length).toBeLessThanOrEqual(700);
      return false;
    }, 240);
    expect(w.rounds).toBeGreaterThan(5);
    expect(seen.size).toBeGreaterThan(3);
  }
});

test("the xenomorph never ends up inside Ripley while walking in", () => {
  const w = createFight(300, 32, mulberry32(9), { only: "flee", quick: true });
  runUntil(w, (w) => w.rip.firing, 20);
  expect(gap(w)).toBeGreaterThan(0);
});

test("resizing keeps Ripley on a narrower strip", () => {
  const w = createFight(700, 32, mulberry32(3), { quick: true });
  w.rip.x = 650;
  resizeFight(w, 120, 32);
  expect(w.rip.x + RIP_FRAMES.stand.w).toBeLessThanOrEqual(120);
  expect(w.range).toBe(flameRange(120));
});

test("the reduced-motion still is the same frame every time, mid-blast", () => {
  const a = stillFight(300, 32), b = stillFight(300, 32);
  expect(a.rip.firing).toBe(true);
  expect(a.xeno.present).toBe(true);
  expect(a.parts.length).toBeGreaterThan(20);
  expect(a.parts.map((p) => [p.x, p.y])).toEqual(b.parts.map((p) => [p.x, p.y]));
});

test("flame cools from white-hot to red as it ages", () => {
  const p = { kind: "flame" as const, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 1 };
  expect(particleColor(p).color).toBe("#fff8e0");
  expect(particleColor({ ...p, age: 0.6 }).color).toBe("#f2561d");
  expect(particleColor({ ...p, age: 0.99 }).alpha).toBeLessThan(0.1);
});

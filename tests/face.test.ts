import { test, expect } from "bun:test";
import {
  painRow, pickFace, faceTitle,
  SPECIAL_ROW, COL_RED_EYE, COL_GREEN_EYE,
  COL_FORWARD, COL_GRIT, COL_SCREAM, COL_GRIT_ALT,
  IDLE_COLS, type FaceState,
} from "../src/lib/face";

const S = (o: Partial<FaceState> = {}): FaceState => ({
  pct: 0, waiting: 0, working: 1, agents: 1, celebrating: false, ...o,
});

/** A rand() that yields the given values in order, then repeats the last. */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
};

// ---- painRow -------------------------------------------------------------

test("painRow walks the five rows as usage climbs", () => {
  expect(painRow(0)).toBe(0);
  expect(painRow(0.19)).toBe(0);
  expect(painRow(0.2)).toBe(1);
  expect(painRow(0.45)).toBe(2);
  expect(painRow(0.65)).toBe(3);
  expect(painRow(0.85)).toBe(4);
  expect(painRow(1)).toBe(4);
});

test("painRow with no usage data reads as unhurt", () => {
  expect(painRow(null)).toBe(0);
});

test("painRow clamps out-of-range input rather than indexing off the sheet", () => {
  expect(painRow(-1)).toBe(0);
  expect(painRow(4)).toBe(4);
});

// ---- pickFace: row ------------------------------------------------------

test("pickFace takes its row from fleet pain", () => {
  expect(pickFace(S({ pct: 0.65 }), seq(0)).row).toBe(3);
});

// ---- pickFace: mood precedence ------------------------------------------

test("a fleet waiting on you grits its teeth", () => {
  const f = pickFace(S({ waiting: 1 }), seq(0));
  expect([COL_GRIT, COL_GRIT_ALT]).toContain(f.col);
});

test("the grimace alternates so it is not a frozen frame", () => {
  expect(pickFace(S({ waiting: 1 }), seq(0)).col).toBe(COL_GRIT);
  expect(pickFace(S({ waiting: 1 }), seq(0.9)).col).toBe(COL_GRIT_ALT);
});

test("a celebration outranks a grimace", () => {
  // Work landing in DONE is the louder signal — shout, don't scowl.
  const f = pickFace(S({ waiting: 3, celebrating: true }), seq(0));
  expect(f.col).toBe(COL_SCREAM);
});

test("a celebration keeps the pain row — it is a mood, not a heal", () => {
  expect(pickFace(S({ pct: 0.85, celebrating: true }), seq(0)).row).toBe(4);
});

test("an untroubled fleet picks from the idle look frames", () => {
  for (const r of [0, 0.3, 0.5, 0.7, 0.99]) {
    expect(IDLE_COLS).toContain(pickFace(S(), seq(r)).col);
  }
});

test("the idle pool favours looking straight at you", () => {
  const forward = IDLE_COLS.filter((c) => c === COL_FORWARD).length;
  expect(forward).toBeGreaterThan(1);
});

// ---- pickFace: the rare frames ------------------------------------------

test("critical usage pulls the red-eye frame", () => {
  const f = pickFace(S({ pct: 0.96 }), seq(0));
  expect(f).toEqual({ row: SPECIAL_ROW, col: COL_RED_EYE });
});

test("red eyes outrank every other mood", () => {
  const f = pickFace(S({ pct: 0.99, waiting: 2, celebrating: true }), seq(0));
  expect(f.col).toBe(COL_RED_EYE);
});

test("a fully idle fleet occasionally blinks green", () => {
  // Only on the rare roll — the common case stays an ordinary idle look.
  const idle = S({ working: 0, agents: 2 });
  expect(pickFace(idle, seq(0.01))).toEqual({ row: SPECIAL_ROW, col: COL_GREEN_EYE });
  expect(pickFace(idle, seq(0.5)).row).not.toBe(SPECIAL_ROW);
});

test("green eyes need agents present, not merely nothing working", () => {
  // An empty fleet is not idle — there is nobody to be bored.
  expect(pickFace(S({ working: 0, agents: 0 }), seq(0.01)).row).not.toBe(SPECIAL_ROW);
});

test("green eyes never interrupt a fleet that needs you", () => {
  const f = pickFace(S({ working: 0, agents: 2, waiting: 1 }), seq(0.01));
  expect(f.row).not.toBe(SPECIAL_ROW);
});

// ---- every pick is on the sheet -----------------------------------------

test("pickFace only ever lands on a cell the sheet actually has", () => {
  const rowLen = (row: number) => (row === SPECIAL_ROW ? 2 : 7);
  for (const pct of [null, 0, 0.35, 0.75, 0.96]) {
    for (const waiting of [0, 2]) {
      for (const working of [0, 2]) {
        for (const celebrating of [false, true]) {
          for (const r of [0, 0.12, 0.5, 0.99]) {
            const f = pickFace(S({ pct, waiting, working, agents: 2, celebrating }), seq(r));
            expect(f.row).toBeGreaterThanOrEqual(0);
            expect(f.row).toBeLessThan(6);
            expect(f.col).toBeGreaterThanOrEqual(0);
            expect(f.col).toBeLessThan(rowLen(f.row));
          }
        }
      }
    }
  }
});

// ---- faceTitle -----------------------------------------------------------

test("faceTitle explains what the face is reacting to", () => {
  expect(faceTitle(S({ waiting: 2 }))).toContain("2 agents need you");
  expect(faceTitle(S({ waiting: 1 }))).toContain("1 agent needs you");
  expect(faceTitle(S({ pct: 0.5 }))).toContain("50%");
  expect(faceTitle(S({ pct: null }))).toContain("no usage data");
});

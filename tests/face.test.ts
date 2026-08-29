import { test, expect } from "bun:test";
import {
  painRow, pickFace, faceTitle,
  SPECIAL_ROW, COL_RED_EYE, COL_GREEN_EYE,
  COL_FORWARD, COL_FORWARD_ALT, COL_GRIT, COL_GRIT_ALT, COL_SCREAM,
  COL_LOOK_R, COL_LOOK_L,
  type FaceState,
} from "../src/lib/face";

const S = (o: Partial<FaceState> = {}): FaceState => ({
  pct: 0, waiting: 0, working: 1, procs: 0, agents: 1, ...o,
});

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

// ---- the concurrency ladder ----------------------------------------------

test("the mood column climbs the ladder as concurrency rises", () => {
  expect(pickFace(S({ working: 1 })).col).toBe(COL_FORWARD_ALT);
  expect(pickFace(S({ working: 2 })).col).toBe(COL_FORWARD_ALT);
  expect(pickFace(S({ working: 3 })).col).toBe(COL_GRIT);
  expect(pickFace(S({ working: 4 })).col).toBe(COL_GRIT);
  expect(pickFace(S({ working: 5 })).col).toBe(COL_GRIT_ALT);
  expect(pickFace(S({ working: 7 })).col).toBe(COL_GRIT_ALT);
  expect(pickFace(S({ working: 8 })).col).toBe(COL_SCREAM);
  expect(pickFace(S({ working: 40 })).col).toBe(COL_SCREAM);
});

test("subagent processes count toward the load, not just agents", () => {
  // One agent running six subagents is a busy machine, and the face should say
  // so: on the agent count alone it would sit on the bottom rung, barely awake.
  expect(pickFace(S({ working: 1, procs: 0 })).col).toBe(COL_FORWARD_ALT);
  expect(pickFace(S({ working: 1, procs: 6 })).col).toBe(COL_GRIT_ALT);
  expect(pickFace(S({ working: 1, procs: 9 })).col).toBe(COL_SCREAM);
});

test("the face takes its row from fleet pain while the column tracks load", () => {
  const f = pickFace(S({ pct: 0.65, working: 3 }));
  expect(f.row).toBe(3);
  expect(f.col).toBe(COL_GRIT);
});

test("the same fleet state always yields the same face", () => {
  // The whole point of dropping the timer: no re-roll, nothing to flicker.
  const state = S({ pct: 0.4, working: 3, procs: 2 });
  expect(pickFace(state)).toEqual(pickFace(state));
});

// ---- an empty fleet vs. a parked one -------------------------------------

test("no agents at all is a blank forward stare", () => {
  expect(pickFace(S({ working: 0, procs: 0, agents: 0 }))).toEqual({ row: 0, col: COL_FORWARD });
});

test("agents present but nothing running gets the green-eye frame", () => {
  // Distinct from an empty fleet: the crew is parked and Smith is watching.
  expect(pickFace(S({ working: 0, procs: 0, agents: 3 })))
    .toEqual({ row: SPECIAL_ROW, col: COL_GREEN_EYE });
});

test("a parked fleet stops being parked the moment a process starts", () => {
  expect(pickFace(S({ working: 0, procs: 1, agents: 3 })).col).toBe(COL_FORWARD_ALT);
});

// ---- overrides, loudest first --------------------------------------------

test("an agent waiting on you turns the face aside", () => {
  expect(pickFace(S({ waiting: 1 })).col).toBe(COL_LOOK_R);
});

test("several agents waiting turns it the other way", () => {
  expect(pickFace(S({ waiting: 2 })).col).toBe(COL_LOOK_L);
  expect(pickFace(S({ waiting: 9 })).col).toBe(COL_LOOK_L);
});

test("a glance keeps the pain row — being needed is not a heal", () => {
  expect(pickFace(S({ pct: 0.85, waiting: 1 })).row).toBe(4);
});

test("needing you outranks however busy the fleet is", () => {
  expect(pickFace(S({ waiting: 1, working: 20 })).col).toBe(COL_LOOK_R);
});

test("needing you outranks a parked fleet", () => {
  expect(pickFace(S({ waiting: 1, working: 0, procs: 0, agents: 3 })).col).toBe(COL_LOOK_R);
});

test("critical usage pulls the red-eye frame", () => {
  expect(pickFace(S({ pct: 0.96 }))).toEqual({ row: SPECIAL_ROW, col: COL_RED_EYE });
});

test("red eyes outrank every other state", () => {
  expect(pickFace(S({ pct: 0.99, waiting: 2, working: 9 })).col).toBe(COL_RED_EYE);
  expect(pickFace(S({ pct: 0.99, working: 0, agents: 0 })).col).toBe(COL_RED_EYE);
});

// ---- every pick is on the sheet -----------------------------------------

test("pickFace only ever lands on a cell the sheet actually has", () => {
  const rowLen = (row: number) => (row === SPECIAL_ROW ? 2 : 7);
  for (const pct of [null, 0, 0.35, 0.75, 0.96]) {
    for (const waiting of [0, 1, 2]) {
      for (const working of [0, 1, 3, 5, 8]) {
        for (const procs of [0, 1, 9]) {
          for (const agents of [0, 1, 4]) {
            const f = pickFace(S({ pct, waiting, working, procs, agents }));
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

test("every frame on the sheet is reachable from some fleet state", () => {
  // A frame no state can produce is art we are paying to ship and never show.
  const seen = new Set<string>();
  for (const pct of [null, 0, 0.25, 0.45, 0.65, 0.85, 0.96]) {
    for (const waiting of [0, 1, 2]) {
      for (const working of [0, 1, 3, 5, 8]) {
        for (const procs of [0, 2]) {
          for (const agents of [0, 1, 4]) {
            const f = pickFace(S({ pct, waiting, working, procs, agents }));
            seen.add(`${f.row},${f.col}`);
          }
        }
      }
    }
  }
  for (const col of [COL_FORWARD, COL_FORWARD_ALT, COL_GRIT, COL_GRIT_ALT, COL_SCREAM, COL_LOOK_R, COL_LOOK_L]) {
    expect(seen).toContain(`0,${col}`);
  }
  for (const row of [1, 2, 3, 4]) expect(seen).toContain(`${row},${COL_FORWARD_ALT}`);
  expect(seen).toContain(`${SPECIAL_ROW},${COL_RED_EYE}`);
  expect(seen).toContain(`${SPECIAL_ROW},${COL_GREEN_EYE}`);
});

// ---- faceTitle -----------------------------------------------------------

test("faceTitle explains what the face is reacting to", () => {
  expect(faceTitle(S({ waiting: 2 }))).toContain("2 agents need you");
  expect(faceTitle(S({ waiting: 1 }))).toContain("1 agent needs you");
  expect(faceTitle(S({ pct: 0.5 }))).toContain("50%");
  expect(faceTitle(S({ pct: null }))).toContain("no usage data");
});

test("faceTitle reports the running processes behind the load", () => {
  expect(faceTitle(S({ working: 2, procs: 3 }))).toContain("3 processes");
});

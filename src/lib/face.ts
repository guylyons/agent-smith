// Which Agent Smith face the HUD should be wearing — pure and DOM-free so the
// whole behaviour is unit-tested without rendering anything.
//
// The sheet (src/ui/faces.png, built by scripts/slice-faces.ts) is a grid:
//   rows 0-4  the same seven expressions, drawn progressively more strained —
//             row 4 is bloodied. The row is the fleet's PAIN.
//   row 5     two special frames: red eyes, and glowing green eyes.
//   columns   forward, gritted, screaming, forward-alt, gritted-alt, and two
//             turned views. The column is the fleet's MOOD.
//
// This mirrors DOOM's status face, which is why it fits: the app already frames
// the token budget as an HP bar, so a face that sours as the fleet burns budget
// is reading a gauge that already exists rather than inventing one.
//
// pickFace is a PURE FUNCTION OF FLEET STATE — no clock, no randomness. The
// face holds still while nothing is happening and moves only when the numbers
// behind it move, so a glance at it is worth something.

/** Sheet geometry. The HUD and the slicer must agree on these. */
export const FACE_COLS = 7;
export const FACE_ROWS = 6;
export const FACE_CELL_W = 42;
export const FACE_CELL_H = 48;

/** Columns, in sheet order. */
export const COL_FORWARD = 0;
export const COL_GRIT = 1;
export const COL_SCREAM = 2;
export const COL_FORWARD_ALT = 3;
export const COL_GRIT_ALT = 4;
export const COL_LOOK_R = 5;
export const COL_LOOK_L = 6;

/** The last row holds the two one-off frames rather than a pain level. */
export const SPECIAL_ROW = 5;
export const COL_RED_EYE = 0;
export const COL_GREEN_EYE = 1;

/** Number of pain rows (0..4) before the special row. */
const PAIN_ROWS = 5;

/** Usage at which Smith stops pretending he's fine. */
const CRITICAL_PCT = 0.95;

/**
 * The concurrency ladder: how strained Smith looks for a given amount of work
 * running at once. Read as "at `from` units of load or more, wear this face",
 * steepest first — the first match wins.
 *
 * A unit of load is one working agent or one live subagent process, counted
 * alike: six subagents under a single agent is a busy machine, and the agent
 * count on its own would read as barely awake.
 */
export const LOAD_LADDER: readonly { from: number; col: number }[] = [
  { from: 8, col: COL_SCREAM },
  { from: 5, col: COL_GRIT_ALT },
  { from: 3, col: COL_GRIT },
  { from: 1, col: COL_FORWARD_ALT },
];

/** Everything the face reacts to. Deliberately primitives, not a Snapshot: this
 *  module stays independent of the UI layer that computes them. */
export type FaceState = {
  /** Fleet token usage, 0..1, or null when nothing reports a budget. */
  pct: number | null;
  /** Agents blocked on the human. */
  waiting: number;
  /** Agents actively working. */
  working: number;
  /** Live subagent processes across the fleet. */
  procs: number;
  /** Agents known at all — an empty fleet is not a parked one. */
  agents: number;
};

export type Face = { row: number; col: number };

/**
 * The pain row for a usage fraction: five even bands from unhurt to bloodied.
 * No data reads as unhurt, and out-of-range input is clamped rather than
 * allowed to index off the sheet.
 */
export function painRow(pct: number | null): number {
  if (pct === null) return 0;
  const clamped = Math.max(0, Math.min(1, pct));
  return Math.min(PAIN_ROWS - 1, Math.floor(clamped * PAIN_ROWS));
}

/** Working agents plus live subagent processes — everything running at once. */
export function fleetLoad(state: FaceState): number {
  return Math.max(0, state.working) + Math.max(0, state.procs);
}

/**
 * The face to show, as a pure function of fleet state.
 *
 * Precedence, loudest first: critical usage (red eyes) beats an agent blocked
 * on you (a glance aside), which beats an empty fleet, which beats a parked one
 * (green eyes), which beats the concurrency ladder. The row is always the pain
 * row, so how much budget is gone shows through whatever mood sits on top.
 */
export function pickFace(state: FaceState): Face {
  const { pct, waiting, agents } = state;

  if (pct !== null && pct >= CRITICAL_PCT) return { row: SPECIAL_ROW, col: COL_RED_EYE };

  const row = painRow(pct);

  // Being blocked on the human is the one thing the HUD exists to shout about.
  // Which way he turns reports how many: one, or a room full.
  if (waiting > 0) return { row, col: waiting === 1 ? COL_LOOK_R : COL_LOOK_L };

  // No crew at all is not the same as a crew standing idle: there is nobody to
  // watch, so the stare is blank rather than knowing.
  if (agents <= 0) return { row: 0, col: COL_FORWARD };

  const load = fleetLoad(state);
  if (load === 0) return { row: SPECIAL_ROW, col: COL_GREEN_EYE };

  const rung = LOAD_LADDER.find((r) => load >= r.from);
  return { row, col: rung ? rung.col : COL_FORWARD };
}

/** Plain-language reading of the same state, for the HUD's tooltip and its
 *  screen-reader label — the face is decorative unless it can be explained. */
export function faceTitle(state: FaceState): string {
  const { pct, waiting, working, procs, agents } = state;
  const usage = pct === null ? "no usage data" : `${Math.round(pct * 100)}% of the fleet's token budget spent`;

  const bits: string[] = [];
  if (waiting > 0) bits.push(`${waiting} agent${waiting === 1 ? " needs" : "s need"} you`);
  if (working > 0) bits.push(`${working} working`);
  if (procs > 0) bits.push(`${procs} process${procs === 1 ? "" : "es"}`);
  if (!bits.length) bits.push(agents > 0 ? "all quiet" : "no agents");

  return `Agent Smith — ${bits.join(", ")} · ${usage}`;
}

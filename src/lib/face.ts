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

/** Odds that a fully idle fleet blinks the green-eye frame on a given tick.
 *  Rare on purpose — a special frame you see constantly stops being special. */
const GREEN_EYE_ODDS = 1 / 8;

/** The idle rotation. Weighted by repetition rather than a parallel weight
 *  table: three of six slots look straight ahead, so Smith mostly stares at you
 *  and only occasionally glances aside. */
export const IDLE_COLS: readonly number[] = [
  COL_FORWARD, COL_FORWARD, COL_FORWARD,
  COL_FORWARD_ALT,
  COL_LOOK_R,
  COL_LOOK_L,
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
  /** Agents known at all — an empty fleet is not an idle one. */
  agents: number;
  /** A card just landed in DONE. */
  celebrating: boolean;
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

/**
 * The face to show. `rand` is injected so the idle flicker is testable.
 *
 * Precedence, loudest first: critical usage (red eyes) beats a celebration,
 * which beats a grimace for agents blocked on you, which beats the idle
 * rotation. A celebration changes only the column — finishing a ticket is a
 * mood, not a refund on the tokens already burned.
 */
export function pickFace(state: FaceState, rand: () => number = Math.random): Face {
  const { pct, waiting, working, agents, celebrating } = state;

  if (pct !== null && pct >= CRITICAL_PCT) return { row: SPECIAL_ROW, col: COL_RED_EYE };

  const row = painRow(pct);

  if (celebrating) return { row, col: COL_SCREAM };
  if (waiting > 0) return { row, col: rand() < 0.5 ? COL_GRIT : COL_GRIT_ALT };

  // Nothing running but agents on the board: the fleet is idle, and just
  // occasionally that boredom shows as the green-eye frame.
  if (working === 0 && agents > 0 && rand() < GREEN_EYE_ODDS) {
    return { row: SPECIAL_ROW, col: COL_GREEN_EYE };
  }

  return { row, col: IDLE_COLS[Math.min(IDLE_COLS.length - 1, Math.floor(rand() * IDLE_COLS.length))]! };
}

/** Plain-language reading of the same state, for the HUD's tooltip and its
 *  screen-reader label — the face is decorative unless it can be explained. */
export function faceTitle(state: FaceState): string {
  const { pct, waiting, working, agents } = state;
  const usage = pct === null ? "no usage data" : `${Math.round(pct * 100)}% of the fleet's token budget spent`;

  const bits: string[] = [];
  if (waiting > 0) bits.push(`${waiting} agent${waiting === 1 ? " needs" : "s need"} you`);
  if (working > 0) bits.push(`${working} working`);
  if (!bits.length) bits.push(agents > 0 ? "all quiet" : "no agents");

  return `Agent Smith — ${bits.join(", ")} · ${usage}`;
}

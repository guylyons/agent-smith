// The numbers behind the DOOM status bar, computed from a fleet snapshot.
//
// Pure and DOM-free, like face.ts, so the whole mapping is unit-tested without
// rendering: six panels in DOOM's order — AMMO, HEALTH, ARMS, face, ARMOR, and
// the ammo table — each reading a different dimension of the workshop so no two
// panels tell the same story twice.

import type { AgentStatus } from "../schema";
import { columnStage, isDoneColumn, isLandedColumn, STAGES, type Board } from "./board";
import { fleetUsage } from "./usage";

/** Weapon slots on DOOM's ARMS panel — the fleet gets one per agent. */
export const ARMS_SLOTS = 6;

/** Rows in the ammo table. DOOM has four ammo types; we show four stages. */
export const TABLE_ROWS = 4;

/** A single ARMS slot: an agent pulling its weight, one standing by, or no
 *  agent at all. Rendered lit / dim / dark respectively. */
export type ArmsSlot = "working" | "idle" | "empty";

export type TableRow = { label: string; count: number; total: number };

export type HudStats = {
  /** Tokens the fleet has left, or null when nothing reports a budget. */
  ammo: number | null;
  /** Percentage of the token budget REMAINING, 0..100, or null with no data. */
  health: number | null;
  /** Exactly ARMS_SLOTS entries, agents first, padded with "empty". */
  arms: ArmsSlot[];
  /** Percentage of the board's cards that are finished — in the done column
   *  or landed past it (a "Merged") — 0..100. */
  armor: number;
  /** One row per stage (todo, doing, review, done+landed) with card counts;
   *  the first TABLE_ROWS columns instead on a board with no stages. */
  table: TableRow[];
};

/**
 * Four letters for a column, taken from its LONGEST word — that word carries
 * the meaning ("In Progress" is about progress, not about "in"), which a plain
 * first-four-characters rule would throw away. Punctuation is dropped and a
 * name with no letters at all falls back to "?" rather than an empty cell.
 */
export function columnAbbrev(name: string): string {
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!words.length) return "?";
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
  return longest.slice(0, 4);
}

/** Everything the status bar displays, from one snapshot of the fleet. */
export function hudStats(agents: AgentStatus[], board: Board): HudStats {
  const usage = fleetUsage(agents);

  // Remaining, not spent: this is a health bar, and a full one must mean a
  // fresh fleet. The header's USAGE meter is the mirror image on purpose.
  const ammo = usage ? usage.total - usage.used : null;
  const health = usage ? Math.round((1 - usage.pct) * 100) : null;

  const arms: ArmsSlot[] = Array.from({ length: ARMS_SLOTS }, (_, i) => {
    const a = agents[i];
    if (!a) return "empty";
    return a.state === "working" ? "working" : "idle";
  });

  // Finished means in Done or landed past it: merged cards leave Done for a
  // "Merged" column, and they are the most finished work on the board.
  const finished = (columnId: string) => isDoneColumn(board, columnId) || isLandedColumn(board, columnId);
  const total = board.cards.length;
  const done = board.cards.filter((c) => finished(c.columnId)).length;
  const armor = total > 0 ? Math.round((done / total) * 100) : 0;

  const count = (inRow: (columnId: string) => boolean) => board.cards.filter((c) => inRow(c.columnId)).length;

  // Rows by stage, not by position, so extra columns can't push the finished
  // row off the table. Each row is labelled by the stage's first column.
  const staged = STAGES.flatMap((stage) => {
    const col = board.columns.find((c) => columnStage(c) === stage);
    if (!col) return [];
    const inStage = (id: string) => board.columns.some((c) => c.id === id && columnStage(c) === stage);
    return [{ label: columnAbbrev(col.name), count: count(stage === "done" ? finished : inStage), total }];
  });

  const table = staged.length
    ? staged
    : board.columns.slice(0, TABLE_ROWS).map((col) => ({
        label: columnAbbrev(col.name),
        count: count((id) => id === col.id),
        total,
      }));

  return { ammo, health, arms, armor, table };
}

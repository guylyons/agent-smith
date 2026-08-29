// The numbers behind the DOOM status bar, computed from a fleet snapshot.
//
// Pure and DOM-free, like face.ts, so the whole mapping is unit-tested without
// rendering: six panels in DOOM's order — AMMO, HEALTH, ARMS, face, ARMOR, and
// the ammo table — each reading a different dimension of the workshop so no two
// panels tell the same story twice.

import type { AgentStatus } from "../schema";
import { DONE_COLUMN_ID, type Board } from "./board";
import { fleetUsage } from "./usage";

/** Weapon slots on DOOM's ARMS panel — the fleet gets one per agent. */
export const ARMS_SLOTS = 6;

/** Rows in the ammo table. DOOM has four ammo types; we show four columns. */
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
  /** Percentage of the board's cards sitting in the done column, 0..100. */
  armor: number;
  /** Up to TABLE_ROWS board columns with their card counts. */
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

  // ARMOR is computed straight from the done column rather than from the table
  // below, so a board that reorders its columns can't hide the one number that
  // says how much work is actually finished.
  const total = board.cards.length;
  const done = board.cards.filter((c) => c.columnId === DONE_COLUMN_ID).length;
  const armor = total > 0 ? Math.round((done / total) * 100) : 0;

  const table = board.columns.slice(0, TABLE_ROWS).map((col) => ({
    label: columnAbbrev(col.name),
    count: board.cards.filter((c) => c.columnId === col.id).length,
    total,
  }));

  return { ammo, health, arms, armor, table };
}

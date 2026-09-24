import { test, expect } from "bun:test";
import { hudStats, columnAbbrev, ARMS_SLOTS } from "../src/lib/hud";
import type { AgentStatus } from "../src/schema";
import type { Board, Stage } from "../src/lib/board";

function agent(o: Partial<AgentStatus> = {}): AgentStatus {
  return { state: "idle", ...o } as AgentStatus;
}

/** An agent that reports a budget: `left` of `total` tokens remaining. */
function budgeted(left: number, total: number, o: Partial<AgentStatus> = {}): AgentStatus {
  return agent({ usage: { budgetLeft: left, budgetTotal: total }, ...o });
}

function board(columns: [string, string, Stage?][], cards: string[]): Board {
  return {
    columns: columns.map(([id, name, stage]) => ({ id, name, instruction: "", ...(stage ? { stage } : {}) })),
    cards: cards.map((columnId, i) => ({ id: `c${i}`, title: `card ${i}`, columnId })),
  };
}

const EMPTY: Board = { columns: [], cards: [] };

// ---- AMMO + HEALTH: the fleet's token budget ------------------------------

test("ammo is the tokens the fleet has left, summed across sessions", () => {
  const s = hudStats([budgeted(300, 1000), budgeted(200, 1000)], EMPTY);
  expect(s.ammo).toBe(500);
});

test("health is the percentage of budget REMAINING, not spent", () => {
  // 250 left of 1000 — a quarter of the fleet's life, not three quarters.
  expect(hudStats([budgeted(250, 1000)], EMPTY).health).toBe(25);
});

test("a fresh fleet reads as full health", () => {
  expect(hudStats([budgeted(1000, 1000)], EMPTY).health).toBe(100);
});

test("ammo and health are null when nothing reports a budget", () => {
  // Null rather than zero: "no data" and "out of tokens" are different states,
  // and zero would read as the fleet being dead.
  const s = hudStats([agent({ state: "working" })], EMPTY);
  expect(s.ammo).toBeNull();
  expect(s.health).toBeNull();
});

test("sessions without a known starting total are left out of the budget", () => {
  const noTotal = agent({ usage: { budgetLeft: 999 } as AgentStatus["usage"] });
  expect(hudStats([budgeted(400, 1000), noTotal], EMPTY).ammo).toBe(400);
});

// ---- ARMS: one slot per live agent ---------------------------------------

test("arms always renders a full row of slots, lit or not", () => {
  expect(hudStats([], EMPTY).arms).toHaveLength(ARMS_SLOTS);
  expect(hudStats([agent()], EMPTY).arms).toHaveLength(ARMS_SLOTS);
});

test("an empty fleet leaves every arms slot empty", () => {
  expect(hudStats([], EMPTY).arms.every((s) => s === "empty")).toBe(true);
});

test("arms lights a slot for a working agent and dims one for an idle agent", () => {
  const s = hudStats([agent({ state: "working" }), agent({ state: "idle" })], EMPTY);
  expect(s.arms[0]).toBe("working");
  expect(s.arms[1]).toBe("idle");
  expect(s.arms[2]).toBe("empty");
});

test("an agent waiting on you holds its slot rather than going dark", () => {
  expect(hudStats([agent({ state: "waiting" })], EMPTY).arms[0]).toBe("idle");
});

test("arms caps at the slots the sheet has, however big the fleet gets", () => {
  const many = Array.from({ length: ARMS_SLOTS + 4 }, () => agent({ state: "working" }));
  const arms = hudStats(many, EMPTY).arms;
  expect(arms).toHaveLength(ARMS_SLOTS);
  expect(arms.every((s) => s === "working")).toBe(true);
});

// ---- ARMOR: how much of the board is finished ----------------------------

test("armor is the share of cards sitting in the done column", () => {
  const b = board([["backlog", "Backlog"], ["done", "Done"]], ["backlog", "done", "done", "backlog"]);
  expect(hudStats([], b).armor).toBe(50);
});

test("armor of an empty board is zero, not a division by zero", () => {
  expect(hudStats([], EMPTY).armor).toBe(0);
});

test("armor reports done even when the done column is not among the first four", () => {
  // ARMOR is computed independently of the table, so a reordered board can't
  // hide the one number that says how much work is actually finished.
  const b = board(
    [["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"], ["done", "Done"]],
    ["a", "done"],
  );
  expect(hudStats([], b).armor).toBe(50);
});

test("armor counts cards that landed past Done, not just the ones waiting in it", () => {
  // The live board keeps merged work in a stageless "Merged" column after Done.
  // Those cards are the most finished of all; leaving them out read 5%.
  const b = board(
    [["backlog", "Backlog"], ["done", "Done"], ["merged", "Merged"]],
    ["backlog", "done", "merged", "merged"],
  );
  expect(hudStats([], b).armor).toBe(75);
});

test("a stageless column before Done does not count as finished", () => {
  const b = board([["backlog", "Backlog"], ["parked", "Parked"], ["done", "Done"]], ["parked", "done"]);
  expect(hudStats([], b).armor).toBe(50);
});

// ---- the ammo table: cards per column ------------------------------------

test("the table lists the board's columns with their card counts", () => {
  const b = board([["backlog", "Backlog"], ["done", "Done"]], ["backlog", "backlog", "done"]);
  expect(hudStats([], b).table).toEqual([
    { label: "BACK", count: 2, total: 3 },
    { label: "DONE", count: 1, total: 3 },
  ]);
});

test("the table shows one row per stage, with Done and Merged combined", () => {
  const b = board(
    [["backlog", "Backlog"], ["in-progress", "In Progress"], ["review", "Review"], ["done", "Done"], ["merged", "Merged"]],
    ["backlog", "in-progress", "done", "merged", "merged"],
  );
  expect(hudStats([], b).table).toEqual([
    { label: "BACK", count: 1, total: 5 },
    { label: "PROG", count: 1, total: 5 },
    { label: "REVI", count: 0, total: 5 },
    { label: "DONE", count: 3, total: 5 },
  ]);
});

test("the stage rows stay put when extra columns come first", () => {
  // Position used to decide the rows, so a column added at the front pushed
  // the finished row off the table.
  const b = board(
    [["ideas", "Ideas"], ["backlog", "Backlog"], ["in-progress", "In Progress"], ["review", "Review"], ["done", "Done"]],
    ["ideas", "done"],
  );
  expect(hudStats([], b).table.map((r) => r.label)).toEqual(["BACK", "PROG", "REVI", "DONE"]);
});

test("a stage with no column on the board gets no row", () => {
  const b = board([["todo", "Todo", "todo"], ["shipped", "Shipped", "done"]], ["todo", "shipped"]);
  expect(hudStats([], b).table.map((r) => r.label)).toEqual(["TODO", "SHIP"]);
});

test("a board with no stages falls back to its first four columns", () => {
  const b = board(
    [["a", "Alpha"], ["b", "Bravo"], ["c", "Charlie"], ["d", "Delta"], ["e", "Echo"]],
    [],
  );
  const t = hudStats([], b).table;
  expect(t).toHaveLength(4);
  expect(t.map((r) => r.label)).toEqual(["ALPH", "BRAV", "CHAR", "DELT"]);
});

test("a board with fewer than four columns renders only the rows it has", () => {
  expect(hudStats([], board([["a", "Alpha"]], [])).table).toHaveLength(1);
});

test("an empty board renders no table rows", () => {
  expect(hudStats([], EMPTY).table).toEqual([]);
});

// ---- column abbreviation -------------------------------------------------

test("columnAbbrev takes four letters from a column's longest word", () => {
  // The longest word carries the meaning: "IN PROGRESS" is about progress.
  expect(columnAbbrev("Backlog")).toBe("BACK");
  expect(columnAbbrev("In Progress")).toBe("PROG");
  expect(columnAbbrev("Done")).toBe("DONE");
});

test("columnAbbrev pads a short name rather than returning a stub", () => {
  expect(columnAbbrev("Up")).toBe("UP");
});

test("columnAbbrev survives punctuation and empty names", () => {
  expect(columnAbbrev("Ready — for review")).toBe("REVI");
  expect(columnAbbrev("")).toBe("?");
  expect(columnAbbrev("   ")).toBe("?");
});

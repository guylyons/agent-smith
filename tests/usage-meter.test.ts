import { test, expect } from "bun:test";
import { fmtTokens, fleetUsage } from "../src/ui/UsageMeter";
import type { AgentStatus } from "../src/schema";

// A minimal agent: fleetUsage only reads .usage.
function agent(name: string, usage?: { budgetLeft: number; budgetTotal?: number }): AgentStatus {
  return { name, usage } as AgentStatus;
}

test("fmtTokens renders millions, thousands, and small counts", () => {
  expect(fmtTokens(15_000_000)).toBe("15M");
  expect(fmtTokens(14_951_815)).toBe("15M");
  expect(fmtTokens(2_680_000)).toBe("2.7M");
  expect(fmtTokens(152_300)).toBe("152K");
  expect(fmtTokens(980)).toBe("980");
  expect(fmtTokens(0)).toBe("0");
});

test("fleetUsage is null when nothing reports a usable budget", () => {
  expect(fleetUsage([])).toBeNull();
  expect(fleetUsage([agent("VOLT")])).toBeNull();
  // budgetLeft with no total can't be turned into "used", so it doesn't count.
  expect(fleetUsage([agent("VOLT", { budgetLeft: 90_000 })])).toBeNull();
  // a zero/absent total is excluded (no divide-by-zero).
  expect(fleetUsage([agent("VOLT", { budgetLeft: 10, budgetTotal: 0 })])).toBeNull();
});

test("one measurable session yields its consumed tokens", () => {
  // 128K total, 100K left -> 28K used.
  const u = fleetUsage([agent("VOLT", { budgetLeft: 100_000, budgetTotal: 128_000 })]);
  expect(u).toEqual({ used: 28_000, total: 128_000, sessions: 1, pct: 28_000 / 128_000 });
});

test("usage sums consumed tokens across every measurable session", () => {
  const u = fleetUsage([
    agent("PIXEL", { budgetLeft: 8_000, budgetTotal: 128_000 }),   // 120K used
    agent("VOLT", { budgetLeft: 108_000, budgetTotal: 128_000 }),  // 20K used
    agent("CADENCE", { budgetLeft: 90_000 }),                       // no total -> excluded
  ]);
  expect(u).toEqual({ used: 140_000, total: 256_000, sessions: 2, pct: 140_000 / 256_000 });
});

test("used is clamped so a stray budget can't push it negative or over total", () => {
  // budgetLeft above total (stale head) -> used floored at 0, not negative.
  const over = fleetUsage([agent("VOLT", { budgetLeft: 200_000, budgetTotal: 128_000 })]);
  expect(over).toEqual({ used: 0, total: 128_000, sessions: 1, pct: 0 });
  // negative budgetLeft -> used capped at total, pct at 1.
  const under = fleetUsage([agent("VOLT", { budgetLeft: -5, budgetTotal: 128_000 })]);
  expect(under).toEqual({ used: 128_000, total: 128_000, sessions: 1, pct: 1 });
});

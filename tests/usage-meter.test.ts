import { test, expect } from "bun:test";
import { fmtTokens, contextHeadroom } from "../src/ui/UsageMeter";
import type { AgentStatus } from "../src/schema";

// A minimal agent: contextHeadroom only reads .name and .usage.
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

test("contextHeadroom is null when nothing reports a usable budget", () => {
  expect(contextHeadroom([])).toBeNull();
  expect(contextHeadroom([agent("VOLT")])).toBeNull();
});

test("a session with no known total is excluded, not treated as full", () => {
  // This is the always-full bug: budgetLeft with no budgetTotal used to pin the
  // meter to 100%. Now it simply can't be measured, so it doesn't count.
  expect(contextHeadroom([agent("VOLT", { budgetLeft: 90_000 })])).toBeNull();
});

test("a zero total is excluded (no divide-by-zero)", () => {
  expect(contextHeadroom([agent("VOLT", { budgetLeft: 10, budgetTotal: 0 })])).toBeNull();
});

test("one measurable session yields its headroom fraction", () => {
  const hp = contextHeadroom([agent("VOLT", { budgetLeft: 32_000, budgetTotal: 128_000 })]);
  expect(hp).toEqual({ pct: 0.25, left: 32_000, total: 128_000, name: "VOLT" });
});

test("the busiest session wins — the one with the least headroom left", () => {
  const hp = contextHeadroom([
    agent("PIXEL", { budgetLeft: 120_000, budgetTotal: 128_000 }), // 94% left
    agent("VOLT", { budgetLeft: 20_000, budgetTotal: 128_000 }),   // 16% left  <- busiest
    agent("CADENCE", { budgetLeft: 90_000, budgetTotal: 128_000 }),
  ]);
  expect(hp?.name).toBe("VOLT");
  expect(hp?.pct).toBeCloseTo(0.15625, 5);
});

test("headroom is clamped to 0..1 even if a stray budget exceeds its total", () => {
  const hp = contextHeadroom([agent("VOLT", { budgetLeft: 200_000, budgetTotal: 128_000 })]);
  expect(hp?.pct).toBe(1);
});

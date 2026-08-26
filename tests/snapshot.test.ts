import { test, expect } from "bun:test";
import { buildSnapshot } from "../src/lib/snapshot";
import type { AgentStatus } from "../src/schema";

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 1000, ...o,
});

test("drops stale agents", () => {
  const stale = buildSnapshot([A({ updatedAt: 0 })], 1000, 500);
  expect(stale.agents.length).toBe(0);

  const fresh = buildSnapshot([A({ updatedAt: 900 })], 1000, 500);
  expect(fresh.agents.length).toBe(1);
});

test("waiting beats working for same ticket", () => {
  const snap = buildSnapshot(
    [A({ sessionId: "1", state: "working", ticket: "#7" }),
     A({ sessionId: "2", state: "waiting", ticket: "#7" })], 1000);
  const needs = snap.line.find((s) => s.stage === "needs")!;
  expect(needs.tickets).toContain("#7");
  expect(snap.line.find((s) => s.stage === "working")!.tickets).not.toContain("#7");
});

test("null ticket contributes no crate", () => {
  const snap = buildSnapshot([A({ ticket: null })], 1000);
  expect(snap.line.every((s) => s.tickets.length === 0)).toBe(true);
});

test("review and merged always present and empty", () => {
  const snap = buildSnapshot([A({})], 1000);
  expect(snap.line.map((s) => s.stage)).toEqual(["backlog","working","needs","review","merged"]);
  expect(snap.line.find((s) => s.stage === "merged")!.tickets).toEqual([]);
});

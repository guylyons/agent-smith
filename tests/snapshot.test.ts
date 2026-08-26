import { test, expect } from "bun:test";
import { buildSnapshot, workLabel } from "../src/lib/snapshot";
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

test("a ticketless working session still shows on THE LINE (labelled by branch)", () => {
  const snap = buildSnapshot([A({ ticket: null, branch: "keymap-cleanup", state: "working" })], 1000);
  expect(snap.line.find((s) => s.stage === "working")!.tickets).toEqual(["keymap-cleanup"]);
});

test("workLabel: ticket > short branch > repo", () => {
  expect(workLabel(A({ ticket: "#9" }))).toBe("#9");
  expect(workLabel(A({ ticket: null, branch: "feature/xyz-thing" }))).toBe("xyz-thing");
  expect(workLabel(A({ ticket: null, branch: "HEAD", cwd: "/Users/x/agentsmith" }))).toBe("agentsmith");
});

test("duplicate codenames are made unique within the view", () => {
  const snap = buildSnapshot([
    A({ sessionId: "aaaa1111", name: "SABLE", cwd: "/a" }),
    A({ sessionId: "bbbb2222", name: "SABLE", cwd: "/b" }),
  ], 1000);
  const names = snap.agents.map((a) => a.name);
  expect(new Set(names).size).toBe(2); // no duplicates
  expect(names.every((n) => n.startsWith("SABLE"))).toBe(true);
});

test("review and merged always present and empty", () => {
  const snap = buildSnapshot([A({})], 1000);
  expect(snap.line.map((s) => s.stage)).toEqual(["backlog","working","needs","review","merged"]);
  expect(snap.line.find((s) => s.stage === "merged")!.tickets).toEqual([]);
});

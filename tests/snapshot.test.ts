import { test, expect } from "bun:test";
import { buildSnapshot } from "../src/lib/snapshot";
import { defaultBoard, addColumn } from "../src/lib/board";
import type { AgentStatus } from "../src/schema";

const A = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "A", role: "r", ticket: "#1", state: "working",
  doing: "x", cwd: "/", branch: "b", updatedAt: 1000, ...o,
});

test("drops stale agents", () => {
  const stale = buildSnapshot([A({ updatedAt: 0 })], 1000, { staleMs: 500 });
  expect(stale.agents.length).toBe(0);

  const fresh = buildSnapshot([A({ updatedAt: 900 })], 1000, { staleMs: 500 });
  expect(fresh.agents.length).toBe(1);
});

test("duplicate codenames are made unique within the view", () => {
  const snap = buildSnapshot([
    A({ sessionId: "aaaa1111", name: "SABLE", cwd: "/a" }),
    A({ sessionId: "bbbb2222", name: "SABLE", cwd: "/b" }),
  ], 1000);
  const names = snap.agents.map((a) => a.name);
  expect(new Set(names).size).toBe(2);
  expect(names.every((n) => n.startsWith("SABLE"))).toBe(true);
});

test("agents are sorted by name", () => {
  const snap = buildSnapshot([
    A({ sessionId: "1", name: "ZULU", cwd: "/a" }),
    A({ sessionId: "2", name: "ALPHA", cwd: "/b" }),
  ], 1000);
  expect(snap.agents.map((a) => a.name)).toEqual(["ALPHA", "ZULU"]);
});

test("the board is passed through unchanged", () => {
  const board = addColumn(defaultBoard(), "Blocked");
  const snap = buildSnapshot([A({})], 1000, { board });
  expect(snap.board).toEqual(board);
});

test("with no board given, the snapshot carries the default board", () => {
  const snap = buildSnapshot([A({})], 1000);
  expect(snap.board).toEqual(defaultBoard());
});

import { test, expect } from "bun:test";
import { buildSnapshot, snapshotEvent } from "../src/lib/snapshot";
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

test("two status files sharing a crew id collapse to the freshest (the /clear ghost)", () => {
  // /clear starts a new session id in the SAME process without a SessionEnd, so
  // the old session's status file lingers. Both share the crew id that outlives
  // the /clear; only the live (freshest) one should show.
  const snap = buildSnapshot([
    A({ sessionId: "old1", name: "LAMBERT", updatedAt: 900, crew: { id: "lambert-6fdc", name: "LAMBERT" } }),
    A({ sessionId: "new2", name: "LAMBERT", updatedAt: 990, crew: { id: "lambert-6fdc", name: "LAMBERT" } }),
  ], 1000);
  expect(snap.agents.length).toBe(1);
  expect(snap.agents[0]!.sessionId).toBe("new2");
});

test("agents without a crew id are never collapsed together", () => {
  const snap = buildSnapshot([
    A({ sessionId: "aaaa1111", name: "SABLE", updatedAt: 900 }),
    A({ sessionId: "bbbb2222", name: "MAKO", updatedAt: 990 }),
  ], 1000);
  expect(snap.agents.length).toBe(2);
});

test("a working agent nothing has refreshed lately shows as idle (the frozen-WORKING ghost)", () => {
  const now = 1_000_000;
  const snap = buildSnapshot([A({ state: "working", doing: "thinking", updatedAt: now - 120_000 })], now);
  expect(snap.agents.length).toBe(1); // still within the 5-min existence window
  expect(snap.agents[0]!.state).toBe("idle");
  expect(snap.agents[0]!.doing).toBe("idle");
});

test("a genuinely-working agent keeps its working state", () => {
  const now = 1_000_000;
  const snap = buildSnapshot([A({ state: "working", doing: "thinking", updatedAt: now - 5_000 })], now);
  expect(snap.agents[0]!.state).toBe("working");
  expect(snap.agents[0]!.doing).toBe("thinking");
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

test("snapshotEvent leaves out a board and mood the client already has", () => {
  const board = { columns: [], cards: [{ id: "x", title: "X", columnId: "k" }] } as any;
  const mood = { notes: [], links: [] } as any;
  const first = snapshotEvent({ agents: [], board, mood, archived: 0 }, {});
  expect(first.event.board).toBe(board);
  expect(first.event.mood).toBe(mood);
  const second = snapshotEvent({ agents: [], board: { ...board }, mood: { ...mood }, archived: 0 }, first.sent);
  expect("board" in second.event).toBe(false);
  expect("mood" in second.event).toBe(false);
  expect(second.event.agents).toEqual([]);
  const changed = snapshotEvent({ agents: [], board: { columns: [], cards: [] }, mood, archived: 1 }, second.sent);
  expect(changed.event.board).toEqual({ columns: [], cards: [] });
  expect("mood" in changed.event).toBe(false);
});

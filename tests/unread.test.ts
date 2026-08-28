// tests/unread.test.ts
import { test, expect } from "bun:test";
import { diffUnread, type PrevStates } from "../src/ui/unread";
import type { AgentStatus } from "../src/schema";

const agent = (sessionId: string, state: AgentStatus["state"], extra: Partial<AgentStatus> = {}): AgentStatus => ({
  sessionId, name: sessionId.toUpperCase(), role: "dev", ticket: null, state,
  doing: "x", cwd: "/x", branch: null, updatedAt: 0, ...extra,
});

test("the baseline snapshot flags nobody", () => {
  const { ids, next } = diffUnread(new Map(), [agent("a", "idle"), agent("b", "waiting")], false);
  expect(ids).toEqual([]);
  expect([...next]).toEqual([["a", "idle"], ["b", "waiting"]]);
});

test("finishing work (working -> idle) is something to read", () => {
  const prev: PrevStates = new Map([["a", "working"]]);
  expect(diffUnread(prev, [agent("a", "idle")], true).ids).toEqual(["a"]);
});

test("stopping to ask (-> waiting) is something to read", () => {
  const prev: PrevStates = new Map([["a", "working"]]);
  expect(diffUnread(prev, [agent("a", "waiting")], true).ids).toEqual(["a"]);
});

test("an agent first seen idle is not treated as freshly finished", () => {
  expect(diffUnread(new Map(), [agent("a", "idle")], true).ids).toEqual([]);
});

test("standing still in a state never re-flags", () => {
  const prev: PrevStates = new Map([["a", "waiting"], ["b", "idle"]]);
  expect(diffUnread(prev, [agent("a", "waiting"), agent("b", "idle")], true).ids).toEqual([]);
});

test("starting work is not something to read", () => {
  const prev: PrevStates = new Map([["a", "idle"]]);
  expect(diffUnread(prev, [agent("a", "working")], true).ids).toEqual([]);
});

test("several agents finishing at once are all flagged", () => {
  const prev: PrevStates = new Map([["a", "working"], ["b", "working"], ["c", "working"]]);
  const { ids } = diffUnread(prev, [agent("a", "idle"), agent("b", "waiting"), agent("c", "working")], true);
  expect(ids.sort()).toEqual(["a", "b"]);
});

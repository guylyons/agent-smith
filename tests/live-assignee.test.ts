// tests/live-assignee.test.ts
import { test, expect } from "bun:test";
import { findLiveAssignee } from "../src/ui/liveAssignee";
import type { AgentStatus } from "../src/schema";

const agent = (o: Partial<AgentStatus>): AgentStatus =>
  ({ sessionId: "s", name: "VOLT", role: "r", ticket: null, state: "idle", doing: "", cwd: "/", branch: null, updatedAt: 0, ...o });

test("findLiveAssignee: matches the assignee's session id", () => {
  const volt = agent({ sessionId: "s1" });
  expect(findLiveAssignee([agent({ sessionId: "other" }), volt], { id: "s1", name: "VOLT" })).toBe(volt);
});

test("findLiveAssignee: matches by crew id after a /clear gave a new session id", () => {
  const cleared = agent({ sessionId: "s2", crew: { id: "volt-1234", name: "VOLT" } });
  expect(findLiveAssignee([cleared], { id: "s1", name: "VOLT", crew: "volt-1234" })).toBe(cleared);
});

test("findLiveAssignee: no match when neither session nor crew is running", () => {
  const agents = [agent({ sessionId: "s2", crew: { id: "other-crew", name: "ORAM" } })];
  expect(findLiveAssignee(agents, { id: "s1", name: "VOLT", crew: "volt-1234" })).toBeUndefined();
  // An assignee with no crew never matches an agent's crew by accident.
  expect(findLiveAssignee([agent({ sessionId: "s2" })], { id: "s1", name: "VOLT" })).toBeUndefined();
});

test("findLiveAssignee: no assignee -> undefined", () => {
  expect(findLiveAssignee([agent({})], null)).toBeUndefined();
  expect(findLiveAssignee([agent({})], undefined)).toBeUndefined();
});

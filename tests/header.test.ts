import { test, expect } from "bun:test";
import { headerSummary } from "../src/ui/Header";
import type { AgentStatus } from "../src/schema";

function agent(state: AgentStatus["state"], cwd: string): AgentStatus {
  return { state, cwd } as AgentStatus;
}

test("headerSummary counts only working and waiting, never idle", () => {
  const s = headerSummary([
    agent("working", "/a"),
    agent("working", "/b"),
    agent("waiting", "/a"),
    agent("idle", "/c"),
  ]);
  expect(s.working).toBe(2);
  expect(s.waiting).toBe(1);
});

test("headerSummary counts distinct active repos, not idle ones", () => {
  const s = headerSummary([
    agent("working", "/Users/x/repo-a"),
    agent("waiting", "/Users/x/repo-b"),
    agent("working", "/Users/x/repo-a"), // same repo as the first — not double counted
    agent("idle", "/Users/x/repo-c"),    // idle repo doesn't count
  ]);
  expect(s.repos).toBe(2);
});

test("headerSummary of an empty or all-idle fleet is all zeros", () => {
  expect(headerSummary([])).toEqual({ working: 0, waiting: 0, repos: 0 });
  expect(headerSummary([agent("idle", "/a")])).toEqual({ working: 0, waiting: 0, repos: 0 });
});

import { test, expect } from "bun:test";
import { inferRole } from "../src/lib/role";

test("component branch -> build role", () => {
  expect(inferRole("feature/4412-card-component", "/x").role).toBe("Component build");
});
test("docs branch -> docs role", () => {
  expect(inferRole("docs/changelog", "/x").name).toBe("SCRIBE");
});
test("unknown -> General/AGENT, not matched", () => {
  expect(inferRole("main", "/x")).toEqual({ role: "General", name: "AGENT", matched: false });
});

test("a matched work type reports matched: true", () => {
  expect(inferRole("feature/4412-card-component", "/x").matched).toBe(true);
});

test("an ancestor folder name is not treated as a role keyword", () => {
  // ~/Documents/... must not read as 'doc' (SCRIBE); latest-app must not read as
  // 'test' (PROBE). Only the branch and the repo's own dir name are considered.
  expect(inferRole("main", "/Users/x/Documents/my-app").matched).toBe(false);
  expect(inferRole(null, "/Users/x/Archive/latest-app").matched).toBe(false);
});

test("keys still match as token prefixes on branch and repo dir name", () => {
  expect(inferRole("feature/d11-migration", "/x").name).toBe("SHIFT");
  expect(inferRole(null, "/Users/x/docs-site").name).toBe("SCRIBE");
  expect(inferRole(null, "/Users/x/perf-harness").name).toBe("PROBE");
});

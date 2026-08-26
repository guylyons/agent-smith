import { test, expect } from "bun:test";
import { identify } from "../src/lib/identity";

test("keeps the persona when a work-type keyword matches", () => {
  expect(identify("s1", "feature/4412-card-component", "/x").name).toBe("FORGE");
  expect(identify("s1", "feature/4412-card-component", "/x").role).toBe("Component build");
});

test("falls back to a codename + repo role for generic sessions", () => {
  const id = identify("sess-abc", "main", "/Users/glyons/github/mho-drupal");
  expect(id.role).toBe("mho-drupal");
  expect(id.name).not.toBe("AGENT");
  expect(id.name.length).toBeGreaterThan(0);
});

test("codename is stable per sessionId", () => {
  expect(identify("same", null, "/a/repo")).toEqual(identify("same", null, "/a/repo"));
});

test("empty cwd falls back to General role", () => {
  expect(identify("s", null, "").role).toBe("General");
});

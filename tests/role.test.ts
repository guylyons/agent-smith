import { test, expect } from "bun:test";
import { inferRole } from "../src/lib/role";

test("component branch -> build role", () => {
  expect(inferRole("feature/4412-card-component", "/x").role).toBe("Component build");
});
test("docs branch -> docs role", () => {
  expect(inferRole("docs/changelog", "/x").name).toBe("SCRIBE");
});
test("unknown -> General/AGENT", () => {
  expect(inferRole("main", "/x")).toEqual({ role: "General", name: "AGENT" });
});

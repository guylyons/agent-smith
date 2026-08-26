import { test, expect } from "bun:test";
import { parseStatus } from "../src/schema";

const valid = {
  sessionId: "abc", name: "FORGE", role: "Component build",
  ticket: "#4412", state: "working", doing: "editing card.twig",
  cwd: "/x", branch: "feature/4412-card", updatedAt: 1,
};

test("parseStatus accepts a valid object", () => {
  expect(parseStatus(valid)?.sessionId).toBe("abc");
});

test("parseStatus returns null on bad state", () => {
  expect(parseStatus({ ...valid, state: "done" })).toBeNull();
});

test("parseStatus returns null on missing field", () => {
  const { doing, ...rest } = valid;
  expect(parseStatus(rest)).toBeNull();
});

test("parseStatus allows null ticket/branch", () => {
  expect(parseStatus({ ...valid, ticket: null, branch: null })).not.toBeNull();
});

import { test, expect } from "bun:test";
import { humanizeTool } from "../src/lib/humanize";

test("Edit -> editing basename", () => {
  expect(humanizeTool("Edit", { file_path: "/a/b/card.twig" })).toBe("editing card.twig");
});
test("Bash -> running command", () => {
  expect(humanizeTool("Bash", { command: "bun test" })).toBe("running bun test");
});
test("Read -> reading basename", () => {
  expect(humanizeTool("Read", { file_path: "/a/issue.md" })).toBe("reading issue.md");
});
test("unknown tool -> lowercased name", () => {
  expect(humanizeTool("Glob", {})).toBe("glob");
});
test("undefined input -> lowercased name", () => {
  expect(humanizeTool("Edit", undefined)).toBe("edit");
});

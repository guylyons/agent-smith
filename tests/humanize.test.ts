import { test, expect } from "bun:test";
import { humanizeTool } from "../src/lib/humanize";

test("Edit -> editing basename", () => {
  expect(humanizeTool("Edit", { file_path: "/a/b/card.twig" })).toBe("editing card.twig");
});
test("Bash -> running command", () => {
  expect(humanizeTool("Bash", { command: "bun test" })).toBe("running bun test");
});
test("Bash -> long multi-line command is clipped to one short line", () => {
  const cmd = "cd /Users/glyons/github/maine && git status --short && echo 'a very long compound command here'";
  const out = humanizeTool("Bash", { command: cmd });
  expect(out.startsWith("running ")).toBe(true);
  expect(out.includes("\n")).toBe(false);
  expect(out.length).toBeLessThanOrEqual("running ".length + 48);
  expect(out.endsWith("…")).toBe(true);
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

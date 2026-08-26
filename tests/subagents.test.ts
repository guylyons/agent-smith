import { test, expect } from "bun:test";
import { deriveSubagent } from "../src/lib/subagents";

const L = (o: object) => JSON.stringify(o);

test("derives doing from the last tool_use and active from mtime (ignores sidechain flag)", () => {
  const lines = [
    L({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "thinking" }] } }),
    L({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/x/review.md" } }] } }),
  ];
  const s = deriveSubagent("abc", { agentType: "claude", description: "Perf review", model: "sonnet" }, lines, 1_000, 1_000 + 30_000);
  expect(s.description).toBe("Perf review");
  expect(s.model).toBe("sonnet");
  expect(s.doing).toBe("editing review.md");
  expect(s.active).toBe(true);
});

test("inactive with 'done' when the transcript is old and had no tool", () => {
  const s = deriveSubagent("abc", {}, [L({ type: "assistant", message: { content: [{ type: "text", text: "wrote up findings" }] } })], 0, 300_000);
  expect(s.active).toBe(false);
  expect(s.doing).toBe("done");
  expect(s.description).toBe("subagent"); // fallback
  expect(s.agentType).toBe("claude");     // fallback
});
